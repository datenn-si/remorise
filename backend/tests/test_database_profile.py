"""Database profiles: an optional name selecting remorise.<profile>.db.

A profile is chosen through REMORISE_PROFILE (or the launchers'
--profile) and only changes which database file inside the
character's folder the backend opens: no profile (or a blank one)
is the plain remorise.db. Names are half-width alphanumerics and
become part of the file name with upper-case letters folded to
lower case (Windows file names do not distinguish case, so Shot
and shot would be the same file there); anything else is rejected
when settings are built, so a typo can never silently land on the
wrong database. An explicit DATABASE_URL still wins over any
profile.
"""

import pytest
from pydantic import ValidationError

from app.config import Settings, database_file_name, is_valid_profile_name


def test_profile_defaults_to_none(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("REMORISE_PROFILE", raising=False)
    settings = Settings(remorise_data_dir=tmp_path)
    assert settings.remorise_profile == ""


def test_profile_env_override(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("REMORISE_PROFILE", "dev")
    assert Settings(remorise_data_dir=tmp_path).remorise_profile == "dev"


def test_profile_name_is_folded_to_lower_case(tmp_path) -> None:
    settings = Settings(remorise_data_dir=tmp_path, remorise_profile="Shot")
    assert settings.remorise_profile == "shot"


def test_is_valid_profile_name() -> None:
    assert is_valid_profile_name("dev")
    assert is_valid_profile_name("Dev2")
    assert is_valid_profile_name("2024")
    assert not is_valid_profile_name("")
    assert not is_valid_profile_name("a b")
    assert not is_valid_profile_name("a.b")
    assert not is_valid_profile_name("../x")
    assert not is_valid_profile_name("a/b")
    assert not is_valid_profile_name("プロファイル")


def test_database_file_name() -> None:
    assert database_file_name("") == "remorise.db"
    assert database_file_name("dev") == "remorise.dev.db"
    assert database_file_name("Dev") == "remorise.dev.db"


def test_database_path_without_profile(tmp_path) -> None:
    settings = Settings(remorise_data_dir=tmp_path)
    path = settings.database_path("remora")
    assert path == tmp_path / "characters" / "remora" / "remorise.db"


def test_database_path_with_profile_folds_the_case(tmp_path) -> None:
    settings = Settings(remorise_data_dir=tmp_path)
    path = settings.database_path("remora", "Shot")
    assert path == tmp_path / "characters" / "remora" / "remorise.shot.db"


def test_effective_database_url_uses_the_profile_file(tmp_path) -> None:
    settings = Settings(remorise_data_dir=tmp_path, remorise_profile="dev")
    url = settings.effective_database_url("remora", settings.remorise_profile)
    assert url.endswith("characters/remora/remorise.dev.db")


def test_database_url_wins_over_a_profile(tmp_path) -> None:
    settings = Settings(
        remorise_data_dir=tmp_path,
        remorise_profile="dev",
        database_url="sqlite+aiosqlite:////elsewhere/custom.db",
    )
    assert (
        settings.effective_database_url("remora", "dev")
        == "sqlite+aiosqlite:////elsewhere/custom.db"
    )


@pytest.mark.parametrize("bad", ["bad name", "a.b", "../x", "プロファイル"])
def test_invalid_profile_is_rejected(tmp_path, bad) -> None:
    with pytest.raises(ValidationError):
        Settings(remorise_data_dir=tmp_path, remorise_profile=bad)
