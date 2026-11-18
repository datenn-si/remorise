from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import Settings
from app.database.models import Memory, Message
from app.database.session import create_engine, initialize_database
from app.main import create_app
from app.services import job_service


async def seed_database(tmp_path: Path, name: str = "debug.db") -> None:
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / name}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)
    async with factory() as session:
        rows = [
            Message(role="user", content="一言目"),
            Message(role="assistant", content="返答"),
            Message(role="user", content="二言目"),
        ]
        session.add_all(rows)
        await session.commit()
        await job_service.enqueue_job(
            session, job_service.JOB_SUMMARY, rows[0].id, rows[1].id, epoch=1
        )
    await engine.dispose()


def seeded_app(tmp_path: Path, name: str = "debug.db"):
    return create_app(Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / name}"))


@pytest.mark.asyncio
async def test_debug_pipeline_reports_the_summary_only_shape(tmp_path: Path) -> None:
    await seed_database(tmp_path)
    app = seeded_app(tmp_path)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/debug/pipeline")
            assert response.status_code == 200
            assert response.json() == {
                "epoch": 1,
                "summarized_until_message_id": None,
                "unsummarized_messages": 3,
                "pending_jobs": 1,
                "running_jobs": 0,
            }

            jobs = (await client.get("/api/debug/jobs")).json()
            assert len(jobs) == 1
            assert jobs[0]["kind"] == "summary"
            assert jobs[0]["result"] is None


@pytest.mark.asyncio
async def test_debug_surfaces_are_read_only(tmp_path: Path) -> None:
    await seed_database(tmp_path)
    app = seeded_app(tmp_path)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            # Removed debug write endpoints must stay gone.
            for method, url in [
                ("POST", "/api/debug/memories/1/pin"),
                ("POST", "/api/debug/memories/1/forget"),
                ("POST", "/api/debug/memories/1/reactivate"),
                ("GET", "/api/debug/forgetting"),
                ("PATCH", "/api/debug/forgetting"),
                ("GET", "/api/debug/settings"),
                ("PATCH", "/api/debug/settings"),
            ]:
                response = await client.request(method, url, json={})
                assert response.status_code in (404, 405), (method, url, response.status_code)
            assert (await client.post("/api/memories", json={})).status_code == 405
            assert (await client.patch("/api/memories/1", json={})).status_code == 405
            assert (await client.delete("/api/memories/1")).status_code == 405
            assert (await client.get("/api/memories/1/versions")).status_code == 404


@pytest.mark.asyncio
async def test_debug_history_and_purge_still_work(tmp_path: Path) -> None:
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / 'purge.db'}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)
    async with factory() as session:
        rows = [
            Message(role="user", content="残る発言"),
            Message(role="assistant", content="消える返答", archived_at=None),
        ]
        session.add_all(rows)
        await session.commit()
        archived_id = rows[1].id
        from datetime import UTC, datetime

        rows[1].archived_at = datetime.now(UTC)
        await session.commit()
    await engine.dispose()

    app = create_app(Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'purge.db'}"))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            history = (await client.get("/api/debug/history")).json()
            assert len(history["messages"]) == 2
            purged = await client.request(
                "DELETE",
                "/api/debug/history/purge",
                params={"through_message_id": archived_id},
            )
            assert purged.status_code == 200
            history = (await client.get("/api/debug/history")).json()
            assert [row["content"] for row in history["messages"]] == ["残る発言"]


@pytest.mark.asyncio
async def test_debug_memories_pages_with_limit_and_offset(tmp_path: Path) -> None:
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / 'debug.db'}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)
    base = datetime(2026, 1, 1, tzinfo=UTC)
    async with factory() as session:
        session.add_all(
            [
                Memory(
                    content=f"記憶{i}",
                    category="event",
                    last_reinforced_at=base + timedelta(days=i),
                )
                for i in range(3)
            ]
        )
        await session.commit()
    await engine.dispose()

    app = seeded_app(tmp_path)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            first_page = (await client.get("/api/debug/memories", params={"limit": 2})).json()
            assert [row["content"] for row in first_page] == ["記憶2", "記憶1"]
            second_page = (
                await client.get("/api/debug/memories", params={"limit": 2, "offset": 2})
            ).json()
            assert [row["content"] for row in second_page] == ["記憶0"]
