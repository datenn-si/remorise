import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.config import Settings
from app.main import create_app


def make_app(tmp_path: Path, **overrides: Any):
    return create_app(
        Settings(
            database_url=f"sqlite+aiosqlite:///{tmp_path}/test.db",
            remorise_data_dir=tmp_path / "data",
            remorise_character_id="sample",
            **overrides,
        )
    )


def write_character(
    data_directory: Path,
    layers: dict[str, Any] | None,
    images: dict[str, bytes] | None = None,
) -> Path:
    character_directory = data_directory / "characters" / "sample"
    layers_directory = character_directory / "layers"
    layers_directory.mkdir(parents=True)
    (character_directory / "character.json").write_text(
        '{"name":"Sprite Test","profile":"test"}', encoding="utf-8"
    )
    if layers is not None:
        (character_directory / "layers.json").write_text(json.dumps(layers), encoding="utf-8")
    for relative, content in (images or {}).items():
        path = layers_directory / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    return character_directory


@pytest.mark.asyncio
async def test_sprite_motion_settings_are_operational(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            body = (await client.get("/api/settings")).json()
            assert body["sprite_motion_enabled"] is True
            assert body["sprite_motion_amplitude"] == 1.0
            assert body["sprite_motion_speed"] == 1.0
            assert body["sprite_motion_overscan"] == 1.06

            updated = await client.patch(
                "/api/settings",
                json={"sprite_motion_amplitude": 0.5, "sprite_motion_enabled": False},
            )
            assert updated.status_code == 200
            assert updated.json()["sprite_motion_amplitude"] == 0.5
            assert updated.json()["sprite_motion_enabled"] is False
            assert "sprite_motion_amplitude" in updated.json()["overridden"]
            assert app.state.settings.sprite_motion_amplitude == 0.5
            assert app.state.settings.sprite_motion_enabled is False

            rejected = await client.patch("/api/settings", json={"sprite_motion_speed": 99})
            assert rejected.status_code == 422
            assert app.state.settings.sprite_motion_speed == 1.0


@pytest.mark.asyncio
async def test_layers_report_unavailable_without_any_real_image(
    tmp_path: Path,
) -> None:
    write_character(
        tmp_path / "data",
        {"image": {"width": 64, "height": 96}, "emotions": {}},
    )
    app = make_app(tmp_path)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            layers = await client.get("/api/character/layers")
            assert layers.status_code == 200
            assert layers.json()["available"] is False


@pytest.mark.asyncio
async def test_layers_report_unavailable_when_referenced_images_are_missing(
    tmp_path: Path,
) -> None:
    data_directory = tmp_path / "data"
    write_character(
        data_directory,
        {
            "image": {"width": 64, "height": 96},
            "paint": ["pose"],
            "poses": {"arms-down": ["body.png"]},
            "expressions": {},
            "eyes": [],
            "tears": [],
            "extras": {},
            "marks": {},
            "emotions": {},
        },
    )
    app = make_app(tmp_path)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            layers = await client.get("/api/character/layers")
            assert layers.json()["available"] is False


@pytest.mark.asyncio
async def test_layers_report_available_when_a_referenced_image_exists(
    tmp_path: Path,
) -> None:
    data_directory = tmp_path / "data"
    write_character(
        data_directory,
        {
            "image": {"width": 64, "height": 96},
            "paint": ["pose"],
            "poses": {"arms-down": ["body.png", "missing.png"]},
            "expressions": {},
            "eyes": [],
            "tears": [],
            "extras": {},
            "marks": {},
            "emotions": {},
        },
        images={"body.png": b"\x89PNG\r\n\x1a\n"},
    )
    app = make_app(tmp_path)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            layers = await client.get("/api/character/layers")
            assert layers.json()["available"] is True
            served = await client.get("/api/character/assets/body.png")
            assert served.status_code == 200


@pytest.mark.asyncio
async def test_layers_directory_serves_sprites(tmp_path: Path) -> None:
    data_directory = tmp_path / "data"
    character_directory = data_directory / "characters" / "sample"
    layers_directory = character_directory / "layers"
    layers_directory.mkdir(parents=True)
    (character_directory / "character.json").write_text(
        '{"name":"Sprite Test","profile":"test"}', encoding="utf-8"
    )
    (character_directory / "layers.json").write_text(
        json.dumps(
            {
                "image": {"width": 64, "height": 96},
                "paint": ["pose"],
                "poses": {"arms-down": {"label": "腕を下ろす", "layers": ["body.png"]}},
                "expressions": {},
                "eyes": [],
                "tears": [],
                "extras": {},
                "marks": {},
                "emotions": {},
            }
        ),
        encoding="utf-8",
    )
    (layers_directory / "body.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    app = make_app(tmp_path)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            layers = await client.get("/api/character/layers")
            assert layers.json()["available"] is True
            assert layers.json()["poses"]["arms-down"]["label"] == "腕を下ろす"
            served = await client.get("/api/character/assets/body.png")
            assert served.status_code == 200


@pytest.mark.asyncio
async def test_images_directory_is_not_used_for_sprite_assets(tmp_path: Path) -> None:
    data_directory = tmp_path / "data"
    character_directory = write_character(
        data_directory,
        {
            "image": {"width": 64, "height": 96},
            "paint": ["pose"],
            "poses": {"arms-down": ["body.png"]},
        },
    )
    (character_directory / "layers").rmdir()
    legacy_images = character_directory / "images"
    legacy_images.mkdir()
    (legacy_images / "body.png").write_bytes(b"not a sprite")
    app = make_app(tmp_path)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            layers = await client.get("/api/character/layers")
            assert layers.json()["available"] is False
            served = await client.get("/api/character/assets/body.png")
            assert served.status_code == 404
