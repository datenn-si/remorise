import asyncio
from collections.abc import AsyncIterator, Callable, Coroutine
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from openai import APIConnectionError
from sqlalchemy import select

from app.api import chat
from app.config import Settings
from app.database.models import CharacterState, StateHistory
from app.main import create_app
from app.schemas.state import StateAnalysis
from app.services.memory_agent import AgentResult
from app.services.memory_store import TurnContext

IDLE = {
    "active": None,
    "background_kind": None,
    "foreground_waiting": False,
    "foreground_phase": None,
}


def text_chunk(text: str) -> SimpleNamespace:
    return SimpleNamespace(
        choices=[SimpleNamespace(delta=SimpleNamespace(content=text, tool_calls=None))]
    )


class FakeStream:
    """A two-chunk stream that can pause between the chunks."""

    def __init__(
        self,
        gate: asyncio.Event | None = None,
        entered: asyncio.Event | None = None,
    ) -> None:
        self.gate = gate
        self.entered = entered

    def __aiter__(self) -> AsyncIterator[SimpleNamespace]:
        async def chunks() -> AsyncIterator[SimpleNamespace]:
            yield text_chunk("Hel")
            if self.entered is not None:
                self.entered.set()
            if self.gate is not None:
                await self.gate.wait()
            yield text_chunk("lo")

        return chunks()

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
    return AgentResult(ctx=TurnContext(settings=settings, source_date=kwargs.get("source_date")))


def emotion(delta: int = 0):
    async def fake(*args: object, **kwargs: object) -> StateAnalysis:
        return make_analysis(delta)

    return fake


async def ok_completion(*args: object, **kwargs: object) -> FakeStream:
    return FakeStream()


async def unavailable(*args: object, **kwargs: object) -> None:
    raise APIConnectionError(
        message="llama.cpp unavailable",
        request=httpx.Request("POST", "http://llama/v1/chat/completions"),
    )


async def wait_until(check: Callable[[], Coroutine[Any, Any, bool]], timeout: float = 10.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        if await check():
            return
        if loop.time() > deadline:
            raise AssertionError("condition not met within timeout")
        await asyncio.sleep(0.02)


async def history_roles(client: httpx.AsyncClient) -> list[str]:
    response = await client.get("/api/chat/history")
    return [message["role"] for message in response.json()["messages"]]


async def assert_settled(app: FastAPI, client: httpx.AsyncClient) -> None:
    async def settled() -> bool:
        if app.state.generation_lock.locked():
            return False
        status = (await client.get("/api/chat/inference-status")).json()
        return status == IDLE

    await wait_until(settled)


def patch_turn(
    monkeypatch: pytest.MonkeyPatch,
    completion: object,
    *,
    agent: object = fake_agent,
    emotion_fake: object = None,
) -> None:
    monkeypatch.setattr(chat, "run_memory_agent", agent)
    monkeypatch.setattr(chat, "analyze_emotion", emotion_fake or emotion())
    monkeypatch.setattr(chat, "start_completion", completion)


async def _ready(event: asyncio.Event) -> bool:
    return event.is_set()


@pytest.mark.asyncio
async def test_disconnect_while_queued_behind_background_work_still_completes_the_turn(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    patch_turn(monkeypatch, ok_completion)
    app = create_app(Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'queued-drop.db'}"))
    async with app.router.lifespan_context(app):
        await app.state.inference_lock.acquire()
        app.state.inference_activity.background_acquired("summary")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:

            async def waiting() -> bool:
                status = (await client.get("/api/chat/inference-status")).json()
                return status["foreground_waiting"] is True

            post_task = asyncio.create_task(client.post("/api/chat", json={"message": "Hi"}))
            await wait_until(waiting)
            assert await history_roles(client) == []

            post_task.cancel()
            await asyncio.gather(post_task, return_exceptions=True)

            app.state.inference_activity.background_released()
            app.state.inference_lock.release()

            async def completed() -> bool:
                return await history_roles(client) == ["user", "assistant"]

            await wait_until(completed)
            await assert_settled(app, client)

            response = await client.post("/api/chat", json={"message": "Again"})
            assert response.status_code == 200
            assert "event: message_end" in response.text
            await assert_settled(app, client)


@pytest.mark.asyncio
async def test_disconnect_during_memory_processing_still_completes_the_turn(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    entered = asyncio.Event()
    gate = asyncio.Event()

    async def blocking_agent(*args: object, **kwargs: object) -> AgentResult:
        entered.set()
        await gate.wait()
        return await fake_agent(*args, **kwargs)

    patch_turn(monkeypatch, ok_completion, agent=blocking_agent)
    app = create_app(Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'front-drop.db'}"))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            post_task = asyncio.create_task(client.post("/api/chat", json={"message": "Hi"}))
            await wait_until(lambda: _ready(entered))
            assert await history_roles(client) == ["user"]

            post_task.cancel()
            await asyncio.gather(post_task, return_exceptions=True)
            gate.set()

            async def completed() -> bool:
                return await history_roles(client) == ["user", "assistant"]

            await wait_until(completed)
            await assert_settled(app, client)

            response = await client.post("/api/chat", json={"message": "Again"})
            assert response.status_code == 200
            assert "event: message_end" in response.text
            await assert_settled(app, client)


@pytest.mark.asyncio
async def test_disconnect_mid_stream_still_saves_the_reply_and_resend_behaves_the_same(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent_calls = 0

    async def counting_agent(*args: object, **kwargs: object) -> AgentResult:
        nonlocal agent_calls
        agent_calls += 1
        return await fake_agent(*args, **kwargs)

    patch_turn(monkeypatch, unavailable, agent=counting_agent, emotion_fake=emotion(delta=3))
    app = create_app(Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'stream-drop.db'}"))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            failed = await client.post("/api/chat", json={"message": "こんにちは"})
            assert failed.status_code == 503
            assert await history_roles(client) == ["user"]

            gate = asyncio.Event()
            entered = asyncio.Event()

            async def gated_completion(*args: object, **kwargs: object) -> FakeStream:
                return FakeStream(gate=gate, entered=entered)

            monkeypatch.setattr(chat, "start_completion", gated_completion)
            resend_task = asyncio.create_task(client.post("/api/chat/resend"))
            await wait_until(lambda: _ready(entered))

            resend_task.cancel()
            await asyncio.gather(resend_task, return_exceptions=True)
            gate.set()

            async def completed() -> bool:
                return await history_roles(client) == ["user", "assistant"]

            await wait_until(completed)
            history = (await client.get("/api/chat/history")).json()["messages"]
            assert history[1]["content"] == "Hello"
            await assert_settled(app, client)
            async with app.state.session_factory() as session:
                state = await session.get(CharacterState, 1)
                assert state is not None and state.affinity == 53
                assert len((await session.scalars(select(StateHistory))).all()) == 1
            assert agent_calls == 1

            response = await client.post("/api/chat", json={"message": "Again"})
            assert response.status_code == 200
            assert "event: message_end" in response.text
            await assert_settled(app, client)


@pytest.mark.asyncio
async def test_cancel_endpoint_no_longer_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    patch_turn(monkeypatch, ok_completion)
    app = create_app(Settings(database_url="sqlite+aiosqlite:///" + str(tmp_path / "no-cancel.db")))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            assert "/api/chat/cancel" not in app.openapi()["paths"]
            response = await client.post("/api/chat/cancel")
            assert response.status_code in {404, 405}
            assert "cancelled" not in response.text
