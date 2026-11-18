from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.chat import MessageResponse
from app.schemas.memory import MemoryResponse


class DebugMessageResponse(MessageResponse):
    archived: bool = False
    archived_at: datetime | None = None


class DebugSummaryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    content: str
    start_message_id: int
    end_message_id: int
    active: bool
    archived: bool = False
    archived_at: datetime | None
    created_at: datetime


class DebugHistoryResponse(BaseModel):
    messages: list[DebugMessageResponse]
    summaries: list[DebugSummaryResponse]


class PurgeResponse(BaseModel):
    purged_messages: int
    purged_summaries: int


class DebugMemoryResponse(MemoryResponse):
    """A memory row for the debug view (the response already carries
    the lifecycle fields — status, the recall/restoration bookkeeping,
    and the reinforcement stamp — so nothing extra is added here)."""


class DebugJobResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    start_message_id: int
    end_message_id: int
    conversation_epoch: int
    status: str
    attempts: int
    error: str | None
    result: dict[str, Any] | None = Field(default=None, validation_alias="result_json")
    created_at: datetime
    updated_at: datetime


class DebugPipelineResponse(BaseModel):
    epoch: int
    summarized_until_message_id: int | None
    unsummarized_messages: int
    pending_jobs: int
    running_jobs: int


class DebugRawLogResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    request: str
    response: str | None
    error: str | None
    message_id: int | None
    job_id: int | None
    start_message_id: int | None
    end_message_id: int | None
    created_at: datetime
