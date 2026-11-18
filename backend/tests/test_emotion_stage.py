import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import Settings
from app.database.models import CharacterState, Memory
from app.database.session import create_engine, initialize_database
from app.services.emotion_service import _EMOTION_SYSTEM_PROMPT, analyze_emotion
from app.services.memory_store import DeliveredMemory

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)


class FakeClient:
    def __init__(self, content: str) -> None:
        self.requests: list[dict] = []

        async def create(**kwargs: object) -> SimpleNamespace:
            self.requests.append(kwargs)
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(message=SimpleNamespace(content=content, tool_calls=None))
                ],
                usage=SimpleNamespace(total_tokens=10),
            )

        self.chat = SimpleNamespace(completions=SimpleNamespace(create=create))


def make_state() -> CharacterState:
    return CharacterState(emotion="neutral", intensity=0.0, mood="neutral", affinity=50)


def memory_row(content: str, memory_id: int) -> Memory:
    row = Memory(
        content=content,
        category="state",
        importance=3,
        status="active",
        is_active=True,
        provenance="explicit",
        keywords=[],
        specific_terms=[],
        provisional=False,
        source_type="conversation",
    )
    row.id = memory_id
    return row


@pytest.mark.asyncio
async def test_emotion_input_excludes_undisclosed_content_and_summary(
    tmp_path: Path,
) -> None:
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / 'emotion.db'}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)
    client = FakeClient(
        json.dumps(
            {
                "emotion": {
                    "primary": "happy",
                    "intensity": 0.5,
                    "secondary": None,
                    "secondary_intensity": 0.0,
                    "mood": "明るい",
                },
                "affinity": {"delta": 1, "reason": "楽しそうだった"},
            }
        )
    )
    disclosed = DeliveredMemory(memory_row("紅茶が好き", 1), "hit")
    analysis = await analyze_emotion(
        client,
        Settings(),
        "今日は楽しかった",
        make_state(),
        [],
        latest=[disclosed],
        notification={"terms": ["ピアノ"]},
        session_factory=factory,
        message_id=1,
        now=NOW,
    )
    assert analysis is not None
    assert analysis.emotion.primary == "happy"
    assert len(client.requests) == 1
    prompt = json.dumps(client.requests[0]["messages"], ensure_ascii=False)
    # Only what passed the disclosure gate is in the input: the
    # disclosed memory and the notification *terms* — never a
    # forgotten row's content, and never the conversation summary.
    assert "紅茶が好き" in prompt
    assert "ピアノ" in prompt
    assert "何か忘れていることがあります" in prompt
    assert "会話要約" not in prompt
    assert "現在の状態:" in prompt
    assert "好感度=50" in prompt
    await engine.dispose()


@pytest.mark.asyncio
async def test_emotion_failure_returns_none(tmp_path: Path) -> None:
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / 'emotion2.db'}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)

    async def create(**kwargs: object) -> SimpleNamespace:
        raise RuntimeError("down")

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    analysis = await analyze_emotion(
        client,
        Settings(),
        "こんにちは",
        make_state(),
        [],
        session_factory=factory,
        message_id=1,
        now=NOW,
    )
    assert analysis is None
    await engine.dispose()


def test_emotion_prompt_requires_japanese_mood_and_reason() -> None:
    assert "mood と reason は日本語で書いてください" in _EMOTION_SYSTEM_PROMPT


def test_emotion_prompt_treats_abuse_as_an_anger_trigger() -> None:
    assert "怒り（angry）の明確なきっかけとして扱ってください" in _EMOTION_SYSTEM_PROMPT


@pytest.mark.asyncio
async def test_emotion_prompt_requires_neutral_mood_and_output_is_normalized(
    tmp_path: Path,
) -> None:
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / 'emotion_mood.db'}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)
    client = FakeClient(
        json.dumps(
            {
                "emotion": {
                    "primary": "embarrassed",
                    "intensity": 0.5,
                    "secondary": None,
                    "secondary_intensity": 0.0,
                    "mood": "「あたし、ドキドキしちゃう…！」",
                },
                "affinity": {"delta": 0, "reason": "照れた様子だった"},
            }
        )
    )
    analysis = await analyze_emotion(
        client,
        Settings(),
        "ありがとう",
        make_state(),
        [],
        session_factory=factory,
        message_id=1,
        now=NOW,
    )
    assert analysis is not None
    system = client.requests[0]["messages"][0]["content"]
    assert "セリフとして書いては" in system
    assert "中立的" in system
    assert analysis.emotion.mood == "あたし、ドキドキしちゃう…！"
    await engine.dispose()
