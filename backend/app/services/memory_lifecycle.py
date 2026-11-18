"""Memory lifecycle transitions: decay (forgetting), recall, restoration.

The lifecycle ``status`` on a memory is the source of truth; every helper
here also keeps the legacy ``is_active`` flag in sync (``is_active`` is true
exactly when ``status == "active"``), because most queries filter on the
boolean. All state changes to a memory's active-ness should go through
these helpers instead of assigning the fields directly.
"""

import logging
from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.database.models import Memory, utc_now

logger = logging.getLogger(__name__)

STATUS_ACTIVE = "active"
STATUS_FORGOTTEN = "forgotten"

_HALF_LIFE_ATTRS = {
    "event": "memory_half_life_event_days",
    "state": "memory_half_life_state_days",
}


def as_utc(value: datetime) -> datetime:
    from datetime import UTC

    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def base_half_life_days(memory: Memory, settings: Settings) -> float:
    attr = _HALF_LIFE_ATTRS.get(memory.category, "memory_half_life_event_days")
    return float(getattr(settings, attr))


def effective_half_life_days(memory: Memory, settings: Settings) -> float:
    """Half-life stretched by past recalls of this memory.

    Every time a forgotten memory is recalled it becomes harder to forget:
    its half-life is multiplied by the reactivation factor once per recall,
    capped at the configured maximum multiplier. Restorations do not
    stretch the half-life (spec §20-6): they only move the clock's start.
    """
    multiplier = min(
        settings.memory_reactivation_factor ** max(0, memory.reactivation_count),
        settings.memory_reactivation_max_multiplier,
    )
    return base_half_life_days(memory, settings) * multiplier


def last_reinforced_at(memory: Memory) -> datetime:
    """The effective reinforcement time the decay clock runs from.

    The newest of the three stamps. The stored `last_reinforced_at`
    column alone is not self-contained: lifecycle transitions and
    content writes stamp it, but an ordinary search hit stamps only
    `last_accessed_at` (record_memory_use), so the max is what makes
    the clock match the arithmetic.
    """
    candidates = [
        value
        for value in (
            memory.last_recalled_at,
            memory.last_accessed_at,
            memory.last_reinforced_at,
        )
        if value is not None
    ]
    return as_utc(max(candidates)) if candidates else as_utc(memory.created_at)


def retention_score(memory: Memory, settings: Settings, now: datetime | None = None) -> float:
    current = as_utc(now or utc_now())
    age_days = max(0.0, (current - last_reinforced_at(memory)).total_seconds() / 86400.0)
    half_life = effective_half_life_days(memory, settings)
    return (memory.importance / 5.0) * (0.5 ** (age_days / half_life))


def forget_memory(memory: Memory, now: datetime | None = None) -> None:
    current = now or utc_now()
    memory.status = STATUS_FORGOTTEN
    memory.is_active = False
    memory.last_reinforced_at = current


def restore_memory(memory: Memory, now: datetime | None = None) -> None:
    """Bring a forgotten memory back because its fact was stated again.

    This is a restoration, not a recall — the user never pointed back
    at the memory — so it keeps its own bookkeeping
    (``restoration_count`` / ``last_restored_at``) and never touches
    the recall count, the recall timestamp, or the half-life growth
    those drive. Like any revival it refreshes ``last_reinforced_at``,
    which is what resets the decay clock; the half-life itself does
    not grow.
    """
    current = now or utc_now()
    memory.status = STATUS_ACTIVE
    memory.is_active = True
    memory.restoration_count = (memory.restoration_count or 0) + 1
    memory.last_restored_at = current
    memory.last_reinforced_at = current


def reactivate_memory(
    memory: Memory, now: datetime | None = None, *, count_as_recall: bool = True
) -> None:
    """Bring a forgotten memory back to active use (recall).

    A recall is a strong reinforcement: the reactivation counter grows, so
    the decay half-life of this memory becomes longer than before it was
    forgotten. Only the pointing path (the user explicitly referring back
    to a past fact) may call this with ``count_as_recall`` — the recall
    bookkeeping is the record that a pointing happened, and no other
    path may write it (spec §7.3, provenance of recall).
    """
    current = now or utc_now()
    memory.status = STATUS_ACTIVE
    memory.is_active = True
    if count_as_recall:
        memory.reactivation_count = (memory.reactivation_count or 0) + 1
        memory.last_recalled_at = current
    memory.last_reinforced_at = current


def record_memory_use(memories: Sequence[Memory], now: datetime | None = None) -> None:
    """Weak reinforcement for memories a search actually returned.

    Using a memory refreshes its decay clock, which is also the score
    recovery: the retention score is computed from the last reinforcement.
    A search hit is an *access*, never a recall: ``last_recalled_at`` is
    written only by ``reactivate_memory`` when a forgotten memory is
    recalled, so the two timestamps stay distinguishable in the UI.
    """
    current = now or utc_now()
    for memory in memories:
        memory.last_accessed_at = current


def record_content_update(
    memory: Memory,
    source_type: str,
    provenance: str,
    now: datetime | None = None,
) -> None:
    """Stamp a substantive change to the fact itself.

    Called only by paths that change what a memory says (a save, a
    correction, a keyword backfill). Lifecycle transitions (forget,
    restore, recall, search hits) must never call this: the content
    timestamp exists so the UI can show when the fact last changed,
    undistorted by the forgetting system.
    """
    current = now or utc_now()
    memory.content_updated_at = current
    memory.content_update_source_type = source_type
    memory.content_update_provenance = provenance


async def apply_memory_decay(
    session: AsyncSession, settings: Settings, now: datetime | None = None
) -> int:
    """Forget active memories whose retention score fell below threshold.

    Forgetting is deactivation only; rows are never deleted here. There
    are no exemptions by category or registration path (the redesign
    removed pinning with the manual debug controls). Returns the number
    of memories forgotten in this pass.
    """
    if not settings.memory_decay_enabled:
        return 0
    current = now or utc_now()
    memories = list(
        (
            await session.scalars(
                select(Memory).where(Memory.status == STATUS_ACTIVE, Memory.is_active.is_(True))
            )
        ).all()
    )
    forgotten = 0
    for memory in memories:
        if retention_score(memory, settings, current) < settings.memory_decay_threshold:
            forget_memory(memory, current)
            forgotten += 1
    if forgotten:
        await session.commit()
        logger.info("Memory decay pass forgot %d memories", forgotten)
    return forgotten
