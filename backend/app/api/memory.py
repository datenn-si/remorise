from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.models import Memory
from app.database.session import get_db
from app.schemas.memory import MemoryResponse
from app.services.memory_store import search_memories_simple

router = APIRouter(prefix="/api/memories", tags=["memories"])


@router.get("", response_model=list[MemoryResponse])
async def list_memories(
    query: str | None = Query(default=None, max_length=500),
    include_inactive: bool = False,
    limit: int = Query(default=50, ge=1, le=100),
    session: AsyncSession = Depends(get_db),
) -> list[Memory]:
    """Read-only memory list (spec §17).

    Memories are written only by the front-stage memory processing;
    there is deliberately no create, edit, or delete endpoint here.
    """
    if query:
        results = await search_memories_simple(session, query, limit)
        if include_inactive:
            known = {row.id for row in results}
            inactive = list(
                (
                    await session.scalars(
                        select(Memory)
                        .where(
                            Memory.is_active.is_(False),
                            Memory.content.ilike(f"%{query}%"),
                        )
                        .limit(limit)
                    )
                ).all()
            )
            return inactive + [row for row in results if row.id not in known]
        return results
    statement = select(Memory).order_by(Memory.last_reinforced_at.desc()).limit(limit)
    if not include_inactive:
        statement = statement.where(Memory.is_active.is_(True))
    return list((await session.scalars(statement)).all())


@router.get("/{memory_id}", response_model=MemoryResponse)
async def get_memory(memory_id: int, session: AsyncSession = Depends(get_db)) -> Memory:
    memory = await session.get(Memory, memory_id)
    if memory is None:
        raise HTTPException(status_code=404, detail={"code": "memory_not_found"})
    return memory
