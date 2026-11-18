import time
from datetime import UTC, datetime, timedelta

import pytest

from app.services import memory_store


@pytest.fixture
def local_timezone(monkeypatch: pytest.MonkeyPatch):
    """The machine running the tests may itself be on UTC, where a
    local-time reading and a UTC reading of a naive value coincide;
    pinning the zone keeps the distinction observable everywhere.
    """
    if not hasattr(time, "tzset"):
        pytest.skip("time.tzset is unavailable on this platform")

    def set_zone(name: str) -> None:
        monkeypatch.setenv("TZ", name)
        time.tzset()

    yield set_zone
    monkeypatch.undo()
    time.tzset()


def test_plain_date_is_the_start_of_the_local_day(local_timezone) -> None:
    local_timezone("Asia/Tokyo")
    assert memory_store.parse_datetime("2024-04-01") == datetime(2024, 3, 31, 15, 0, tzinfo=UTC)


def test_naive_datetime_is_a_local_wall_clock_time(local_timezone) -> None:
    local_timezone("Asia/Tokyo")
    assert memory_store.parse_datetime("2024-04-01T15:30:00") == datetime(
        2024, 4, 1, 6, 30, tzinfo=UTC
    )


def test_naive_datetime_follows_the_zones_offset_for_its_date(
    local_timezone,
) -> None:
    local_timezone("America/New_York")
    # January is EST (UTC-5); July is EDT (UTC-4).
    assert memory_store.parse_datetime("2024-01-15T15:30:00") == datetime(
        2024, 1, 15, 20, 30, tzinfo=UTC
    )
    assert memory_store.parse_datetime("2024-07-15T15:30:00") == datetime(
        2024, 7, 15, 19, 30, tzinfo=UTC
    )


def test_offset_carrying_value_keeps_its_own_offset(local_timezone) -> None:
    local_timezone("Asia/Tokyo")
    assert memory_store.parse_datetime("2024-04-01T15:30:00+09:00") == datetime(
        2024, 4, 1, 6, 30, tzinfo=UTC
    )
    assert memory_store.parse_datetime("2024-04-01T15:30:00Z") == datetime(
        2024, 4, 1, 15, 30, tzinfo=UTC
    )
    assert memory_store.parse_datetime("2024-04-01T15:30:00-05:00") == datetime(
        2024, 4, 1, 20, 30, tzinfo=UTC
    )


def test_result_is_an_aware_utc_datetime(local_timezone) -> None:
    local_timezone("Asia/Tokyo")
    parsed = memory_store.parse_datetime("2024-04-01")
    assert parsed is not None
    assert parsed.tzinfo is not None
    assert parsed.utcoffset() == timedelta(0)


def test_unparseable_values_resolve_to_none() -> None:
    assert memory_store.parse_datetime("not a date") is None
    assert memory_store.parse_datetime("") is None
    assert memory_store.parse_datetime(None) is None
    assert memory_store.parse_datetime(20240401) is None
