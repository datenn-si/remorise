import asyncio
import logging
from typing import Any

from openai import AsyncOpenAI
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.database.models import ConversationMeta, Message, PostJob, Summary, utc_now
from app.services import memory_lifecycle, raw_log_service, retention_service, summary_service
from app.services.context_manager import count_tokens
from app.services.inference_status import BACKGROUND_RETENTION, InferenceActivity

logger = logging.getLogger(__name__)

JOB_SUMMARY = "summary"


async def get_meta(session: AsyncSession) -> ConversationMeta:
    meta = await session.get(ConversationMeta, 1)
    if meta is None:
        meta = ConversationMeta(id=1)
        session.add(meta)
        await session.commit()
        await session.refresh(meta)
    return meta


async def enqueue_job(
    session: AsyncSession,
    kind: str,
    start_message_id: int,
    end_message_id: int,
    epoch: int,
) -> PostJob:
    """Register a post-processing job, deduplicated by (kind, epoch, range)."""
    existing = await session.scalar(
        select(PostJob).where(
            PostJob.kind == kind,
            PostJob.conversation_epoch == epoch,
            PostJob.start_message_id == start_message_id,
            PostJob.end_message_id == end_message_id,
        )
    )
    if existing is not None:
        return existing
    job = PostJob(
        kind=kind,
        start_message_id=start_message_id,
        end_message_id=end_message_id,
        conversation_epoch=epoch,
        status="pending",
    )
    session.add(job)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        existing = await session.scalar(
            select(PostJob).where(
                PostJob.kind == kind,
                PostJob.conversation_epoch == epoch,
                PostJob.start_message_id == start_message_id,
                PostJob.end_message_id == end_message_id,
            )
        )
        if existing is None:
            raise
        return existing
    await session.refresh(job)
    return job


async def maybe_enqueue_summary(session: AsyncSession, settings: Settings) -> PostJob | None:
    """Enqueue a summary job when the unsummarized context has grown.

    Summarization is a background job (spec §11): the
    check runs on the worker, with headroom (the summary ratio), and
    a turn never waits for the result — it builds its context from
    the previous settled summary plus the unsummarized tail. Facts
    are already in long-term memory by the time a range is summarized
    (stage A writes them in real time), so no extraction has to
    precede a summary any more.
    """
    summary = await session.scalar(
        select(Summary)
        .where(Summary.active.is_(True), Summary.archived_at.is_(None))
        .order_by(Summary.id.desc())
    )
    covered_until = summary.end_message_id if summary else 0
    rows = list(
        (
            await session.scalars(
                select(Message)
                .where(Message.archived_at.is_(None), Message.id > covered_until)
                .order_by(Message.id.asc())
            )
        ).all()
    )
    protected = (
        rows[-settings.summary_protected_messages :]
        if settings.summary_protected_messages > 0
        else []
    )
    candidates = rows[: len(rows) - len(protected)] if protected else rows
    if not candidates:
        return None
    serialized = (
        (summary.content if summary else "")
        + "\n"
        + "\n".join(f"{row.role}: {row.content}" for row in rows)
    )
    context_size = await count_tokens(serialized, settings)
    if context_size >= int(settings.llm_context_size * settings.context_warning_ratio):
        logger.warning("Conversation context is approaching its configured limit")
    if context_size < int(settings.llm_context_size * settings.context_summary_ratio):
        return None
    meta = await get_meta(session)
    return await enqueue_job(session, JOB_SUMMARY, candidates[0].id, candidates[-1].id, meta.epoch)


async def pipeline_status(session: AsyncSession) -> dict[str, Any]:
    meta = await get_meta(session)
    summary = await session.scalar(
        select(Summary)
        .where(Summary.active.is_(True), Summary.archived_at.is_(None))
        .order_by(Summary.id.desc())
    )
    covered_until = summary.end_message_id if summary else None
    unsummarized = await session.scalar(
        select(func.count(Message.id)).where(
            Message.archived_at.is_(None),
            Message.id > (covered_until or 0),
        )
    )
    pending = await session.scalar(
        select(func.count(PostJob.id)).where(PostJob.status == "pending")
    )
    running = await session.scalar(
        select(func.count(PostJob.id)).where(PostJob.status == "running")
    )
    return {
        "epoch": meta.epoch,
        "summarized_until_message_id": covered_until,
        "unsummarized_messages": int(unsummarized or 0),
        "pending_jobs": int(pending or 0),
        "running_jobs": int(running or 0),
    }


async def recover_jobs(session: AsyncSession, settings: Settings) -> None:
    jobs = list(
        (
            await session.scalars(select(PostJob).where(PostJob.status.in_(("running", "failed"))))
        ).all()
    )
    changed = False
    for job in jobs:
        if job.status == "running" or job.attempts < settings.job_max_attempts:
            job.status = "pending"
            job.updated_at = utc_now()
            changed = True
    if changed:
        await session.commit()


async def execute_job(
    session_factory: async_sessionmaker[AsyncSession],
    client: AsyncOpenAI,
    settings: Settings,
    job_id: int,
) -> bool:
    """Execute one job. Callers must hold the shared inference lock.

    Returns True when the job completed (including stale-epoch skips).
    """
    async with session_factory() as session:
        job = await session.get(PostJob, job_id)
        if job is None or job.status == "done":
            return True
        meta = await get_meta(session)
        if job.conversation_epoch != meta.epoch:
            # State-affecting work enqueued under an older conversation
            # generation must not apply to a conversation whose message
            # ids may overlap.
            job.status = "done"
            job.error = "stale_epoch"
            job.updated_at = utc_now()
            await session.commit()
            return True
        job.status = "running"
        job.attempts += 1
        job.updated_at = utc_now()
        await session.commit()
        kind, start_id, end_id = job.kind, job.start_message_id, job.end_message_id

    success = False
    error: str | None = None
    try:
        async with session_factory() as session:
            if kind == JOB_SUMMARY:
                success = await summary_service.summarize_range(
                    session, client, settings, start_id, end_id, job_id=job_id
                )
            else:
                error = f"unknown_job_kind:{kind}"
    except Exception as exc:  # noqa: BLE001 - job failures must not kill the worker
        logger.exception("Post-processing job %s failed", job_id)
        error = str(exc)

    async with session_factory() as session:
        job = await session.get(PostJob, job_id)
        if job is None:
            return success
        if success:
            job.status = "done"
            job.error = None
        else:
            job.status = "failed"
            job.error = error or "job_failed"
        job.updated_at = utc_now()
        await session.commit()
    return success


async def drain_pending_jobs(
    session_factory: async_sessionmaker[AsyncSession],
    client: AsyncOpenAI,
    settings: Settings,
    inference_lock: asyncio.Lock,
    activity: InferenceActivity | None = None,
) -> int:
    tracker = activity if activity is not None else InferenceActivity()
    executed = 0
    while True:
        async with session_factory() as session:
            row = (
                await session.execute(
                    select(PostJob.id, PostJob.kind)
                    .where(PostJob.status == "pending")
                    .order_by(PostJob.created_at.asc(), PostJob.id.asc())
                    .limit(1)
                )
            ).first()
        if row is None:
            return executed
        job_id, job_kind = row
        async with inference_lock, tracker.background(job_kind):
            await execute_job(session_factory, client, settings, job_id)
        executed += 1


async def purge_expired_archives(
    session: AsyncSession, settings: Settings, now: Any = None
) -> tuple[int, int]:
    from datetime import timedelta

    if settings.archive_retention_days <= 0:
        return 0, 0
    cutoff = (now or utc_now()) - timedelta(days=settings.archive_retention_days)
    messages = await session.execute(
        delete(Message).where(Message.archived_at.is_not(None), Message.archived_at < cutoff)
    )
    summaries = await session.execute(
        delete(Summary).where(Summary.archived_at.is_not(None), Summary.archived_at < cutoff)
    )
    await session.commit()
    return messages.rowcount or 0, summaries.rowcount or 0


async def worker_loop(app: Any) -> None:
    """Single background worker: FIFO jobs, retention, and archive purge.

    Every LLM call made here runs under the shared inference lock, so a
    background inference is never concurrent with (and is never interrupted
    by) a foreground chat generation; the next turn simply waits.
    """
    settings: Settings = app.state.settings
    session_factory = app.state.session_factory
    client: AsyncOpenAI = app.state.llm_client
    inference_lock: asyncio.Lock = app.state.inference_lock
    activity: InferenceActivity = app.state.inference_activity
    notify: asyncio.Event = app.state.job_notify
    while True:
        try:
            async with session_factory() as session:
                await recover_jobs(session, settings)
                await maybe_enqueue_summary(session, settings)
            await drain_pending_jobs(
                session_factory, client, settings, inference_lock, activity=activity
            )
            async with inference_lock, activity.background(BACKGROUND_RETENTION):
                async with session_factory() as session:
                    await retention_service.process_expired_logs(session, settings)
                    await purge_expired_archives(session, settings)
                    await raw_log_service.purge_expired_raw_logs(session, settings)
                    await memory_lifecycle.apply_memory_decay(session, settings)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Post-processing worker cycle failed")
        try:
            await asyncio.wait_for(notify.wait(), timeout=settings.job_poll_interval_seconds)
        except TimeoutError:
            pass
        notify.clear()
