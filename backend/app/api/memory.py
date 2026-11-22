from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.models import Memory
from app.database.session import get_db
from app.schemas.memory import MemoryPage, MemoryResponse
from app.services.memory_lifecycle import STATUS_ACTIVE, STATUS_FORGOTTEN
from app.services.memory_store import search_memories_simple

router = APIRouter(prefix="/api/memories", tags=["memories"])

MemoryStatusFilter = Literal["all", "active", "forgotten"]


@router.get("", response_model=MemoryPage)
async def list_memories(
    status: MemoryStatusFilter = "active",
    limit: int = Query(default=50, ge=1, le=100),
    before_id: int | None = Query(default=None, ge=1),
    session: AsyncSession = Depends(get_db),
) -> MemoryPage:
    """One page of memories, highest id first.

    Written only by the front stage. There is no create, edit, or
    delete route, and no second query that prepends forgotten rows:
    ``status`` is the whole filter.
    """
    statement = select(Memory).order_by(Memory.id.desc())
    if before_id is not None:
        statement = statement.where(Memory.id < before_id)
    if status == STATUS_ACTIVE:
        statement = statement.where(Memory.status == STATUS_ACTIVE)
    elif status == STATUS_FORGOTTEN:
        statement = statement.where(Memory.status == STATUS_FORGOTTEN)
    rows = list((await session.scalars(statement.limit(limit + 1))).all())
    has_more = len(rows) > limit
    return MemoryPage(
        memories=[MemoryResponse.model_validate(row) for row in rows[:limit]],
        has_more=has_more,
    )


# Registered before /{memory_id} so the literal path is not parsed as an id.
@router.get("/search", response_model=list[MemoryResponse])
async def search_memories(
    query: str = Query(min_length=1, max_length=500),
    status: MemoryStatusFilter = "active",
    limit: int = Query(default=50, ge=1, le=100),
    session: AsyncSession = Depends(get_db),
) -> list[Memory]:
    """Relevance order, one shot.

    The search engine only — not ``agent_search`` — so recall,
    restore, and access stamps do not run. ``limit`` is passed
    through unchanged.
    """
    return await search_memories_simple(session, query, limit, status=status)


@router.get("/{memory_id}", response_model=MemoryResponse)
async def get_memory(memory_id: int, session: AsyncSession = Depends(get_db)) -> Memory:
    memory = await session.get(Memory, memory_id)
    if memory is None:
        raise HTTPException(status_code=404, detail={"code": "memory_not_found"})
    return memory
