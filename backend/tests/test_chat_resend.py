from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from openai import APIConnectionError
from sqlalchemy import select

from app.api import chat
from app.config import Settings
from app.database.models import CharacterState, StateHistory
from app.main import create_app
from app.schemas.state import StateAnalysis
from app.services.memory_agent import AgentResult
from app.services.memory_store import TurnContext


class FakeStream:
    def __aiter__(self):
        async def generate():
            yield SimpleNamespace(
                choices=[SimpleNamespace(delta=SimpleNamespace(content="Hello", tool_calls=None))]
            )

        return generate()

    async def close(self) -> None:
        return None


def make_analysis(delta: int = 0) -> StateAnalysis:
    return StateAnalysis(
        emotion={
            "primary": "neutral",
            "intensity": 0.0,
            "secondary": None,
            "secondary_intensity": 0.0,
            "mood": "neutral",
        },
        affinity={"delta": delta, "reason": ""},
    )


async def ok_completion(*args: object, **kwargs: object) -> FakeStream:
    return FakeStream()


async def unavailable(*args: object, **kwargs: object) -> None:
    raise APIConnectionError(
        message="llama.cpp unavailable",
        request=httpx.Request("POST", "http://llama/v1/chat/completions"),
    )


def make_app(tmp_path: Path, name: str):
    return create_app(Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / name}"))


@pytest.mark.asyncio
async def test_resend_reuses_the_front_stage_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = {"agent": 0, "emotion": 0}

    async def counting_agent(*args: object, **kwargs: object) -> AgentResult:
        calls["agent"] += 1
        settings = kwargs.get("settings") or args[2]
        return AgentResult(
            ctx=TurnContext(settings=settings, source_date=kwargs.get("source_date"))
        )

    async def counting_emotion(*args: object, **kwargs: object) -> StateAnalysis:
        calls["emotion"] += 1
        return make_analysis(delta=3)

    monkeypatch.setattr(chat, "run_memory_agent", counting_agent)
    monkeypatch.setattr(chat, "analyze_emotion", counting_emotion)
    monkeypatch.setattr(chat, "start_completion", unavailable)
    app = make_app(tmp_path, "resend.db")
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            failed = await client.post("/api/chat", json={"message": "こんにちは"})
            assert failed.status_code == 503

            monkeypatch.setattr(chat, "start_completion", ok_completion)
            resent = await client.post("/api/chat/resend")
            assert resent.status_code == 200
            assert "event: message_end" in resent.text

            history = (await client.get("/api/chat/history")).json()["messages"]
            assert [row["role"] for row in history] == ["user", "assistant"]
            assert history[1]["content"] == "Hello"
            assert calls == {"agent": 1, "emotion": 1}
        async with app.state.session_factory() as session:
            state = await session.get(CharacterState, 1)
            assert state is not None and state.affinity == 53
            assert len((await session.scalars(select(StateHistory))).all()) == 1


@pytest.mark.asyncio
async def test_resend_retries_only_the_emotion_stage_when_it_never_applied(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = {"agent": 0, "emotion": 0}

    async def counting_agent(*args: object, **kwargs: object) -> AgentResult:
        calls["agent"] += 1
        settings = kwargs.get("settings") or args[2]
        return AgentResult(
            ctx=TurnContext(settings=settings, source_date=kwargs.get("source_date"))
        )

    async def failing_emotion(*args: object, **kwargs: object) -> None:
        calls["emotion"] += 1
        return None

    monkeypatch.setattr(chat, "run_memory_agent", counting_agent)
    monkeypatch.setattr(chat, "analyze_emotion", failing_emotion)
    monkeypatch.setattr(chat, "start_completion", unavailable)
    app = make_app(tmp_path, "resend-emotion.db")
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            failed = await client.post("/api/chat", json={"message": "こんにちは"})
            assert failed.status_code == 503
            state = (await client.get("/api/character/state")).json()
            assert state["affinity"] == 50

            async def working_emotion(*args: object, **kwargs: object) -> StateAnalysis:
                calls["emotion"] += 1
                return make_analysis(delta=3)

            monkeypatch.setattr(chat, "analyze_emotion", working_emotion)
            monkeypatch.setattr(chat, "start_completion", ok_completion)
            resent = await client.post("/api/chat/resend")
            assert resent.status_code == 200
            assert calls == {"agent": 1, "emotion": 2}
            state = (await client.get("/api/character/state")).json()
            assert state["affinity"] == 53
        async with app.state.session_factory() as session:
            assert len((await session.scalars(select(StateHistory))).all()) == 1


@pytest.mark.asyncio
async def test_resend_without_a_dangling_turn_is_a_conflict(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_agent(*args: object, **kwargs: object) -> AgentResult:
        settings = kwargs.get("settings") or args[2]
        return AgentResult(
            ctx=TurnContext(settings=settings, source_date=kwargs.get("source_date"))
        )

    async def fake_emotion(*args: object, **kwargs: object) -> StateAnalysis:
        return make_analysis()

    monkeypatch.setattr(chat, "run_memory_agent", fake_agent)
    monkeypatch.setattr(chat, "analyze_emotion", fake_emotion)
    monkeypatch.setattr(chat, "start_completion", ok_completion)
    app = make_app(tmp_path, "resend-none.db")
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resent = await client.post("/api/chat/resend")
            assert resent.status_code == 409
            assert resent.json()["detail"]["code"] == "no_dangling_turn"

            sent = await client.post("/api/chat", json={"message": "Hi"})
            assert sent.status_code == 200
            resent = await client.post("/api/chat/resend")
            assert resent.status_code == 409
            assert resent.json()["detail"]["code"] == "no_dangling_turn"
