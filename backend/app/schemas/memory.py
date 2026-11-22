from datetime import datetime

from pydantic import BaseModel, ConfigDict


class MemoryResponse(BaseModel):
    """One memory row in the period model (read-only API).

    Memories are written only by the front-stage memory processing;
    this API never creates, edits, or deletes them (spec §17: the
    management and debug surfaces are read-only in the redesign).
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    content: str
    category: str
    importance: int
    status: str
    is_active: bool
    provenance: str
    keywords: list[str] | None
    specific_terms: list[str] | None
    period_start: datetime | None
    period_end: datetime | None
    event_at: datetime | None
    provisional: bool
    source_type: str
    source_date: datetime | None
    created_at: datetime
    content_updated_at: datetime | None
    content_update_source_type: str | None
    content_update_provenance: str | None
    last_accessed_at: datetime | None
    last_recalled_at: datetime | None
    reactivation_count: int
    last_restored_at: datetime | None
    restoration_count: int
    last_reinforced_at: datetime


class MemoryPage(BaseModel):
    """One page of the memory list, highest id first.

    ``has_more`` is true when a smaller id than the last row still
    matches the filter. The next page takes ``before_id`` of that id.
    """

    memories: list[MemoryResponse]
    has_more: bool
