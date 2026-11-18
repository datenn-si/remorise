from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Emotion = Literal[
    "neutral",
    "happy",
    "sad",
    "angry",
    "embarrassed",
    "surprised",
    "anxious",
    "affectionate",
    "puzzled",
]


class EmotionAnalysis(BaseModel):
    primary: Emotion
    intensity: float = Field(ge=0.0, le=1.0)
    secondary: Emotion | None = None
    secondary_intensity: float = Field(default=0.0, ge=0.0, le=1.0)
    mood: str = Field(min_length=1, max_length=100)


class AffinityAnalysis(BaseModel):
    delta: int = Field(strict=True, ge=-100, le=100)
    reason: str = Field(default="", max_length=1_000)


class StateAnalysis(BaseModel):
    model_config = ConfigDict(extra="forbid")

    emotion: EmotionAnalysis
    affinity: AffinityAnalysis


class CharacterStateResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    emotion: Emotion
    intensity: float = Field(ge=0.0, le=1.0)
    secondary_emotion: Emotion | None
    secondary_intensity: float = Field(ge=0.0, le=1.0)
    mood: str
    affinity: int
    last_emotion_update: datetime
    updated_at: datetime


class CharacterStateUpdate(BaseModel):
    emotion: Emotion | None = None
    intensity: float | None = Field(default=None, ge=0.0, le=1.0)
    secondary_emotion: Emotion | None = None
    secondary_intensity: float | None = Field(default=None, ge=0.0, le=1.0)
    mood: str | None = Field(default=None, min_length=1, max_length=100)
    affinity: int | None = Field(default=None, ge=0, le=200)
