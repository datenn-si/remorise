"""Raw LLM call logging (v2 §7).

Every LLM call — the memory agent, the emotion analysis, the main
generation, summarization — leaves one row in ``llm_raw_logs`` with the request that was
sent and the raw response text that came back (or the error). Recording is
best-effort: a logging failure is swallowed with a warning and never breaks
the conversation or the job that made the call.

Expiry: a row becomes purgeable after ``raw_log_retention_days`` once
the work it belongs to has completed — for job-produced rows, the job
is done; foreground rows carry no job and expire on age alone.
"""

import json
import logging
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.database.models import LlmRawLog, PostJob, utc_now

logger = logging.getLogger(__name__)

KIND_MEMORY_AGENT = "memory_agent"
KIND_EMOTION = "emotion"
KIND_CHAT = "chat"
KIND_SUMMARY = "summary"


def serialize_request(messages: Any, **extra: Any) -> str:
    payload: dict[str, Any] = {"messages": messages}
    payload.update(extra)
    return json.dumps(payload, ensure_ascii=False, default=str)


def factory_from_session(
    session: AsyncSession,
) -> async_sessionmaker[AsyncSession]:
    """Derive a session factory sharing the given session's engine.

    Raw logs are written through a separate session so a caller-side
    rollback (e.g. a failed extraction parse) cannot discard the record of
    what the model actually returned. Note: ``session.bind`` is the
    AsyncEngine; ``get_bind()`` would hand back the sync engine instead.
    """
    return async_sessionmaker(bind=session.bind, expire_on_commit=False)


async def record_raw_log(
    session_factory: async_sessionmaker[AsyncSession] | None,
    *,
    kind: str,
    request: str,
    response: str | None = None,
    error: str | None = None,
    message_id: int | None = None,
    job_id: int | None = None,
    start_message_id: int | None = None,
    end_message_id: int | None = None,
) -> None:
    """Best-effort insert of one raw log row. Never raises."""
    if session_factory is None:
        return
    try:
        async with session_factory() as session:
            session.add(
                LlmRawLog(
                    kind=kind,
                    request=request,
                    response=response,
                    error=error,
                    message_id=message_id,
                    job_id=job_id,
                    start_message_id=start_message_id,
                    end_message_id=end_message_id,
                )
            )
            await session.commit()
    except Exception:
        logger.warning("Failed to record raw LLM log (kind=%s)", kind, exc_info=True)


def format_error(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"


async def purge_expired_raw_logs(
    session: AsyncSession, settings: Settings, now: datetime | None = None
) -> int:
    if settings.raw_log_retention_days <= 0:
        return 0
    cutoff = (now or utc_now()) - timedelta(days=settings.raw_log_retention_days)
    rows = list(
        (await session.scalars(select(LlmRawLog).where(LlmRawLog.created_at < cutoff))).all()
    )
    if not rows:
        return 0
    job_ids = {row.job_id for row in rows if row.job_id is not None}
    jobs: dict[int, PostJob] = {}
    if job_ids:
        jobs = {
            job.id: job
            for job in (await session.scalars(select(PostJob).where(PostJob.id.in_(job_ids)))).all()
        }
    deleted = 0
    for row in rows:
        if row.job_id is not None:
            job = jobs.get(row.job_id)
            if job is None or job.status != "done":
                continue
        await session.delete(row)
        deleted += 1
    if deleted:
        await session.commit()
    return deleted
