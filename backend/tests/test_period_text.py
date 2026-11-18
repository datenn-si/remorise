import time
from datetime import UTC, datetime

import pytest

from app.database.models import Memory
from app.services import memory_store


@pytest.fixture
def local_timezone(monkeypatch: pytest.MonkeyPatch):
    """The machine running the tests may itself be on UTC, where local
    and UTC renderings coincide; pinning the zone keeps the local
    rendering observable everywhere.
    """
    if not hasattr(time, "tzset"):
        pytest.skip("time.tzset is unavailable on this platform")

    def set_zone(name: str) -> None:
        monkeypatch.setenv("TZ", name)
        time.tzset()

    yield set_zone
    monkeypatch.undo()
    time.tzset()


def _memory(**kwargs: object) -> Memory:
    defaults: dict[str, object] = {
        "category": "state",
        "importance": 3,
        "status": "active",
        "is_active": True,
        "provenance": "explicit",
        "keywords": [],
        "specific_terms": [],
        "provisional": False,
        "source_type": "conversation",
    }
    defaults.update(kwargs)
    return Memory(content="テスト", **defaults)


def test_event_time_is_local_and_carries_its_offset(local_timezone) -> None:
    local_timezone("Asia/Tokyo")
    row = _memory(
        category="event",
        event_at=datetime(2026, 11, 9, 15, 0, tzinfo=UTC),
    )
    assert memory_store.period_text(row) == "2026-11-10 00:00（UTC+09:00）"


def test_event_offset_follows_the_zone_and_date(local_timezone) -> None:
    local_timezone("America/New_York")
    winter = _memory(
        category="event",
        event_at=datetime(2026, 1, 15, 15, 30, tzinfo=UTC),
    )
    summer = _memory(
        category="event",
        event_at=datetime(2026, 7, 15, 15, 30, tzinfo=UTC),
    )
    assert memory_store.period_text(winter) == "2026-01-15 10:30（UTC-05:00）"
    assert memory_store.period_text(summer) == "2026-07-15 11:30（UTC-04:00）"


def test_event_without_a_time_stays_unknown(local_timezone) -> None:
    local_timezone("Asia/Tokyo")
    row = _memory(category="event", event_at=None)
    assert memory_store.period_text(row) == "日時不明"


def test_state_bounds_are_local_dates(local_timezone) -> None:
    local_timezone("Asia/Tokyo")
    # A bound saved as a Tokyo midnight is 15:00 UTC of the day
    # before; it must still render as the local date it means.
    row = _memory(
        category="state",
        period_start=datetime(2026, 11, 9, 15, 0, tzinfo=UTC),
        period_end=datetime(2026, 11, 19, 15, 0, tzinfo=UTC),
    )
    assert memory_store.period_text(row) == "2026-11-10〜2026-11-20"


def test_state_open_ends_keep_their_labels(local_timezone) -> None:
    local_timezone("Asia/Tokyo")
    row = _memory(category="state", period_start=None, period_end=None)
    assert memory_store.period_text(row) == "ずっと前〜現在も継続"


def test_agent_payload_datetimes_are_local_with_offset(local_timezone) -> None:
    local_timezone("Asia/Tokyo")
    event = _memory(
        id=1,
        category="event",
        event_at=datetime(2026, 11, 9, 15, 0, tzinfo=UTC),
    )
    payload = memory_store.agent_row_payload(event)
    assert payload["event_at"] == "2026-11-10T00:00:00+09:00"
    assert payload["period"] == "2026-11-10 00:00（UTC+09:00）"

    state = _memory(
        id=2,
        category="state",
        period_start=datetime(2026, 11, 9, 15, 0, tzinfo=UTC),
        period_end=None,
    )
    payload = memory_store.agent_row_payload(state)
    assert payload["period_start"] == "2026-11-10T00:00:00+09:00"
    assert payload["period_end"] is None


def test_agent_payload_round_trips_through_parse_datetime(local_timezone) -> None:
    local_timezone("Asia/Tokyo")
    instant = datetime(2026, 11, 9, 15, 0, tzinfo=UTC)
    row = _memory(id=1, category="event", event_at=instant)
    payload = memory_store.agent_row_payload(row)
    assert memory_store.parse_datetime(payload["event_at"]) == instant
