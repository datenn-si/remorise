from typing import Any

from pydantic import BaseModel, Field

from app.schemas.state import Emotion


class InitialState(BaseModel):
    emotion: Emotion = "neutral"
    intensity: float = Field(default=0.0, ge=0.0, le=1.0)
    mood: str = "neutral"
    affinity: int = Field(default=50, ge=0, le=200)


class CharacterConfig(BaseModel):
    name: str
    profile: str = ""
    personality: list[str] = Field(default_factory=list)
    speech_style: str = ""
    sentence_endings: str = ""
    first_person: str = "私"
    second_person: str = "あなた"
    relationship: str = ""
    background: str = ""
    gender: str = ""
    birthday: str = ""
    appearance: str = ""
    theme_hue: float | None = Field(default=None, ge=0.0, le=360.0)
    initial_state: InitialState = Field(default_factory=InitialState)
    extra_settings: dict[str, Any] = Field(default_factory=dict)
