from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import Settings
from app.database.models import Message, Summary
from app.database.session import create_engine, initialize_database
from app.services import summary_service


class FakeClient:
    def __init__(self, content: str = "新しい要約", fail: bool = False) -> None:
        async def create(**kwargs: object) -> SimpleNamespace:
            if fail:
                raise RuntimeError("llm down")
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(message=SimpleNamespace(content=content, tool_calls=None))
                ],
                usage=SimpleNamespace(total_tokens=10),
            )

        self.chat = SimpleNamespace(completions=SimpleNamespace(create=create))


async def make_factory(tmp_path: Path, name: str = "summary.db"):
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / name}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)
    return engine, factory


async def add_messages(factory, count: int) -> list[int]:
    async with factory() as session:
        rows = [
            Message(role="user" if i % 2 == 0 else "assistant", content=f"発言{i}")
            for i in range(count)
        ]
        session.add_all(rows)
        await session.commit()
        return [row.id for row in rows]


@pytest.mark.asyncio
async def test_summarize_range_creates_an_active_summary(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    ids = await add_messages(factory, 6)
    async with factory() as session:
        ok = await summary_service.summarize_range(
            session, FakeClient(), Settings(), ids[0], ids[3]
        )
        assert ok is True
        summary = await session.scalar(select(Summary))
        assert summary is not None and summary.active is True
        assert summary.content == "新しい要約"
        assert summary.start_message_id == ids[0]
        assert summary.end_message_id == ids[3]
        messages = (await session.scalars(select(Message))).all()
        assert all(row.archived_at is None for row in messages)
    await engine.dispose()


@pytest.mark.asyncio
async def test_summarize_range_supersedes_the_previous_summary(
    tmp_path: Path,
) -> None:
    engine, factory = await make_factory(tmp_path)
    ids = await add_messages(factory, 8)
    async with factory() as session:
        assert await summary_service.summarize_range(
            session, FakeClient("第一の要約"), Settings(), ids[0], ids[3]
        )
    async with factory() as session:
        assert await summary_service.summarize_range(
            session, FakeClient("第二の要約"), Settings(), ids[4], ids[7]
        )
        summaries = list((await session.scalars(select(Summary).order_by(Summary.id))).all())
        assert len(summaries) == 2
        assert summaries[0].active is False
        assert summaries[1].active is True
        assert summaries[1].start_message_id == ids[0]
        assert summaries[1].end_message_id == ids[7]
    await engine.dispose()


@pytest.mark.asyncio
async def test_failed_summarization_preserves_history_and_summary(
    tmp_path: Path,
) -> None:
    engine, factory = await make_factory(tmp_path)
    ids = await add_messages(factory, 4)
    async with factory() as session:
        assert await summary_service.summarize_range(
            session, FakeClient("元の要約"), Settings(), ids[0], ids[1]
        )
    async with factory() as session:
        ok = await summary_service.summarize_range(
            session, FakeClient(fail=True), Settings(), ids[2], ids[3]
        )
        assert ok is False
        summaries = list((await session.scalars(select(Summary))).all())
        assert len(summaries) == 1
        assert summaries[0].active is True
        assert summaries[0].content == "元の要約"
    await engine.dispose()
