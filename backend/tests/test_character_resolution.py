import logging
from pathlib import Path

import httpx
import pytest

from app.config import DEFAULT_CHARACTER_ID, Settings
from app.main import create_app
from app.services.character_service import (
    is_valid_character_id,
    load_character_layers,
    resolve_character,
)

BUNDLED_DIRECTORY = Path(__file__).resolve().parents[2] / "characters" / DEFAULT_CHARACTER_ID


def write_profile(directory: Path, name: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "character.json").write_text(
        f'{{"name":"{name}","profile":"test"}}', encoding="utf-8"
    )
    return directory


def test_character_id_defaults_to_remora(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("REMORISE_CHARACTER_ID", raising=False)
    settings = Settings(remorise_data_dir=tmp_path)
    assert DEFAULT_CHARACTER_ID == "remora"
    assert settings.remorise_character_id == "remora"


def test_character_id_env_override(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("REMORISE_CHARACTER_ID", "sample")
    assert Settings(remorise_data_dir=tmp_path).remorise_character_id == "sample"


def test_is_valid_character_id() -> None:
    assert is_valid_character_id("remora")
    assert is_valid_character_id("my-char_2")
    assert not is_valid_character_id("")
    assert not is_valid_character_id(".")
    assert not is_valid_character_id("..")
    assert not is_valid_character_id("../remora")
    assert not is_valid_character_id("a/b")
    assert not is_valid_character_id("a\\b")


def test_resolve_character_loads_the_requested_id(tmp_path) -> None:
    data_directory = tmp_path / "data"
    sample = write_profile(data_directory / "characters" / "sample", "Sample")
    write_profile(data_directory / "characters" / "remora", "Data Remora")
    character, directory, resolved = resolve_character(data_directory, BUNDLED_DIRECTORY, "sample")
    assert character.name == "Sample"
    assert directory == sample
    assert resolved == "sample"


def test_resolve_character_reads_theme_hue(tmp_path) -> None:
    data_directory = tmp_path / "data"
    sample = data_directory / "characters" / "sample"
    sample.mkdir(parents=True)
    (sample / "character.json").write_text('{"name":"Sample","theme_hue":200}', encoding="utf-8")
    character, _, _ = resolve_character(data_directory, BUNDLED_DIRECTORY, "sample")
    assert character.theme_hue == 200


def test_resolve_character_with_out_of_range_theme_hue_falls_back(tmp_path) -> None:
    data_directory = tmp_path / "data"
    sample = data_directory / "characters" / "sample"
    sample.mkdir(parents=True)
    (sample / "character.json").write_text('{"name":"Sample","theme_hue":400}', encoding="utf-8")
    write_profile(data_directory / "characters" / "remora", "Data Remora")
    character, _, resolved = resolve_character(data_directory, BUNDLED_DIRECTORY, "sample")
    assert character.name == "Data Remora"
    assert resolved == "remora"


def test_resolve_character_unknown_id_falls_back_to_data_remora(tmp_path, caplog) -> None:
    data_directory = tmp_path / "data"
    remora = write_profile(data_directory / "characters" / "remora", "Data Remora")
    with caplog.at_level(logging.ERROR, logger="app.services.character_service"):
        character, directory, resolved = resolve_character(
            data_directory, BUNDLED_DIRECTORY, "missing"
        )
    assert character.name == "Data Remora"
    assert directory == remora
    assert resolved == "remora"
    assert any("falling back" in record.message for record in caplog.records)


def test_resolve_character_without_a_data_remora_uses_the_bundled_copy(
    tmp_path,
) -> None:
    character, directory, resolved = resolve_character(
        tmp_path / "data", BUNDLED_DIRECTORY, "remora"
    )
    assert character.name == "レモラ"
    assert directory == BUNDLED_DIRECTORY
    assert resolved == "remora"


def test_resolve_character_path_like_id_falls_back(tmp_path) -> None:
    data_directory = tmp_path / "data"
    write_profile(data_directory / "characters" / "remora", "Data Remora")
    _character, _directory, resolved = resolve_character(
        data_directory, BUNDLED_DIRECTORY, "../remora"
    )
    assert resolved == "remora"


def test_resolve_character_invalid_requested_profile_falls_back(tmp_path) -> None:
    data_directory = tmp_path / "data"
    broken = data_directory / "characters" / "sample"
    broken.mkdir(parents=True)
    (broken / "character.json").write_text("{not json", encoding="utf-8")
    write_profile(data_directory / "characters" / "remora", "Data Remora")
    character, _directory, resolved = resolve_character(data_directory, BUNDLED_DIRECTORY, "sample")
    assert character.name == "Data Remora"
    assert resolved == "remora"


def test_effective_database_url_is_per_character(tmp_path) -> None:
    settings = Settings(remorise_data_dir=tmp_path)
    url = settings.effective_database_url("sample")
    expected = (tmp_path / "characters" / "sample" / "remorise.db").as_posix()
    assert url.endswith(expected)


def test_effective_database_url_explicit_value_wins(tmp_path) -> None:
    settings = Settings(
        remorise_data_dir=tmp_path, database_url="sqlite+aiosqlite:////elsewhere.db"
    )
    assert settings.effective_database_url("sample") == "sqlite+aiosqlite:////elsewhere.db"


@pytest.mark.asyncio
async def test_app_runs_the_selected_character_with_its_own_database(
    tmp_path: Path,
) -> None:
    data_directory = tmp_path / "data"
    write_profile(data_directory / "characters" / "sample", "Sample")
    (data_directory / "characters" / "sample" / "layers.json").write_text(
        '{"image":{"width":1024,"height":1536},"emotions":{}}', encoding="utf-8"
    )
    app = create_app(Settings(remorise_data_dir=data_directory, remorise_character_id="sample"))
    async with app.router.lifespan_context(app):
        assert (data_directory / "characters" / "sample" / "remorise.db").is_file()
        assert not (data_directory / "characters" / "remora" / "remorise.db").exists()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            profile = await client.get("/api/character")
            assert profile.json()["name"] == "Sample"
            terms = await client.get("/api/character/terms")
            assert terms.json() == {"available": False, "markdown": ""}


@pytest.mark.asyncio
async def test_app_serves_the_character_terms_from_its_folder(
    tmp_path: Path,
) -> None:
    data_directory = tmp_path / "data"
    write_profile(data_directory / "characters" / "sample", "Sample")
    (data_directory / "characters" / "sample" / "terms.md").write_text(
        "# Sample 利用規約\n\nサンプルの規約です。\n", encoding="utf-8"
    )
    app = create_app(Settings(remorise_data_dir=data_directory, remorise_character_id="sample"))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            terms = await client.get("/api/character/terms")
            assert terms.json()["available"] is True
            assert "サンプルの規約です" in terms.json()["markdown"]


@pytest.mark.asyncio
async def test_app_with_an_unknown_character_falls_back_to_remora(
    tmp_path: Path,
) -> None:
    data_directory = tmp_path / "data"
    app = create_app(Settings(remorise_data_dir=data_directory, remorise_character_id="missing"))
    async with app.router.lifespan_context(app):
        assert (data_directory / "characters" / "remora" / "remorise.db").is_file()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            profile = await client.get("/api/character")
            assert profile.json()["name"] == "レモラ"
            terms = await client.get("/api/character/terms")
            assert terms.json()["available"] is True
            assert "レモラ利用規約" in terms.json()["markdown"]


def test_load_character_layers_reads_the_resolved_folder(tmp_path) -> None:
    directory = tmp_path / "sample"
    directory.mkdir()
    (directory / "layers.json").write_text('{"image": {"width": 1}}', encoding="utf-8")
    assert load_character_layers(directory) == {"image": {"width": 1}}


def test_load_character_layers_without_a_file_has_no_sprite(tmp_path) -> None:
    directory = tmp_path / "sample"
    directory.mkdir()
    assert load_character_layers(directory) == {}


def test_load_character_layers_with_invalid_json_has_no_sprite(tmp_path) -> None:
    directory = tmp_path / "sample"
    directory.mkdir()
    (directory / "layers.json").write_text("not json", encoding="utf-8")
    assert load_character_layers(directory) == {}
