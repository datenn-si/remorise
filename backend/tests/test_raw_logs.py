from collections.abc import AsyncIterator
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.api import chat
from app.config import Settings
from app.database.models import CharacterState, LlmRawLog, Message, PostJob, utc_now
from app.database.session import create_engine, initialize_database
from app.llm.client import summarize_text
from app.main import create_app
from app.services import raw_log_service
from app.services.memory_agent import AgentResult, run_memory_agent
from app.services.memory_store import TurnContext


async def make_factory(tmp_path: Path, name: str = "raw_logs.db"):
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / name}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)
    return engine, factory


def make_client(content: str | None = None, error: Exception | None = None):
    class FakeCompletions:
        async def create(self, **kwargs: object) -> SimpleNamespace:
            if error is not None:
                raise error
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(message=SimpleNamespace(content=content, tool_calls=None))
                ],
                usage=SimpleNamespace(total_tokens=5),
            )

    return SimpleNamespace(chat=SimpleNamespace(completions=FakeCompletions()))


def make_state() -> CharacterState:
    return CharacterState(id=1, emotion="neutral", intensity=0.0, mood="neutral", affinity=50)


@pytest.mark.asyncio
async def test_memory_agent_records_raw_response(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    async with factory() as session:
        result = await run_memory_agent(
            session,
            make_client("考え中"),
            Settings(),
            question="京都旅行のことを覚えてる？",
            state=make_state(),
            session_factory=factory,
            message_id=42,
        )
        await session.commit()
    assert result is not None
    async with factory() as session:
        rows = list((await session.scalars(select(LlmRawLog))).all())
    assert len(rows) == 1
    assert rows[0].kind == "memory_agent"
    assert rows[0].response == "考え中"
    assert rows[0].error is None
    assert rows[0].message_id == 42
    assert "京都旅行" in rows[0].request
    await engine.dispose()


@pytest.mark.asyncio
async def test_memory_agent_records_error_and_still_returns(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    async with factory() as session:
        result = await run_memory_agent(
            session,
            make_client(error=RuntimeError("llm down")),
            Settings(),
            question="こんにちは",
            state=make_state(),
            session_factory=factory,
            message_id=7,
        )
        await session.commit()
    assert result.delivered == []
    async with factory() as session:
        rows = list((await session.scalars(select(LlmRawLog))).all())
    assert len(rows) == 1
    assert rows[0].kind == "memory_agent"
    assert rows[0].response is None
    assert rows[0].error is not None and "llm down" in rows[0].error
    await engine.dispose()


@pytest.mark.asyncio
async def test_recording_failure_does_not_break_the_agent(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)

    def broken_factory() -> object:
        raise RuntimeError("logging store unavailable")

    async with factory() as session:
        result = await run_memory_agent(
            session,
            make_client("問題なし"),
            Settings(),
            question="こんにちは",
            state=make_state(),
            session_factory=broken_factory,  # type: ignore[arg-type]
            message_id=1,
        )
        await session.commit()
    assert result is not None
    await engine.dispose()


@pytest.mark.asyncio
async def test_summary_records_raw_response_and_error(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    settings = Settings()

    summary = await summarize_text(
        make_client("要約テキスト"),
        settings,
        "user: こんにちは",
        "",
        session_factory=factory,
        start_message_id=3,
        end_message_id=5,
    )
    assert summary == "要約テキスト"

    with pytest.raises(RuntimeError, match="summary boom"):
        await summarize_text(
            make_client(error=RuntimeError("summary boom")),
            settings,
            "user: こんにちは",
            "",
            session_factory=factory,
            job_id=9,
            start_message_id=3,
            end_message_id=5,
        )

    async with factory() as session:
        rows = list((await session.scalars(select(LlmRawLog).order_by(LlmRawLog.id))).all())
    assert [row.kind for row in rows] == ["summary", "summary"]
    assert rows[0].response == "要約テキスト"
    assert rows[0].start_message_id == 3 and rows[0].end_message_id == 5
    assert rows[1].response is None
    assert rows[1].error is not None and "summary boom" in rows[1].error
    assert rows[1].job_id == 9
    await engine.dispose()


class FakeStream:
    def __aiter__(self) -> AsyncIterator[SimpleNamespace]:
        async def chunks() -> AsyncIterator[SimpleNamespace]:
            for content in ("Hello", " there."):
                yield SimpleNamespace(
                    choices=[
                        SimpleNamespace(delta=SimpleNamespace(content=content, tool_calls=None))
                    ]
                )

        return chunks()

    async def close(self) -> None:
        return None


@pytest.mark.asyncio
async def test_chat_records_raw_stream_and_debug_endpoint_filters_by_kind(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_completion(*args: object, **kwargs: object) -> FakeStream:
        return FakeStream()

    async def fake_agent(*args: object, **kwargs: object) -> AgentResult:
        settings = kwargs.get("settings") or args[2]
        return AgentResult(
            ctx=TurnContext(settings=settings, source_date=kwargs.get("source_date"))
        )

    async def no_emotion(*args: object, **kwargs: object) -> None:
        return None

    monkeypatch.setattr(chat, "start_completion", fake_completion)
    monkeypatch.setattr(chat, "run_memory_agent", fake_agent)
    monkeypatch.setattr(chat, "analyze_emotion", no_emotion)
    app = create_app(Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'chat_raw.db'}"))

    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post("/api/chat", json={"message": "Hi"})
            assert response.status_code == 200
            assert "Hello" in response.text

            chat_logs = await client.get("/api/debug/raw-logs", params={"kind": "chat"})
            assert chat_logs.status_code == 200
            entries = chat_logs.json()
            assert len(entries) == 1
            assert entries[0]["response"] == "Hello there."
            assert entries[0]["error"] is None
            assert entries[0]["message_id"] == 1
            assert "Hi" in entries[0]["request"]

            summary_logs = await client.get("/api/debug/raw-logs", params={"kind": "summary"})
            assert summary_logs.json() == []

            all_logs = await client.get("/api/debug/raw-logs")
            assert len(all_logs.json()) == 1


@pytest.mark.asyncio
async def test_purge_keeps_expired_rows_until_their_job_completes(
    tmp_path: Path,
) -> None:
    engine, factory = await make_factory(tmp_path)
    settings = Settings(raw_log_retention_days=30)
    expired_at = utc_now() - timedelta(days=31)

    async with factory() as session:
        user = Message(role="user", content="hi")
        session.add(user)
        await session.commit()
        await session.refresh(user)
        job = PostJob(
            kind="summary",
            start_message_id=user.id,
            end_message_id=user.id,
            conversation_epoch=1,
            status="running",
        )
        session.add(job)
        await session.commit()
        await session.refresh(job)

        job_row = LlmRawLog(
            kind="summary",
            request="{}",
            response="{}",
            job_id=job.id,
            start_message_id=user.id,
            end_message_id=user.id,
            created_at=expired_at,
        )
        message_row = LlmRawLog(
            kind="chat",
            request="{}",
            response="hi",
            message_id=user.id,
            created_at=expired_at,
        )
        unreferenced_row = LlmRawLog(
            kind="chat", request="{}", response="hi", created_at=expired_at
        )
        fresh_row = LlmRawLog(kind="chat", request="{}", response="hi")
        session.add_all([job_row, message_row, unreferenced_row, fresh_row])
        await session.commit()
        job_log_id = job_row.id
        fresh_id = fresh_row.id

        # Only the row owned by the unfinished job survives this pass:
        # foreground rows expire on age alone.
        deleted = await raw_log_service.purge_expired_raw_logs(session, settings)
        assert deleted == 2
        remaining = list((await session.scalars(select(LlmRawLog))).all())
        assert {row.id for row in remaining} == {job_log_id, fresh_id}

        job.status = "done"
        await session.commit()

        deleted = await raw_log_service.purge_expired_raw_logs(session, settings)
        assert deleted == 1
        remaining = list((await session.scalars(select(LlmRawLog))).all())
        assert [row.id for row in remaining] == [fresh_id]
    await engine.dispose()
