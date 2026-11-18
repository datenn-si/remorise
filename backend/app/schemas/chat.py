from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=20_000)


class MessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    role: str
    content: str
    tool_calls: list[dict[str, Any]] | None
    tool_call_id: str | None
    metadata: dict[str, Any] | None = Field(validation_alias="metadata_json")
    created_at: datetime
    # True when the row has been invalidated by the retention policy
    # (only ever returned when the caller asked for archived rows).
    archived: bool = False


class HistoryResponse(BaseModel):
    messages: list[MessageResponse]
    # True when older messages exist beyond this page (fetch them
    # with before_id set to the oldest returned message id).
    has_more: bool = False


class InferenceStatusResponse(BaseModel):
    """Who is using the shared inference lock right now (in-memory state).

    ``active`` is ``"background"`` while a post-processing job or the
    worker's housekeeping pass holds the lock, ``"foreground"`` while a
    chat turn holds it, and ``null`` when inference is idle.
    ``foreground_waiting`` marks a chat turn queued behind background
    work. The normal chat UI polls this to show the character as
    thinking instead of leaving a send looking silently stuck.
    ``foreground_phase`` is the running foreground turn's presentation
    phase (``"thinking"`` until its first visible token, then
    ``"speaking"``), so a UI that is not streaming the turn itself can
    still present it correctly.
    """

    active: Literal["foreground", "background"] | None
    background_kind: str | None
    foreground_waiting: bool
    foreground_phase: Literal["thinking", "speaking"] | None = None
