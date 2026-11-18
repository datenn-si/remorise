"""In-memory view of who is using the shared inference lock.

The chat UI polls this (``GET /api/chat/inference-status``) so it can show
the character as *thinking* while background work holds the inference
lock, or while a foreground turn is queued behind that work, instead of
leaving a send looking silently stuck. This is process-local lock state
only; nothing here is persisted or derived from the database.

State changes happen only while holding the lock (plus the foreground
"waiting" flag, which the queued turn sets before it blocks), so the
snapshot always describes the single current lock holder.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

HOLDER_FOREGROUND = "foreground"
HOLDER_BACKGROUND = "background"

# Presentation phases of a foreground turn, as the chat UI labels them:
# the turn is thinking until its first visible token, then speaking.
PHASE_THINKING = "thinking"
PHASE_SPEAKING = "speaking"

# Background detail used while the worker runs its periodic housekeeping
# pass (retention summarization, archive purge, memory decay).
BACKGROUND_RETENTION = "retention"


class InferenceActivity:
    def __init__(self) -> None:
        self._holder: str | None = None
        self._background_kind: str | None = None
        self._foreground_waiting = False
        self._foreground_phase: str | None = None

    def foreground_wait(self) -> None:
        self._foreground_waiting = True

    def foreground_wait_cancelled(self) -> None:
        self._foreground_waiting = False

    def foreground_acquired(self) -> None:
        self._foreground_waiting = False
        self._holder = HOLDER_FOREGROUND
        self._background_kind = None
        self._foreground_phase = None

    def foreground_released(self) -> None:
        if self._holder == HOLDER_FOREGROUND:
            self._holder = None
            self._foreground_phase = None

    def note_foreground_phase(self, phase: str) -> None:
        if self._holder == HOLDER_FOREGROUND:
            self._foreground_phase = phase

    def background_acquired(self, kind: str) -> None:
        self._holder = HOLDER_BACKGROUND
        self._background_kind = kind

    def background_released(self) -> None:
        if self._holder == HOLDER_BACKGROUND:
            self._holder = None
            self._background_kind = None

    @asynccontextmanager
    async def background(self, kind: str) -> AsyncIterator[None]:
        """Enter after the lock is held."""
        self.background_acquired(kind)
        try:
            yield
        finally:
            self.background_released()

    def snapshot(self) -> dict[str, Any]:
        return {
            "active": self._holder,
            "background_kind": (
                self._background_kind if self._holder == HOLDER_BACKGROUND else None
            ),
            "foreground_waiting": self._foreground_waiting,
            "foreground_phase": (
                self._foreground_phase if self._holder == HOLDER_FOREGROUND else None
            ),
        }
