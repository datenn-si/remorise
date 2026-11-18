import json
import logging
from pathlib import Path

from pydantic import ValidationError

from app.config import DEFAULT_CHARACTER_ID
from app.schemas.character import CharacterConfig

logger = logging.getLogger(__name__)


def load_character(path: str | Path) -> CharacterConfig:
    character_path = Path(path)
    data = json.loads(character_path.read_text(encoding="utf-8"))
    return CharacterConfig.model_validate(data)


def is_valid_character_id(character_id: str) -> bool:
    """Whether the id can name a character folder.

    The id is a single folder name: empty names, path separators
    and parent references are rejected, so a configured id can
    never resolve outside the characters folder.
    """
    return (
        bool(character_id)
        and character_id not in (".", "..")
        and "/" not in character_id
        and "\\" not in character_id
        and "\x00" not in character_id
    )


def resolve_character(
    data_directory: Path, bundled_directory: Path, character_id: str
) -> tuple[CharacterConfig, Path, str]:
    """Resolve the one character this server runs.

    The requested id names a folder under the data directory's
    characters/ folder. An unavailable selection (unknown id,
    missing or invalid profile) is an error: it is logged as one
    and the run falls back to the default character, whose own
    data folder wins over the bundled copy when it has a loadable
    profile. Only the bundled default failing to load is fatal.
    Returns the profile, the directory it was loaded from, and the
    resolved id.
    """
    if character_id != DEFAULT_CHARACTER_ID:
        directory = data_directory / "characters" / character_id
        if is_valid_character_id(character_id):
            try:
                return load_character(directory / "character.json"), directory, character_id
            except (OSError, ValueError, ValidationError):
                pass
        logger.error(
            "Character '%s' is not available at %s; falling back to '%s'",
            character_id,
            directory,
            DEFAULT_CHARACTER_ID,
        )
    directory = data_directory / "characters" / DEFAULT_CHARACTER_ID
    try:
        return load_character(directory / "character.json"), directory, DEFAULT_CHARACTER_ID
    except (OSError, ValueError, ValidationError):
        return (
            load_character(bundled_directory / "character.json"),
            bundled_directory,
            DEFAULT_CHARACTER_ID,
        )


def resolve_character_asset_directory(character_directory: Path) -> Path:
    return character_directory / "layers"


TERMS_FILE_NAME = "terms.md"


def load_character_terms(character_directory: Path) -> str | None:
    """The character's terms of use, when its folder carries one.

    The file is the character author's own document, distributed
    with the character; the app only displays it. Characters
    without the file have no terms.
    """
    try:
        return (character_directory / TERMS_FILE_NAME).read_text(encoding="utf-8")
    except OSError:
        return None


def load_character_layers(character_directory: Path) -> dict[str, object]:
    """The resolved character folder's layers definition.

    Only the resolved folder is read: there is no per-file fallback
    to the bundled character, so a folder without a usable
    layers.json simply has no sprite (an empty definition).
    """
    path = character_directory / "layers.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        logger.warning("Ignoring unusable layers.json at %s", path)
        return {}
    if isinstance(data, dict):
        return data
    logger.warning("Ignoring unusable layers.json at %s", path)
    return {}


def referenced_image_paths(layers: dict[str, object]) -> set[str]:
    """Every image path a layers definition points at.

    Mirrors the frontend's collection rule: any string value ending in
    ``.png`` anywhere in the definition, including the ``path`` member
    of a parts-format offset entry (``{"path": ..., "x": ..., "y": ...}``).
    """
    paths: set[str] = set()

    def collect(value: object) -> None:
        if isinstance(value, str):
            if value.endswith(".png"):
                paths.add(value)
            return
        if isinstance(value, list):
            for item in value:
                collect(item)
            return
        if isinstance(value, dict):
            for item in value.values():
                collect(item)

    collect(layers)
    return paths


def sprite_available(layers: dict[str, object], asset_directory: Path) -> bool:
    """Whether the character actually has a standing sprite.

    A character whose layers definition references no images at all
    (the bundled default) or whose referenced images are all absent
    has no sprite: the chat shows no sprite area and the sprite debug
    page is closed for it. A single existing image is enough; missing
    siblings are simply not drawn.
    """
    return any(
        (asset_directory / relative).is_file() for relative in referenced_image_paths(layers)
    )
