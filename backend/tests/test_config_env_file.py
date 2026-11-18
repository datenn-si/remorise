"""Which env file the backend reads.

The backend always reads .env, in development and in production
alike; there is no separate production env file. (An earlier design
let prod.py point REMORISE_ENV_FILE at backend/.env.production; the
variable no longer selects anything.) The instance records the file
it was configured from so startup can log exactly which file was
read.
"""

from pathlib import Path

from app.config import Settings, env_file_path


def test_env_file_is_dot_env(monkeypatch):
    monkeypatch.delenv("REMORISE_ENV_FILE", raising=False)
    assert env_file_path() == Path(".env")
    assert Settings().env_file == Path(".env")


def test_a_leftover_launcher_variable_no_longer_selects_a_file(monkeypatch, tmp_path):
    selected = tmp_path / ".env.production"
    monkeypatch.setenv("REMORISE_ENV_FILE", str(selected))
    assert env_file_path() == Path(".env")
    assert Settings().env_file == Path(".env")
