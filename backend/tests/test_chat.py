import asyncio
from collections.abc import AsyncIterator
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from openai import APIConnectionError
from sqlalchemy import select

from app.api import chat
from app.config import Settings
from app.database.models import CharacterState, Message, StateHistory
from app.main import create_app
from app.schemas.state import StateAnalysis
from app.services.memory_agent import AgentResult
from app.services.memory_store import TurnContext


class FakeStream:
    def __init__(self, chunks: list[str] | None = None) -> None:
        self.chunks = chunks if chunks is not None else ["Hel", "lo"]

    def __aiter__(self) -> AsyncIterator[SimpleNamespace]:
        async def generate() -> AsyncIterator[SimpleNamespace]:
            for text in self.chunks:
                yield SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content=text, tool_calls=None))]
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


async def fake_agent(*args: object, **kwargs: object) -> AgentResult:
    settings = kwargs.get("settings") or args[2]
    source_date = kwargs.get("source_date")
    return AgentResult(ctx=TurnContext(settings=settings, source_date=source_date))


def emotion_fake(delta: int = 0, result: StateAnalysis | None = None):
    async def fake(*args: object, **kwargs: object) -> StateAnalysis | None:
        return result if result is not None else make_analysis(delta)

    return fake


async def ok_completion(*args: object, **kwargs: object) -> FakeStream:
    return FakeStream()


async def unavailable(*args: object, **kwargs: object) -> None:
    raise APIConnectionError(
        message="llama.cpp unavailable",
        request=httpx.Request("POST", "http://llama/v1/chat/completions"),
    )


def patch_turn(
    monkeypatch: pytest.MonkeyPatch,
    completion: object = ok_completion,
    *,
    agent: object = fake_agent,
    emotion: object = None,
) -> None:
    monkeypatch.setattr(chat, "run_memory_agent", agent)
    monkeypatch.setattr(chat, "analyze_emotion", emotion or emotion_fake())
    monkeypatch.setattr(chat, "start_completion", completion)


def make_app(tmp_path: Path, name: str = "chat.db"):
    return create_app(Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / name}"))


@pytest.mark.asyncio
async def test_chat_streams_events_and_persists_the_turn(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    patch_turn(monkeypatch, emotion=emotion_fake(delta=2))
    app = make_app(tmp_path)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post("/api/chat", json={"message": "こんにちは"})
            assert response.status_code == 200
            for event in (
                "event: message_start",
                "event: state_analysis",
                "event: character_state",
                "event: token",
                "event: message_end",
            ):
                assert event in response.text
            assert "event: tool_start" not in response.text
            assert "event: tool_end" not in response.text

            history = (await client.get("/api/chat/history")).json()["messages"]
            assert [row["role"] for row in history] == ["user", "assistant"]
            assert history[1]["content"] == "Hello"
            metadata = history[1]["metadata"]["memory_search"]
            assert set(metadata) == {
                "searches",
                "disclosed",
                "recalled_ids",
                "restored_ids",
                "created_ids",
                "notification_terms",
                "ask_back_ids",
            }
            state = (await client.get("/api/character/state")).json()
            assert state["affinity"] == 52


@pytest.mark.asyncio
async def test_emotion_failure_leaves_state_unchanged_and_turn_succeeds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def no_emotion(*args: object, **kwargs: object) -> None:
        return None

    patch_turn(monkeypatch, emotion=no_emotion)
    app = make_app(tmp_path)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post("/api/chat", json={"message": "Hi"})
            assert response.status_code == 200
            assert "event: message_end" in response.text
            history = (await client.get("/api/chat/history")).json()["messages"]
            assert [row["role"] for row in history] == ["user", "assistant"]
            state = (await client.get("/api/character/state")).json()
            assert state["affinity"] == 50
        async with app.state.session_factory() as session:
            assert (await session.scalars(select(StateHistory))).all() == []


@pytest.mark.asyncio
async def test_generation_prompt_always_carries_the_current_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, object] = {}

    async def capturing_completion(
        client: object, settings: object, messages: object
    ) -> FakeStream:
        captured["messages"] = messages
        return FakeStream()

    patch_turn(monkeypatch, capturing_completion)
    app = make_app(tmp_path)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post("/api/chat", json={"message": "今何時？"})
            assert response.status_code == 200
    messages = captured["messages"]
    assert isinstance(messages, list) and messages
    assert messages[0]["role"] == "system"
    assert "現在日時:" in messages[0]["content"]


@pytest.mark.asyncio
async def test_generation_failure_leaves_a_dangling_turn(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    patch_turn(monkeypatch, unavailable, emotion=emotion_fake(delta=3))
    app = make_app(tmp_path)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post("/api/chat", json={"message": "こんにちは"})
            assert response.status_code == 503
            history = (await client.get("/api/chat/history")).json()["messages"]
            assert [row["role"] for row in history] == ["user"]
        async with app.state.session_factory() as session:
            state = await session.get(CharacterState, 1)
            assert state is not None and state.affinity == 53
            messages = (await session.scalars(select(Message))).all()
            assert len(messages) == 1


@pytest.mark.asyncio
async def test_second_send_while_generating_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    gate = asyncio.Event()
    entered = asyncio.Event()

    class GatedStream(FakeStream):
        def __aiter__(self) -> AsyncIterator[SimpleNamespace]:
            async def generate() -> AsyncIterator[SimpleNamespace]:
                yield SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content="Hel", tool_calls=None))]
                )
                entered.set()
                await gate.wait()
                yield SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content="lo", tool_calls=None))]
                )

            return generate()

    async def gated_completion(*args: object, **kwargs: object) -> GatedStream:
        return GatedStream()

    patch_turn(monkeypatch, gated_completion)
    app = make_app(tmp_path)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            first = asyncio.create_task(client.post("/api/chat", json={"message": "Hi"}))
            await asyncio.wait_for(entered.wait(), timeout=10)
            second = await client.post("/api/chat", json={"message": "Again"})
            assert second.status_code == 409
            assert second.json()["detail"]["code"] == "generation_in_progress"
            gate.set()
            response = await asyncio.wait_for(first, timeout=10)
            assert response.status_code == 200
