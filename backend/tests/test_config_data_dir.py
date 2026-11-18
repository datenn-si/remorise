"""The default data directory (documents folder, no migration).

User data used to default to a platform application-data folder
(%LOCALAPPDATA% on Windows, ~/.local/share elsewhere). The default
is now the Remorise folder inside the user's documents folder, so
the data sits where the user can see and back it up. There is no
migration: REMORISE_DATA_DIR still overrides the default, and a
server started without it simply begins empty at the new location.
"""

import os
from pathlib import Path

from app.config import Settings, default_data_directory, documents_directory


def test_default_data_directory_is_the_documents_remorise_folder() -> None:
    assert default_data_directory() == documents_directory() / "Remorise"
    assert default_data_directory().name == "Remorise"


def test_documents_directory_is_home_documents_off_windows() -> None:
    if os.name == "nt":
        return
    assert documents_directory() == Path.home() / "Documents"


def test_data_dir_env_override_still_wins(monkeypatch, tmp_path) -> None:
    custom = tmp_path / "custom-data"
    monkeypatch.setenv("REMORISE_DATA_DIR", str(custom))
    assert Settings().remorise_data_dir == custom.resolve()
