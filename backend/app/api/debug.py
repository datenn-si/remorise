from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.models import LlmRawLog, Memory, Message, PostJob, Summary
from app.database.session import get_db
from app.schemas.debug import (
    DebugHistoryResponse,
    DebugJobResponse,
    DebugMemoryResponse,
    DebugMessageResponse,
    DebugPipelineResponse,
    DebugRawLogResponse,
    DebugSummaryResponse,
    PurgeResponse,
)
from app.services import job_service

router = APIRouter(prefix="/api/debug", tags=["debug"])


@router.get("/history", response_model=DebugHistoryResponse)
async def get_debug_history(
    include_archived: bool = True,
    session: AsyncSession = Depends(get_db),
) -> DebugHistoryResponse:
    """Read-only view of conversation history, including archived rows.

    Archived messages and summaries never re-enter the active conversation;
    this endpoint exists only so the operator can inspect what the retention
    policy has archived.
    """
    message_statement = select(Message).order_by(Message.id.asc())
    summary_statement = select(Summary).order_by(Summary.id.asc())
    if not include_archived:
        message_statement = message_statement.where(Message.archived_at.is_(None))
        summary_statement = summary_statement.where(Summary.archived_at.is_(None))
    messages = (await session.scalars(message_statement)).all()
    summaries = (await session.scalars(summary_statement)).all()
    return DebugHistoryResponse(
        messages=[
            DebugMessageResponse.model_validate(row).model_copy(
                update={"archived": row.archived_at is not None}
            )
            for row in messages
        ],
        summaries=[
            DebugSummaryResponse.model_validate(row).model_copy(
                update={"archived": row.archived_at is not None}
            )
            for row in summaries
        ],
    )


@router.delete("/history/purge", response_model=PurgeResponse)
async def purge_archived_history(
    request: Request,
    through_message_id: int = Query(..., ge=1),
    session: AsyncSession = Depends(get_db),
) -> PurgeResponse:
    """Physically delete archived history up to a cutoff message id.

    The one write the debug API still allows (spec §17): only
    already-invalidated rows are removed — archived messages with
    ``id <= through_message_id``, and archived summaries whose
    covered range ends at or before it. Anything still active is
    never deleted, however old, and there is deliberately no way to
    delete a single picked item — removal is a prefix cut only.
    """
    if request.app.state.generation_lock.locked():
        raise HTTPException(status_code=409, detail={"code": "generation_in_progress"})
    messages = await session.execute(
        delete(Message).where(Message.archived_at.is_not(None), Message.id <= through_message_id)
    )
    summaries = await session.execute(
        delete(Summary).where(
            Summary.archived_at.is_not(None),
            Summary.end_message_id <= through_message_id,
        )
    )
    await session.commit()
    return PurgeResponse(
        purged_messages=messages.rowcount or 0,
        purged_summaries=summaries.rowcount or 0,
    )


@router.get("/memories", response_model=list[DebugMemoryResponse])
async def list_debug_memories(
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_db),
) -> list[Memory]:
    """All memories with their lifecycle fields, forgotten included.

    Ordered by last reinforcement, newest first (id breaks ties),
    and paged with ``limit`` / ``offset``: memories are never
    physically deleted, so the count has no upper bound and the
    whole list stays reachable. Read-only: the debug surface has
    no manual memory controls (pin / forget / reactivate / edit).
    """
    return list(
        (
            await session.scalars(
                select(Memory)
                .order_by(Memory.last_reinforced_at.desc(), Memory.id.desc())
                .limit(limit)
                .offset(offset)
            )
        ).all()
    )


@router.get("/jobs", response_model=list[DebugJobResponse])
async def list_jobs(
    limit: int = Query(default=50, ge=1, le=200),
    session: AsyncSession = Depends(get_db),
) -> list[PostJob]:
    """Recent post-processing jobs, newest first (read-only).

    Shows the queue state (``pending`` / ``running`` / ``done`` /
    ``failed``), the message range and conversation epoch each job
    covers, its attempts, and its last error. The only job kind is
    ``summary``.
    """
    return list(
        (await session.scalars(select(PostJob).order_by(PostJob.id.desc()).limit(limit))).all()
    )


@router.get("/pipeline", response_model=DebugPipelineResponse)
async def get_pipeline_status(
    session: AsyncSession = Depends(get_db),
) -> DebugPipelineResponse:
    return DebugPipelineResponse(**await job_service.pipeline_status(session))


@router.get("/raw-logs", response_model=list[DebugRawLogResponse])
async def list_raw_logs(
    kind: str | None = None,
    limit: int = 50,
    session: AsyncSession = Depends(get_db),
) -> list[LlmRawLog]:
    """Recent raw LLM call logs, newest first.

    Read-only diagnostics: what was actually sent to and returned by
    the model for the memory agent, the emotion analysis, the chat
    generation, and summarization. ``kind`` filters by call type;
    ``limit`` is clamped to 1..200.
    """
    statement = select(LlmRawLog).order_by(LlmRawLog.id.desc())
    if kind:
        statement = statement.where(LlmRawLog.kind == kind)
    statement = statement.limit(max(1, min(limit, 200)))
    return list((await session.scalars(statement)).all())
