"""DB-backed runtime settings.

Configuration lives in two layers:

- **Base layer** — connection and bootstrap values (LLM endpoint /
  model / API key, data directory, database URL). These
  stay in ``.env`` only: the database itself, and the LLM client built
  at startup, depend on them before any DB row can be read.
- **Layered fields** — everything that tunes runtime behavior. These
  may be overridden in the ``app_settings`` table and changed from the
  UI without a restart. Resolution order is DB override > ``.env`` >
  built-in default, where the ``.env`` side is captured once in a
  pristine ``Settings`` snapshot (``app.state.base_settings``).

All layered fields are exposed on the normal settings API, including
the data-lifecycle ones (archive purge, raw-log retention, and the
memory-forgetting parameters): the debug API is read-only, so these
live on the regular settings surface (spec §16/§17).

The effective values live on the single shared ``Settings`` object in
``app.state.settings``; updates are applied onto it in place so every
holder of that reference (request handlers, the job worker) sees the
new values immediately.
"""

import logging
from collections.abc import Iterable, Mapping
from typing import Any

from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.database.models import AppSetting, utc_now

logger = logging.getLogger(__name__)

OPERATIONAL_FIELDS: tuple[str, ...] = (
    "llm_max_tokens",
    "llm_timeout_seconds",
    "llm_temperature",
    "llm_frequency_penalty",
    "llm_presence_penalty",
    "llm_repeat_penalty",
    "llm_context_size",
    "context_summary_ratio",
    "context_target_ratio",
    "summary_protected_messages",
    "job_max_attempts",
    "job_poll_interval_seconds",
    "emotion_half_life_minutes",
    "affinity_min",
    "affinity_max",
    "affinity_delta_limit",
    "archive_retention_days",
    "raw_log_retention_days",
    "memory_decay_enabled",
    "memory_decay_threshold",
    "memory_half_life_event_days",
    "memory_half_life_state_days",
    "memory_reactivation_factor",
    "memory_reactivation_max_multiplier",
    "memory_agent_max_calls",
    "memory_agent_timeout_seconds",
    "memory_handover_limit",
    "memory_handover_token_budget",
    "memory_resident_max_items",
    "memory_similarity_threshold",
    "sprite_motion_enabled",
    "sprite_motion_amplitude",
    "sprite_motion_speed",
    "sprite_motion_overscan",
)

LAYERED_FIELDS: tuple[str, ...] = OPERATIONAL_FIELDS
_LAYERED_SET = frozenset(LAYERED_FIELDS)


async def load_overrides(session: AsyncSession) -> dict[str, Any]:
    """All stored overrides, keyed by Settings field name.

    Rows whose key is not a layered field (written by another version)
    are ignored, so an unknown row can never break resolution.
    """
    rows = (await session.scalars(select(AppSetting))).all()
    return {row.key: row.value for row in rows if row.key in _LAYERED_SET}


def build_effective(base: Settings, overrides: Mapping[str, Any]) -> Settings:
    """The full Settings that results from applying ``overrides``.

    Built through the normal ``Settings`` constructor, so every field
    constraint and cross-field validator runs; an invalid combination
    raises ``ValidationError`` before anything is persisted or applied.
    """
    data = base.model_dump()
    for key, value in overrides.items():
        if key in _LAYERED_SET:
            data[key] = value
    return Settings(**data)


def apply_effective(settings: Settings, effective: Settings) -> None:
    for field in LAYERED_FIELDS:
        setattr(settings, field, getattr(effective, field))


async def refresh_from_database(app: Any) -> None:
    """Startup: apply stored overrides onto ``app.state.settings``.

    Stored values were validated when written; if they no longer
    validate against the base settings (for example a ``.env`` edit
    made a stored ratio pair inconsistent), keep the base values and
    log instead of failing startup over a settings row.
    """
    async with app.state.session_factory() as session:
        overrides = await load_overrides(session)
    if not overrides:
        return
    try:
        effective = build_effective(app.state.base_settings, overrides)
    except ValidationError:
        logger.exception("Stored settings overrides no longer validate; ignoring them")
        return
    apply_effective(app.state.settings, effective)


def split_patch(payload: BaseModel) -> tuple[dict[str, Any], list[str]]:
    """Split an update payload into value changes and resets.

    A field explicitly sent as ``null`` resets that field: its DB
    override is removed and the ``.env`` / default value applies again.
    Fields absent from the payload are left untouched.
    """
    changes: dict[str, Any] = {}
    resets: list[str] = []
    for field in payload.model_fields_set:
        value = getattr(payload, field)
        if value is None:
            resets.append(field)
        else:
            changes[field] = value
    return changes, resets


async def update_overrides(
    session: AsyncSession,
    base: Settings,
    changes: Mapping[str, Any],
    resets: Iterable[str],
) -> dict[str, Any]:
    """Merge, validate, and persist override changes.

    The merged result is validated as a whole first; on
    ``ValidationError`` nothing is written. Returns the new override
    map (already committed).
    """
    overrides = await load_overrides(session)
    overrides.update(changes)
    for field in resets:
        overrides.pop(field, None)
    build_effective(base, overrides)  # validation gate; result rebuilt by caller
    for field, value in changes.items():
        row = await session.get(AppSetting, field)
        if row is None:
            session.add(AppSetting(key=field, value=value))
        else:
            row.value = value
            row.updated_at = utc_now()
    for field in resets:
        row = await session.get(AppSetting, field)
        if row is not None:
            await session.delete(row)
    await session.commit()
    return overrides


async def apply_patch(session: AsyncSession, app: Any, payload: BaseModel) -> dict[str, Any]:
    """Validate and persist an update payload, then apply it in place.

    Returns the new override map. Raises ``ValidationError`` (with
    nothing persisted and nothing applied) when the merged combination
    is invalid.
    """
    changes, resets = split_patch(payload)
    return await _apply_changes(session, app, changes, resets)


async def _apply_changes(
    session: AsyncSession,
    app: Any,
    changes: dict[str, Any],
    resets: list[str],
) -> dict[str, Any]:
    overrides = await update_overrides(session, app.state.base_settings, changes, resets)
    effective = build_effective(app.state.base_settings, overrides)
    apply_effective(app.state.settings, effective)
    # The LLM client is built once at startup, so a timeout change
    # has to be pushed onto it explicitly; without this the new
    # value would only take effect on the next restart.
    client = getattr(app.state, "llm_client", None)
    if client is not None:
        client.timeout = app.state.settings.llm_timeout_seconds
    return overrides
