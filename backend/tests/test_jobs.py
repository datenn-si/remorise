import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import Settings
from app.database.models import Message, PostJob, Summary
from app.database.session import create_engine, initialize_database
from app.services import job_service


class FakeClient:
    def __init__(self, content: str = "要約テキスト") -> None:
        async def create(**kwargs: object) -> SimpleNamespace:
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(message=SimpleNamespace(content=content, tool_calls=None))
                ],
                usage=SimpleNamespace(total_tokens=10),
            )

        self.chat = SimpleNamespace(completions=SimpleNamespace(create=create))


async def make_factory(tmp_path: Path, name: str = "jobs.db"):
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / name}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)
    return engine, factory


async def add_messages(factory, count: int, text: str = "あ" * 40) -> list[int]:
    async with factory() as session:
        rows = []
        for index in range(count):
            row = Message(
                role="user" if index % 2 == 0 else "assistant",
                content=f"{text}{index}",
            )
            session.add(row)
            rows.append(row)
        await session.commit()
        return [row.id for row in rows]


@pytest.mark.asyncio
async def test_maybe_enqueue_summary_at_ratio_with_headroom(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    ids = await add_messages(factory, 30)
    settings = Settings(
        llm_context_size=1000,
        context_summary_ratio=0.5,
        context_warning_ratio=0.4,
        context_target_ratio=0.3,
        summary_protected_messages=4,
    )
    async with factory() as session:
        job = await job_service.maybe_enqueue_summary(session, settings)
        assert job is not None
        assert job.kind == job_service.JOB_SUMMARY
        assert job.start_message_id == ids[0]
        assert job.end_message_id == ids[-5]
        again = await job_service.maybe_enqueue_summary(session, settings)
        assert again is not None and again.id == job.id
        assert len((await session.scalars(select(PostJob))).all()) == 1
    await engine.dispose()


@pytest.mark.asyncio
async def test_maybe_enqueue_summary_below_ratio_does_nothing(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    await add_messages(factory, 3, text="短い")
    settings = Settings(llm_context_size=16384)
    async with factory() as session:
        assert await job_service.maybe_enqueue_summary(session, settings) is None
        assert (await session.scalars(select(PostJob))).all() == []
    await engine.dispose()


@pytest.mark.asyncio
async def test_execute_summary_job_creates_the_summary(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    ids = await add_messages(factory, 4)
    settings = Settings()
    async with factory() as session:
        job = await job_service.enqueue_job(
            session, job_service.JOB_SUMMARY, ids[0], ids[-1], epoch=1
        )
        job_id = job.id
    done = await job_service.execute_job(factory, FakeClient(), settings, job_id)
    assert done is True
    async with factory() as session:
        job = await session.get(PostJob, job_id)
        assert job.status == "done"
        assert job.result_json is None
        summary = await session.scalar(select(Summary))
        assert summary is not None
        assert summary.content == "要約テキスト"
        assert summary.end_message_id == ids[-1]
    await engine.dispose()


@pytest.mark.asyncio
async def test_execute_unknown_job_kind_fails_the_job(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    ids = await add_messages(factory, 2)
    async with factory() as session:
        job = await job_service.enqueue_job(session, "memory_extract", ids[0], ids[-1], epoch=1)
        job_id = job.id
    done = await job_service.execute_job(factory, FakeClient(), Settings(), job_id)
    assert done is False
    async with factory() as session:
        job = await session.get(PostJob, job_id)
        assert job.status == "failed"
        assert job.error == "unknown_job_kind:memory_extract"
    await engine.dispose()


@pytest.mark.asyncio
async def test_stale_epoch_job_is_skipped_as_done(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    ids = await add_messages(factory, 2)
    async with factory() as session:
        meta = await job_service.get_meta(session)
        job = await job_service.enqueue_job(
            session, job_service.JOB_SUMMARY, ids[0], ids[-1], epoch=meta.epoch + 5
        )
        job_id = job.id
    done = await job_service.execute_job(factory, FakeClient(), Settings(), job_id)
    assert done is True
    async with factory() as session:
        job = await session.get(PostJob, job_id)
        assert job.status == "done"
        assert job.error == "stale_epoch"
        assert (await session.scalars(select(Summary))).all() == []
    await engine.dispose()


@pytest.mark.asyncio
async def test_recovery_requeues_running_and_retryable_failed(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    ids = await add_messages(factory, 2)
    settings = Settings(job_max_attempts=3)
    async with factory() as session:
        running = await job_service.enqueue_job(
            session, job_service.JOB_SUMMARY, ids[0], ids[0], epoch=1
        )
        running.status = "running"
        failed = await job_service.enqueue_job(
            session, job_service.JOB_SUMMARY, ids[1], ids[1], epoch=1
        )
        failed.status = "failed"
        failed.attempts = 1
        exhausted = await job_service.enqueue_job(
            session, job_service.JOB_SUMMARY, ids[0], ids[1], epoch=1
        )
        exhausted.status = "failed"
        exhausted.attempts = 3
        await session.commit()
        await job_service.recover_jobs(session, settings)
        rows = {row.id: row.status for row in (await session.scalars(select(PostJob))).all()}
        assert rows[running.id] == "pending"
        assert rows[failed.id] == "pending"
        assert rows[exhausted.id] == "failed"
    await engine.dispose()


@pytest.mark.asyncio
async def test_drain_executes_pending_jobs_fifo(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    ids = await add_messages(factory, 4)
    settings = Settings()
    async with factory() as session:
        await job_service.enqueue_job(session, job_service.JOB_SUMMARY, ids[0], ids[1], epoch=1)
        await job_service.enqueue_job(session, job_service.JOB_SUMMARY, ids[2], ids[3], epoch=1)
    executed = await job_service.drain_pending_jobs(factory, FakeClient(), settings, asyncio.Lock())
    assert executed == 2
    async with factory() as session:
        statuses = [row.status for row in (await session.scalars(select(PostJob))).all()]
        assert statuses == ["done", "done"]
    await engine.dispose()


@pytest.mark.asyncio
async def test_pipeline_status_shape(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    ids = await add_messages(factory, 3)
    async with factory() as session:
        await job_service.enqueue_job(session, job_service.JOB_SUMMARY, ids[0], ids[1], epoch=1)
        status = await job_service.pipeline_status(session)
        assert status == {
            "epoch": 1,
            "summarized_until_message_id": None,
            "unsummarized_messages": 3,
            "pending_jobs": 1,
            "running_jobs": 0,
        }
    await engine.dispose()
