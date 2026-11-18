"""Memory.updated_at is renamed to last_reinforced_at.

The rename is cosmetic by design — the stored values, the decay-clock
arithmetic, the search tie-break, and the list order must be exactly
what they were when the column was called updated_at. These tests pin
that down: the decay
clock still takes the newest of the recall/access/stored stamps (a
search hit stamps only last_accessed_at, so the stored stamp alone is
not the clock), and the API exposes the new name.
"""

from datetime import UTC, datetime, timedelta

import pytest

from app.config import Settings
from app.database.models import Memory
from app.schemas.memory import MemoryResponse
from app.services import memory_lifecycle

CREATED = datetime(2026, 1, 1, tzinfo=UTC)
STORED = datetime(2026, 2, 1, tzinfo=UTC)
ACCESSED = datetime(2026, 3, 1, tzinfo=UTC)
RECALLED = datetime(2026, 4, 1, tzinfo=UTC)
NOW = datetime(2026, 5, 1, tzinfo=UTC)


def _memory(**stamps: datetime | None) -> Memory:
    return Memory(
        content="時計の確認",
        category="event",
        provisional=False,
        importance=3,
        status="active",
        is_active=True,
        provenance="inferred",
        source_type="conversation",
        reactivation_count=0,
        restoration_count=0,
        created_at=CREATED,
        last_reinforced_at=stamps.get("stored"),
        last_accessed_at=stamps.get("accessed"),
        last_recalled_at=stamps.get("recalled"),
    )


def _pre_rename_clock(memory: Memory) -> datetime:
    """The decay clock as computed before the rename (max of stamps)."""
    candidates = [
        value
        for value in (
            memory.last_recalled_at,
            memory.last_accessed_at,
            memory.last_reinforced_at,  # the stamp then called updated_at
        )
        if value is not None
    ]
    return max(candidates) if candidates else memory.created_at


@pytest.mark.parametrize(
    "stamps",
    [
        {"stored": STORED},
        {"stored": STORED, "accessed": ACCESSED},
        {"stored": STORED, "accessed": ACCESSED, "recalled": RECALLED},
        {"stored": RECALLED, "accessed": STORED},
        {"stored": STORED, "recalled": STORED - timedelta(days=10)},
        {},
    ],
)
def test_decay_clock_matches_pre_rename_arithmetic(stamps: dict) -> None:
    memory = _memory(**stamps)
    expected = _pre_rename_clock(memory)
    assert memory_lifecycle.last_reinforced_at(memory) == expected
    settings = Settings()
    score = memory_lifecycle.retention_score(memory, settings, NOW)
    age_days = (NOW - expected).total_seconds() / 86400.0
    half_life = memory_lifecycle.effective_half_life_days(memory, settings)
    assert score == pytest.approx((memory.importance / 5.0) * (0.5 ** (age_days / half_life)))


def test_record_memory_use_still_stamps_only_the_access_time() -> None:
    memory = _memory(stored=STORED)
    memory_lifecycle.record_memory_use([memory], NOW)
    assert memory.last_accessed_at == NOW
    # A search hit must not move the stored stamp: that would change
    # the memory list order and the search tie-break, which the rename
    # is not allowed to do. The clock still sees the hit via the max.
    assert memory.last_reinforced_at == STORED
    assert memory_lifecycle.last_reinforced_at(memory) == NOW


def test_memory_response_exposes_last_reinforced_at() -> None:
    memory = _memory(stored=STORED, accessed=ACCESSED)
    memory.id = 7
    memory.source_type = "conversation"
    payload = MemoryResponse.model_validate(memory).model_dump(mode="json")
    assert payload["last_reinforced_at"] == STORED.isoformat().replace("+00:00", "Z")
    assert "updated_at" not in payload
