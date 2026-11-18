from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import Settings
from app.database.models import Message, Summary
from app.database.session import create_engine, initialize_database
from app.services import retention_service

NOW = datetime.now(UTC)


async def make_factory(tmp_path: Path, name: str = "retention.db"):
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / name}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)
    return engine, factory


def message(content: str, *, days_old: int) -> Message:
    return Message(
        role="user",
        content=content,
        created_at=NOW - timedelta(days=days_old),
    )


@pytest.mark.asyncio
async def test_expired_logs_are_archived_without_any_precondition(
    tmp_path: Path,
) -> None:
    engine, factory = await make_factory(tmp_path)
    async with factory() as session:
        session.add_all([message("古い発言", days_old=40), message("新しい発言", days_old=1)])
        await session.commit()
        # No extraction or summarization state gates archiving:
        # expiry alone moves a message out of the history.
        await retention_service.process_expired_logs(session, Settings(raw_log_retention_days=30))
        rows = {row.content: row for row in (await session.scalars(select(Message))).all()}
        assert rows["古い発言"].archived_at is not None
        assert rows["新しい発言"].archived_at is None
    await engine.dispose()


@pytest.mark.asyncio
async def test_summary_survives_while_part_of_its_range_is_still_active(
    tmp_path: Path,
) -> None:
    engine, factory = await make_factory(tmp_path)
    async with factory() as session:
        old = message("古い発言", days_old=40)
        new = message("新しい発言", days_old=1)
        session.add_all([old, new])
        await session.commit()
        session.add(
            Summary(
                start_message_id=old.id,
                end_message_id=new.id,
                content="要約",
                active=True,
                created_at=NOW - timedelta(days=1),
            )
        )
        await session.commit()
        await retention_service.process_expired_logs(session, Settings(raw_log_retention_days=30))
        summary = await session.scalar(select(Summary))
        assert summary is not None
        assert summary.archived_at is None
        assert summary.active is True
    await engine.dispose()


@pytest.mark.asyncio
async def test_summary_is_invalidated_once_its_range_is_fully_archived(
    tmp_path: Path,
) -> None:
    engine, factory = await make_factory(tmp_path)
    async with factory() as session:
        first = message("古い発言1", days_old=40)
        second = message("古い発言2", days_old=41)
        session.add_all([first, second])
        await session.commit()
        session.add(
            Summary(
                start_message_id=first.id,
                end_message_id=second.id,
                content="要約",
                active=True,
                created_at=NOW - timedelta(days=1),
            )
        )
        await session.commit()
        await retention_service.process_expired_logs(session, Settings(raw_log_retention_days=30))
        summary = await session.scalar(select(Summary))
        assert summary is not None
        assert summary.archived_at is not None
        assert summary.active is False
    await engine.dispose()
