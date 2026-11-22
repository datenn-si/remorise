import logging

from openai import AsyncOpenAI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.database.models import Message, Summary
from app.llm.client import summarize_text
from app.services import raw_log_service
from app.services.context_budget import with_model_count
from app.services.context_manager import count_tokens

logger = logging.getLogger(__name__)


async def summarize_range(
    session: AsyncSession,
    client: AsyncOpenAI,
    settings: Settings,
    start_message_id: int,
    end_message_id: int,
    job_id: int | None = None,
) -> bool:
    """Summarize an explicit message range (summary job execution).

    Merges the range into the active summary. Returns False without
    changing anything when the summarization itself fails, so the job
    can be retried later. Summarization is a context-only concern: it
    never hides messages (display is governed by forgetting alone),
    and it needs no extraction to precede it — stage A writes facts
    into long-term memory in real time, before any summary runs.
    """
    rows = list(
        (
            await session.scalars(
                select(Message)
                .where(Message.id >= start_message_id, Message.id <= end_message_id)
                .order_by(Message.id.asc())
            )
        ).all()
    )
    if not rows:
        return True
    current_summary = await session.scalar(
        select(Summary)
        .where(Summary.active.is_(True), Summary.archived_at.is_(None))
        .order_by(Summary.id.desc())
    )
    text = "\n".join(f"{row.role}: {row.content}" for row in rows)
    try:
        summary_text = await summarize_text(
            client,
            settings,
            text,
            current_summary.content if current_summary else "",
            session_factory=raw_log_service.factory_from_session(session),
            job_id=job_id,
            start_message_id=start_message_id,
            end_message_id=end_message_id,
        )
    except Exception:
        logger.exception("Summary job failed; preserving message history")
        await session.rollback()
        return False
    if not summary_text.strip():
        return False
    if current_summary:
        current_summary.active = False
    counted = await count_tokens(summary_text, settings)
    session.add(
        Summary(
            content=summary_text,
            token=with_model_count(None, settings.llm_model, counted),
            start_message_id=min(
                rows[0].id, current_summary.start_message_id if current_summary else rows[0].id
            ),
            end_message_id=max(
                rows[-1].id, current_summary.end_message_id if current_summary else rows[-1].id
            ),
            active=True,
        )
    )
    await session.commit()
    return True
