from typing import Any, Literal

from pydantic import BaseModel

from app.schemas.state import CharacterStateResponse, StateAnalysis


class MessageStartData(BaseModel):
    message_id: int


class TokenData(BaseModel):
    content: str


class UsageData(BaseModel):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class MessageEndData(BaseModel):
    message_id: int


class ErrorData(BaseModel):
    code: Literal["generation_failed"]


class HTTPErrorData(BaseModel):
    code: str


SSE_EVENT_SCHEMAS: dict[str, dict[str, Any]] = {
    "message_start": MessageStartData.model_json_schema(),
    "token": TokenData.model_json_schema(),
    "usage": UsageData.model_json_schema(),
    "state_analysis": StateAnalysis.model_json_schema(),
    "character_state": CharacterStateResponse.model_json_schema(),
    "message_end": MessageEndData.model_json_schema(),
    "error": ErrorData.model_json_schema(),
}


class APIError(BaseModel):
    detail: HTTPErrorData
