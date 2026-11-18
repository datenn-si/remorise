import asyncio
from collections.abc import AsyncIterator
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from app.api import chat
from app.config import Settings
from app.main import create_app
from app.schemas.state import StateAnalysis
from app.services.inference_status import InferenceActivity
from app.services.memory_agent import AgentResult
from app.services.memory_store import TurnContext


class FakeStream:
    def __aiter__(self) -> AsyncIterator[SimpleNamespace]:
        async def chunks() -> AsyncIterator[SimpleNamespace]:
            yield SimpleNamespace(
                choices=[SimpleNamespace(delta=SimpleNamespace(content="Hello", tool_calls=None))]
            )

        return chunks()

    async def close(self) -> None:
        return None


async def fake_completion(*args: object, **kwargs: object) -> FakeStream:
    return FakeStream()


async def fake_agent(*args: object, **kwargs: object) -> AgentResult:
    settings = kwargs.get("settings") or args[2]
    return AgentResult(ctx=TurnContext(settings=settings, source_date=kwargs.get("source_date")))


async def fake_emotion(*args: object, **kwargs: object) -> StateAnalysis:
    return StateAnalysis(
        emotion={
            "primary": "neutral",
            "intensity": 0.0,
            "secondary": None,
            "secondary_intensity": 0.0,
            "mood": "neutral",
        },
        affinity={"delta": 0, "reason": ""},
    )


IDLE = {
    "active": None,
    "background_kind": None,
    "foreground_waiting": False,
    "foreground_phase": None,
}


def test_activity_starts_idle() -> None:
    assert InferenceActivity().snapshot() == IDLE


def test_activity_foreground_cycle() -> None:
    activity = InferenceActivity()
    activity.foreground_wait()
    assert activity.snapshot() == {**IDLE, "foreground_waiting": True}
    activity.foreground_acquired()
    assert activity.snapshot() == {**IDLE, "active": "foreground"}
    activity.note_foreground_phase("thinking")
    assert activity.snapshot()["foreground_phase"] == "thinking"
    activity.note_foreground_phase("speaking")
    assert activity.snapshot()["foreground_phase"] == "speaking"
    activity.foreground_released()
    assert activity.snapshot() == IDLE


def test_activity_wait_cancelled_clears_only_the_flag() -> None:
    activity = InferenceActivity()
    activity.background_acquired("summary")
    activity.foreground_wait()
    activity.foreground_wait_cancelled()
    assert activity.snapshot() == {
        "active": "background",
        "background_kind": "summary",
        "foreground_waiting": False,
        "foreground_phase": None,
    }


def test_activity_release_is_owner_scoped() -> None:
    activity = InferenceActivity()
    activity.background_acquired("summary")
    activity.foreground_released()
    assert activity.snapshot()["active"] == "background"
    activity.background_released()
    assert activity.snapshot() == IDLE


@pytest.mark.asyncio
async def test_activity_background_context_manager() -> None:
    activity = InferenceActivity()
    async with activity.background("retention"):
        assert activity.snapshot() == {
            "active": "background",
            "background_kind": "retention",
            "foreground_waiting": False,
            "foreground_phase": None,
        }
    assert activity.snapshot() == IDLE


@pytest.mark.asyncio
async def test_inference_status_endpoint_reports_tracker_state(tmp_path: Path) -> None:
    app = create_app(Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'status.db'}"))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/chat/inference-status")
            assert response.status_code == 200
            assert response.json() == IDLE

            activity: InferenceActivity = app.state.inference_activity
            activity.background_acquired("summary")
            response = await client.get("/api/chat/inference-status")
            assert response.json() == {
                "active": "background",
                "background_kind": "summary",
                "foreground_waiting": False,
                "foreground_phase": None,
            }

            activity.foreground_wait()
            response = await client.get("/api/chat/inference-status")
            assert response.json()["foreground_waiting"] is True

            activity.foreground_wait_cancelled()
            activity.background_released()
            response = await client.get("/api/chat/inference-status")
            assert response.json() == IDLE


@pytest.mark.asyncio
async def test_send_queued_behind_background_is_reported_until_it_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(chat, "start_completion", fake_completion)
    monkeypatch.setattr(chat, "run_memory_agent", fake_agent)
    monkeypatch.setattr(chat, "analyze_emotion", fake_emotion)
    app = create_app(Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'queued.db'}"))
    async with app.router.lifespan_context(app):
        await app.state.inference_lock.acquire()
        app.state.inference_activity.background_acquired("summary")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            post_task = asyncio.create_task(client.post("/api/chat", json={"message": "Hi"}))
            status: dict[str, object] = {}
            for _ in range(100):
                status = (await client.get("/api/chat/inference-status")).json()
                if status["foreground_waiting"]:
                    break
                await asyncio.sleep(0.05)
            assert status == {
                "active": "background",
                "background_kind": "summary",
                "foreground_waiting": True,
                "foreground_phase": None,
            }
            assert not post_task.done()

            app.state.inference_activity.background_released()
            app.state.inference_lock.release()
            response = await asyncio.wait_for(post_task, timeout=10)
            assert response.status_code == 200
            assert "event: message_end" in response.text

            # The worker may briefly hold the lock for a housekeeping
            # cycle right after the turn; the status must settle to idle.
            for _ in range(100):
                status = (await client.get("/api/chat/inference-status")).json()
                if status == IDLE:
                    break
                await asyncio.sleep(0.05)
            assert status == IDLE
