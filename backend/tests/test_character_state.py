from pathlib import Path

import httpx
import pytest
from sqlalchemy import select

from app.config import Settings
from app.database.models import StateHistory
from app.main import create_app


@pytest.mark.asyncio
async def test_state_api_validates_and_records_manual_updates(tmp_path: Path) -> None:
    app = create_app(
        Settings(
            database_url=f"sqlite+aiosqlite:///{tmp_path / 'state.db'}",
            remorise_data_dir=tmp_path / "data",
        )
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            initial = await client.get("/api/character/state")
            assert initial.json()["affinity"] == 50
            updated = await client.patch(
                "/api/character/state", json={"emotion": "happy", "intensity": 0.8}
            )
            assert updated.status_code == 200
            assert updated.json()["emotion"] == "happy"
            assert (
                await client.patch("/api/character/state", json={"intensity": 2})
            ).status_code == 422
            async with app.state.session_factory() as session:
                histories = (await session.scalars(select(StateHistory))).all()
                assert len(histories) == 1
                assert histories[0].reason == "manual update"


@pytest.mark.asyncio
async def test_empty_data_directory_uses_default_character_and_asset_fallback(
    tmp_path: Path,
) -> None:
    data_directory = tmp_path / "empty-data"
    app = create_app(Settings(remorise_data_dir=data_directory))
    async with app.router.lifespan_context(app):
        assert (data_directory / "characters" / "remora" / "remorise.db").is_file()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            profile = await client.get("/api/character")
            layers = await client.get("/api/character/layers")
            missing_asset = await client.get("/api/character/assets/missing.png")
            assert profile.json()["name"] == "レモラ"
            assert layers.json()["root"] == "/api/character/assets"
            assert layers.json()["emotions"]
            assert missing_asset.status_code == 404


@pytest.mark.asyncio
async def test_data_character_profile_and_assets_take_precedence(tmp_path: Path) -> None:
    data_directory = tmp_path / "data"
    character_directory = data_directory / "characters" / "sample"
    images = character_directory / "layers"
    images.mkdir(parents=True)
    (character_directory / "character.json").write_text(
        '{"name":"External Test","profile":"test"}', encoding="utf-8"
    )
    (character_directory / "layers.json").write_text(
        '{"image":{"width":1024,"height":1536},"emotions":{}}', encoding="utf-8"
    )
    (images / "sample.png").write_bytes(b"asset fixture")
    app = create_app(Settings(remorise_data_dir=data_directory, remorise_character_id="sample"))

    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            profile = await client.get("/api/character")
            layers = await client.get("/api/character/layers")
            asset = await client.get("/api/character/assets/sample.png")
            assert profile.json()["name"] == "External Test"
            assert layers.json()["root"] == "/api/character/assets"
            assert asset.content == b"asset fixture"
            assert asset.headers["cache-control"] == "no-cache"
            revalidated = await client.get(
                "/api/character/assets/sample.png",
                headers={"If-None-Match": asset.headers["etag"]},
            )
            assert revalidated.status_code == 304
            assert revalidated.content == b""
