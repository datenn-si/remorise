from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import Settings
from app.database.models import Memory
from app.database.session import create_engine, initialize_database
from app.services import memory_lifecycle

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)


def memory_row(content: str = "紅茶が好き", **kwargs: object) -> Memory:
    defaults: dict[str, object] = {
        "category": "state",
        "importance": 5,
        "status": "active",
        "is_active": True,
        "provenance": "explicit",
        "keywords": [],
        "specific_terms": [],
        "provisional": False,
        "source_type": "conversation",
        "created_at": NOW,
        "last_reinforced_at": NOW,
        "reactivation_count": 0,
        "restoration_count": 0,
    }
    defaults.update(kwargs)
    return Memory(content=content, **defaults)


def test_half_life_depends_only_on_the_two_categories() -> None:
    settings = Settings()
    event = memory_row(category="event")
    state = memory_row(category="state")
    assert memory_lifecycle.base_half_life_days(event, settings) == 30.0
    assert memory_lifecycle.base_half_life_days(state, settings) == 365.0


def test_reactivation_stretches_the_effective_half_life_with_a_cap() -> None:
    settings = Settings()
    row = memory_row(category="event", reactivation_count=1)
    assert memory_lifecycle.effective_half_life_days(row, settings) == 45.0
    row.reactivation_count = 100
    capped = memory_lifecycle.effective_half_life_days(row, settings)
    assert capped == 30.0 * settings.memory_reactivation_max_multiplier


def test_retention_score_decays_with_the_category_half_life() -> None:
    settings = Settings()
    row = memory_row(category="event", importance=5)
    fresh = memory_lifecycle.retention_score(row, settings, NOW)
    assert fresh == pytest.approx(1.0)
    aged = memory_lifecycle.retention_score(row, settings, NOW + timedelta(days=30))
    assert aged == pytest.approx(0.5)


def test_forget_and_restore_and_recall_bookkeeping() -> None:
    row = memory_row()
    memory_lifecycle.forget_memory(row, NOW)
    assert row.status == "forgotten" and row.is_active is False

    memory_lifecycle.restore_memory(row, NOW + timedelta(days=1))
    assert row.status == "active" and row.is_active is True
    assert row.restoration_count == 1
    assert row.last_restored_at == NOW + timedelta(days=1)
    assert row.reactivation_count == 0
    assert row.last_recalled_at is None

    memory_lifecycle.forget_memory(row, NOW + timedelta(days=2))
    memory_lifecycle.reactivate_memory(row, NOW + timedelta(days=3))
    assert row.is_active is True
    assert row.reactivation_count == 1
    assert row.last_recalled_at == NOW + timedelta(days=3)
    assert row.restoration_count == 1


@pytest.mark.asyncio
async def test_apply_memory_decay_pass(tmp_path: Path) -> None:
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / 'decay.db'}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)
    settings = Settings()
    old_event = memory_row(
        category="event",
        importance=5,
        created_at=NOW - timedelta(days=365),
        last_reinforced_at=NOW - timedelta(days=365),
    )
    young_state = memory_row(
        category="state",
        importance=5,
        content="まだ新しい状態",
        created_at=NOW - timedelta(days=365),
        last_reinforced_at=NOW - timedelta(days=365),
    )
    async with factory() as session:
        session.add_all([old_event, young_state])
        await session.commit()
        forgotten = await memory_lifecycle.apply_memory_decay(session, settings, now=NOW)
        await session.commit()
        assert forgotten == 1
        rows = {row.content: row for row in (await session.scalars(select(Memory))).all()}
        assert rows["紅茶が好き"].is_active is False
        assert rows["まだ新しい状態"].is_active is True
    await engine.dispose()


def test_decay_is_disabled_by_setting() -> None:
    settings = Settings(memory_decay_enabled=False)
    row = memory_row(
        category="event",
        importance=1,
        created_at=NOW - timedelta(days=3650),
        last_reinforced_at=NOW - timedelta(days=3650),
    )
    assert memory_lifecycle.retention_score(row, settings, NOW) < settings.memory_decay_threshold
