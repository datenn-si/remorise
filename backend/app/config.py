import os
import re
from pathlib import Path

from pydantic import Field, PrivateAttr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def env_file_path() -> Path:
    """Development and production share the one ``.env`` file,
    resolved against the backend working directory; there is no
    separate production env file.
    """
    return Path(".env")


def documents_directory() -> Path:
    """On Windows the documents folder is a known folder whose real
    location follows the user's configuration (it may be
    redirected, e.g. to OneDrive), so it is asked of the OS; the
    home-based path is the fallback when that lookup fails.
    Everywhere else it is ``Documents`` under the home directory.
    """
    if os.name == "nt":
        try:
            import ctypes
            from uuid import UUID

            folder_id_documents = ctypes.create_string_buffer(
                UUID("FDD39AD0-238F-46AF-ADB4-6C85480369C7").bytes_le, 16
            )
            result = ctypes.c_wchar_p()
            status = ctypes.windll.shell32.SHGetKnownFolderPath(
                folder_id_documents, 0, None, ctypes.byref(result)
            )
            if status == 0 and result.value:
                documents = Path(result.value)
                ctypes.windll.ole32.CoTaskMemFree(result)
                return documents
        except Exception:
            pass
    return Path.home() / "Documents"


def default_data_directory() -> Path:
    return documents_directory() / "Remorise"


# The character a server runs when nothing selects one, and the one
# an unavailable selection falls back to. The id is the character's
# folder name under the data directory's characters/ folder; the
# repository bundles this one character under characters/ with the
# same name.
DEFAULT_CHARACTER_ID = "remora"

_PROFILE_NAME_PATTERN = re.compile(r"[A-Za-z0-9]+")


def is_valid_profile_name(profile: str) -> bool:
    """Profile names are half-width alphanumerics: the name becomes
    part of the database file name, so anything else (spaces,
    dots, path separators, non-ASCII) is rejected instead of
    sanitized.
    """
    return _PROFILE_NAME_PATTERN.fullmatch(profile) is not None


def database_file_name(profile: str) -> str:
    """The name is folded to lower case: Windows file names do not
    distinguish case, so Shot and shot would be the same file
    there — folding keeps one spelling for one profile everywhere.
    """
    return "remorise.db" if not profile else f"remorise.{profile.lower()}.db"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(env_file_path()), env_file_encoding="utf-8", extra="ignore"
    )

    _env_file: Path = PrivateAttr(default_factory=env_file_path)

    @property
    def env_file(self) -> Path:
        return self._env_file

    # No defaults: the connection values belong to the user's LLM
    # server, so an unset one is a startup error rather than a
    # silent guess (see validate_llm_connection).
    llm_base_url: str = ""
    llm_api_key: str = ""
    llm_model: str = ""
    llm_max_tokens: int = Field(default=2048, gt=0)
    # Per-request timeout for every LLM call (seconds). For the
    # streaming generation this bounds the wait for the first token,
    # prompt processing included, so slow local hardware needs a
    # generous ceiling; it used to be a hardcoded 60 seconds in the
    # client factory, which long contexts outgrew.
    llm_timeout_seconds: float = Field(default=300.0, gt=0)
    # Sampling for the main generation. None (the default) omits the
    # parameter from the request entirely, so the llama.cpp server default
    # applies.
    llm_temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    llm_frequency_penalty: float | None = Field(default=None, ge=-2.0, le=2.0)
    llm_presence_penalty: float | None = Field(default=None, ge=-2.0, le=2.0)
    llm_repeat_penalty: float | None = Field(default=None, gt=0.0)
    remorise_data_dir: Path = Field(default_factory=default_data_directory)
    remorise_character_id: str = DEFAULT_CHARACTER_ID
    remorise_profile: str = ""
    database_url: str | None = None
    llm_context_size: int = Field(default=16384, gt=0)
    context_warning_ratio: float = Field(default=0.70, ge=0.0, le=1.0)
    context_summary_ratio: float = Field(default=0.75, ge=0.0, le=1.0)
    context_target_ratio: float = Field(default=0.55, ge=0.0, le=1.0)
    summary_protected_messages: int = Field(default=20, ge=0)
    raw_log_retention_days: int = Field(default=30, ge=0)
    job_max_attempts: int = Field(default=3, ge=1)
    job_poll_interval_seconds: float = Field(default=5.0, gt=0)
    archive_retention_days: int = Field(default=0, ge=0)
    # Memory forgetting. Retention score = (importance / 5) decayed with
    # the category half-life from the last reinforcement; a memory whose
    # score falls below the threshold is forgotten (deactivated, not
    # deleted). Categories are the two of the period model: events fade
    # on the scale of a month, states on the scale of a year, and the
    # importance factor carries the rest of the difference.
    memory_decay_enabled: bool = True
    memory_decay_threshold: float = Field(default=0.2, gt=0.0, le=1.0)
    memory_half_life_event_days: float = Field(default=30.0, gt=0)
    memory_half_life_state_days: float = Field(default=365.0, gt=0)
    # Each recall of a forgotten memory multiplies its half-life by this
    # factor (cumulative, capped), so repeatedly recalled facts fade slower.
    memory_reactivation_factor: float = Field(default=1.5, ge=1.0)
    memory_reactivation_max_multiplier: float = Field(default=10.0, ge=1.0)
    # Front-stage memory processing (stage A): one tool-calling session
    # with a total budget. When the budget runs out the turn proceeds
    # with whatever the session has already settled (fail-soft).
    memory_agent_max_calls: int = Field(default=8, ge=1, le=32)
    memory_agent_timeout_seconds: float = Field(default=60.0, gt=0)
    # Handover limits: how much of what stage A found may be passed on
    # to the emotion analysis and the reply generation. The search
    # itself is a fixed backend rule and is never narrowed by these;
    # they only bound the delivery side.
    memory_handover_limit: int = Field(default=5, ge=1, le=50)
    memory_handover_token_budget: int = Field(default=1500, ge=100)
    # The resident set (memories linked to not-yet-summarized messages)
    # keeps at most this many entries, most recently linked first.
    memory_resident_max_items: int = Field(default=20, ge=1, le=200)
    # Write-time similarity gate: a new memory whose content is at least
    # this similar to an existing row is treated as a match of that row
    # instead of being inserted (a forgotten row is restored).
    memory_similarity_threshold: float = Field(default=0.8, gt=0.0, le=1.0)
    emotion_half_life_minutes: int = Field(default=30, gt=0)
    affinity_min: int = Field(default=0, ge=0, le=200)
    affinity_max: int = Field(default=200, ge=0, le=200)
    affinity_delta_limit: int = Field(default=5, ge=0, le=5)
    # ``overscan`` is the fixed zoom that covers the motion's range
    # so the sprite's edges never detach from the display area while
    # it moves.
    sprite_motion_enabled: bool = True
    sprite_motion_amplitude: float = Field(default=1.0, ge=0.0, le=2.0)
    sprite_motion_speed: float = Field(default=1.0, gt=0.0, le=3.0)
    sprite_motion_overscan: float = Field(default=1.06, ge=1.0, le=1.5)

    @model_validator(mode="after")
    def validate_context_and_affinity_ranges(self) -> "Settings":
        self.remorise_data_dir = self.remorise_data_dir.expanduser().resolve()
        if self.context_warning_ratio > self.context_summary_ratio:
            raise ValueError("context_warning_ratio must not exceed context_summary_ratio")
        if self.context_target_ratio >= self.context_summary_ratio:
            raise ValueError("context_target_ratio must be below context_summary_ratio")
        if self.affinity_min > self.affinity_max:
            raise ValueError("affinity_min must not exceed affinity_max")
        return self

    @model_validator(mode="after")
    def validate_llm_connection(self) -> "Settings":
        for field_name in ("llm_base_url", "llm_api_key", "llm_model"):
            setattr(self, field_name, getattr(self, field_name).strip())
        if not self.llm_base_url:
            raise ValueError(
                "llm_base_url must be set: specify LLM_BASE_URL in .env (there is no default)"
            )
        if not self.llm_api_key:
            raise ValueError(
                "llm_api_key must be set: specify LLM_API_KEY in .env (there is no default)"
            )
        if not self.llm_model:
            raise ValueError(
                "llm_model must be set: specify LLM_MODEL in .env (there is no default model)"
            )
        return self

    @model_validator(mode="after")
    def validate_profile_name(self) -> "Settings":
        if self.remorise_profile and not is_valid_profile_name(self.remorise_profile):
            raise ValueError(
                "remorise_profile must be half-width alphanumeric "
                "(it becomes part of the database file name)"
            )
        self.remorise_profile = self.remorise_profile.lower()
        return self

    def character_directory(self, character_id: str) -> Path:
        """The character's database lives in this folder too, so the
        profile, layers and accumulated state of a character move
        and back up together.
        """
        return self.remorise_data_dir / "characters" / character_id

    def database_path(self, character_id: str, profile: str = "") -> Path:
        """Without a profile this is the character folder's
        ``remorise.db``; a profile selects the sibling file
        ``remorise.<profile>.db`` in the same folder, so profiles
        share the character's assets and differ only in state.
        """
        return self.character_directory(character_id) / database_file_name(profile)

    def effective_database_url(self, character_id: str, profile: str = "") -> str:
        """An explicitly configured ``database_url`` wins as before
        (a profile then has no effect); otherwise the database is
        the profile's file inside the character's folder in the
        data directory — never the bundled character folder, so a
        bundled character's state still lands in the user's data.
        """
        if self.database_url:
            return self.database_url
        from sqlalchemy.engine import URL

        return URL.create(
            "sqlite+aiosqlite",
            database=str(self.database_path(character_id, profile)),
        ).render_as_string(hide_password=False)
