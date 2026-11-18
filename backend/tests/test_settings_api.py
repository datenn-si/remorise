from collections.abc import AsyncIterator
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from sqlalchemy import inspect, select

from app.api.chat import start_completion
from app.config import Settings
from app.database.models import AppSetting, Message, utc_now
from app.database.session import create_engine, initialize_database
from app.main import create_app
from app.services import job_service


def make_app(tmp_path: Path, **overrides: Any):
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'test.db'}"
    return create_app(Settings(database_url=database_url, **overrides))


async def client_for(app: Any) -> AsyncIterator[httpx.AsyncClient]:
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            yield client


@pytest.mark.asyncio
async def test_operational_settings_default_to_env_values(tmp_path: Path) -> None:
    app = make_app(tmp_path, llm_temperature=0.4)
    async for client in client_for(app):
        response = await client.get("/api/settings")
        assert response.status_code == 200
        body = response.json()
        assert body["llm_temperature"] == 0.4
        assert body["llm_max_tokens"] == 2048
        assert body["memory_agent_max_calls"] == 8
        assert body["sprite_motion_overscan"] == 1.06
        assert body["archive_retention_days"] == 0
        assert body["raw_log_retention_days"] == 30
        assert body["memory_half_life_event_days"] == 30.0
        assert body["memory_half_life_state_days"] == 365.0
        assert body["overridden"] == []
        assert body["base_values"]["llm_temperature"] == 0.4
        assert body["base_values"]["llm_max_tokens"] == 2048
        readonly = body["readonly"]
        assert readonly["llm_base_url"] == "http://127.0.0.1:9931/v1"
        assert readonly["llm_model"] == app.state.settings.llm_model
        assert isinstance(readonly["llm_api_key_configured"], bool)
        assert "llm_api_key" not in readonly
        assert isinstance(readonly["remorise_data_dir"], str)
        # Base-layer and removed fields must stay out of this API.
        assert "llm_model" not in body
        assert "memory_extract_batch_turns" not in body
        assert "sprite_motion_parallax" not in body


@pytest.mark.asyncio
async def test_patch_applies_immediately_and_db_wins_over_env(tmp_path: Path) -> None:
    app = make_app(tmp_path, llm_temperature=0.3)
    async for client in client_for(app):
        updated = await client.patch(
            "/api/settings", json={"llm_temperature": 0.9, "memory_agent_max_calls": 3}
        )
        assert updated.status_code == 200
        body = updated.json()
        assert body["llm_temperature"] == 0.9
        assert body["memory_agent_max_calls"] == 3
        assert body["overridden"] == ["llm_temperature", "memory_agent_max_calls"]
        assert body["base_values"]["llm_temperature"] == 0.3
        assert body["base_values"]["memory_agent_max_calls"] == 8
        assert app.state.settings.llm_temperature == 0.9
        assert app.state.settings.memory_agent_max_calls == 3

    restarted = make_app(tmp_path, llm_temperature=0.3)
    async for client in client_for(restarted):
        body = (await client.get("/api/settings")).json()
        assert body["llm_temperature"] == 0.9
        assert restarted.state.settings.llm_temperature == 0.9


@pytest.mark.asyncio
async def test_llm_timeout_defaults_and_patch_reaches_the_client(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    async for client in client_for(app):
        body = (await client.get("/api/settings")).json()
        assert body["llm_timeout_seconds"] == 300.0
        assert app.state.llm_client.timeout == 300.0
        updated = await client.patch("/api/settings", json={"llm_timeout_seconds": 42})
        assert updated.status_code == 200
        assert updated.json()["llm_timeout_seconds"] == 42.0
        # The client is built once at startup; the new timeout is
        # pushed onto it so the change applies without a restart.
        assert app.state.llm_client.timeout == 42.0
        reset = await client.patch("/api/settings", json={"llm_timeout_seconds": None})
        assert reset.json()["llm_timeout_seconds"] == 300.0
        assert app.state.llm_client.timeout == 300.0


@pytest.mark.asyncio
async def test_patch_rejects_invalid_values_without_persisting(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    async for client in client_for(app):
        out_of_range = await client.patch("/api/settings", json={"llm_temperature": 2.5})
        assert out_of_range.status_code == 422
        wrong_type = await client.patch("/api/settings", json={"llm_context_size": "big"})
        assert wrong_type.status_code == 422
        inconsistent = await client.patch("/api/settings", json={"context_target_ratio": 0.8})
        assert inconsistent.status_code == 422

        body = (await client.get("/api/settings")).json()
        assert body["llm_temperature"] is None
        assert body["context_target_ratio"] == 0.55
        assert body["overridden"] == []
    async with app.state.session_factory() as session:
        rows = (await session.scalars(select(AppSetting))).all()
        assert rows == []


@pytest.mark.asyncio
async def test_patch_rejects_fields_outside_the_operational_layer(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    async for client in client_for(app):
        base_field = await client.patch("/api/settings", json={"llm_model": "other"})
        assert base_field.status_code == 422
        removed_field = await client.patch("/api/settings", json={"sprite_motion_parallax": 1.0})
        assert removed_field.status_code == 422
        unknown = await client.patch("/api/settings", json={"nope": 1})
        assert unknown.status_code == 422


@pytest.mark.asyncio
async def test_null_resets_a_field_to_its_env_value(tmp_path: Path) -> None:
    app = make_app(tmp_path, memory_handover_limit=7)
    async for client in client_for(app):
        await client.patch("/api/settings", json={"memory_handover_limit": 42})
        assert app.state.settings.memory_handover_limit == 42
        reset = await client.patch("/api/settings", json={"memory_handover_limit": None})
        assert reset.status_code == 200
        assert reset.json()["memory_handover_limit"] == 7
        assert reset.json()["overridden"] == []
        assert app.state.settings.memory_handover_limit == 7


class CapturingCompletions:
    def __init__(self) -> None:
        self.kwargs: dict[str, Any] = {}

    async def create(self, **kwargs: Any) -> SimpleNamespace:
        self.kwargs = kwargs
        return SimpleNamespace()


@pytest.mark.asyncio
async def test_sampling_change_affects_generation_without_restart(
    tmp_path: Path,
) -> None:
    app = make_app(tmp_path)
    async for client in client_for(app):
        await client.patch("/api/settings", json={"llm_temperature": 0.7})
    completions = CapturingCompletions()
    fake = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    await start_completion(fake, app.state.settings, [{"role": "user", "content": "hi"}])
    assert completions.kwargs["temperature"] == 0.7
    assert "tools" not in completions.kwargs


@pytest.mark.asyncio
async def test_lifecycle_settings_round_trip_through_settings(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    async for client in client_for(app):
        updated = await client.patch(
            "/api/settings",
            json={
                "archive_retention_days": 14,
                "memory_decay_threshold": 0.35,
                "memory_half_life_event_days": 12,
            },
        )
        assert updated.status_code == 200
        body = updated.json()
        assert body["archive_retention_days"] == 14
        assert body["memory_decay_threshold"] == 0.35
        assert body["memory_half_life_event_days"] == 12.0
        assert app.state.settings.archive_retention_days == 14
        assert app.state.settings.memory_decay_threshold == 0.35
        invalid = await client.patch("/api/settings", json={"archive_retention_days": -1})
        assert invalid.status_code == 422
        # These settings' old debug homes must stay gone.
        assert (await client.get("/api/debug/settings")).status_code == 404
        assert (await client.get("/api/debug/forgetting")).status_code == 404

    restarted = make_app(tmp_path)
    async for client in client_for(restarted):
        body = (await client.get("/api/settings")).json()
        assert body["memory_decay_threshold"] == 0.35
        assert body["memory_half_life_event_days"] == 12.0
        assert restarted.state.settings.memory_half_life_event_days == 12.0


@pytest.mark.asyncio
async def test_archive_retention_change_drives_purge_behavior(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    async for client in client_for(app):
        async with app.state.session_factory() as session:
            old = Message(
                conversation_id=1,
                role="user",
                content="old",
                archived_at=utc_now() - timedelta(days=40),
            )
            session.add(old)
            await session.commit()
            assert await job_service.purge_expired_archives(session, app.state.settings) == (0, 0)
        await client.patch("/api/settings", json={"archive_retention_days": 30})
        async with app.state.session_factory() as session:
            assert await job_service.purge_expired_archives(session, app.state.settings) == (1, 0)


@pytest.mark.asyncio
async def test_baseline_schema_creates_app_settings_without_migrations(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "fresh.db"
    engine = create_engine(f"sqlite+aiosqlite:///{db_path}")
    from sqlalchemy.ext.asyncio import async_sessionmaker

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, session_factory)
    async with engine.connect() as connection:
        tables = await connection.run_sync(
            lambda sync_connection: set(inspect(sync_connection).get_table_names())
        )
    assert "app_settings" in tables
    assert "message_memory_links" in tables
    assert "schema_migrations" not in tables
    await engine.dispose()
