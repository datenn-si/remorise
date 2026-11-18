import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.database.models import Message, Summary, utc_now

logger = logging.getLogger(__name__)


async def invalidate_summaries_with_archived_ranges(session: AsyncSession) -> int:
    """Invalidate summaries whose covered range has fully left the conversation.

    A summary is invalidated once every message in its range is archived
    (or physically gone): it then stops serving the context and is never
    reactivated. Superseded summaries follow the same rule — being
    replaced is a context matter, invalidation is the forgetting axis,
    and the two stay separate. Returns how many summaries were
    invalidated.
    """
    summaries = list(
        (await session.scalars(select(Summary).where(Summary.archived_at.is_(None)))).all()
    )
    invalidated = 0
    archived_at = utc_now()
    for summary in summaries:
        remaining = await session.scalar(
            select(Message.id)
            .where(
                Message.id >= summary.start_message_id,
                Message.id <= summary.end_message_id,
                Message.archived_at.is_(None),
            )
            .limit(1)
        )
        if remaining is None:
            summary.archived_at = archived_at
            summary.active = False
            invalidated += 1
    if invalidated:
        await session.commit()
    return invalidated


async def process_expired_logs(session: AsyncSession, settings: Settings) -> None:
    """Archive expired messages and invalidate summaries left behind.

    Archiving is the forgetting axis: a message leaves the displayed
    history only because its retention period expired. Facts reach
    long-term memory in real time through the front stage, so
    archiving has no extraction precondition, and summarization is
    not one either (the two axes stay separate: summarization never
    hides messages).
    """
    cutoff = datetime.now(UTC) - timedelta(days=settings.raw_log_retention_days)
    expired = list(
        (
            await session.scalars(
                select(Message)
                .where(Message.created_at < cutoff, Message.archived_at.is_(None))
                .order_by(Message.id.asc())
            )
        ).all()
    )
    if expired:
        try:
            archived_at = utc_now()
            for row in expired:
                row.archived_at = archived_at
            await session.commit()
        except Exception:
            logger.exception("Expired conversation log archiving failed; keeping the logs")
            await session.rollback()
    await invalidate_summaries_with_archived_ranges(session)
