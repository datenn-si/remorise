"""The user profile store: name, gender, and birthday.

These basic facts are not long-term memories. They sit in a
dedicated single-row table, outside the forgetting lifecycle and
the disclosure gate, and every stage of every turn receives them.
Stage A edits them through its ``update_profile`` tool; its writes
flush on the caller's session, so they land (or roll back) with
stage A's commit point like everything else the stage settles.
"""

import re
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from app.database.models import UserProfile, utc_now

_FULL_DATE = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})$")
_YEARLESS_DATE = re.compile(r"^(\d{1,2})-(\d{1,2})$")


async def get_profile(session: AsyncSession) -> UserProfile:
    row = await session.get(UserProfile, 1)
    if row is None:
        row = UserProfile(id=1)
        session.add(row)
        await session.flush()
    return row


def parse_birthday(value: object) -> tuple[int | None, int, int] | None:
    """Parse a birthday string into (year, month, day).

    Accepts a full date (``YYYY-MM-DD``) and a yearless month/day
    (``MM-DD``); the year is None for the latter. Slash separators
    and the Japanese shapes (``YYYY年M月D日`` / ``M月D日``) resolve
    the same way: the agent is asked for the ISO shapes, but a
    birthday it renders in plainer words must not sink the whole
    profile update. Anything else, including impossible dates,
    resolves to None.
    """
    if not isinstance(value, str):
        return None
    text = value.strip().replace("年", "-").replace("月", "-").replace("日", "").replace("/", "-")
    match = _FULL_DATE.match(text)
    if match:
        year, month, day = (int(part) for part in match.groups())
    else:
        match = _YEARLESS_DATE.match(text)
        if not match:
            return None
        year = None
        month, day = (int(part) for part in match.groups())
    try:
        # 2000 is a leap year, so a yearless February 29 validates.
        date(year or 2000, month, day)
    except ValueError:
        return None
    return year, month, day


def birthday_text(profile: UserProfile) -> str | None:
    if profile.birthday_month is None or profile.birthday_day is None:
        return None
    if profile.birthday_year is not None:
        return f"{profile.birthday_year}年{profile.birthday_month}月{profile.birthday_day}日"
    return f"{profile.birthday_month}月{profile.birthday_day}日"


def profile_payload(profile: UserProfile) -> dict:
    birthday = None
    if profile.birthday_month is not None and profile.birthday_day is not None:
        if profile.birthday_year is not None:
            birthday = (
                f"{profile.birthday_year:04d}-{profile.birthday_month:02d}"
                f"-{profile.birthday_day:02d}"
            )
        else:
            birthday = f"{profile.birthday_month:02d}-{profile.birthday_day:02d}"
    return {
        "name": profile.name,
        "gender": profile.gender,
        "birthday": birthday,
    }


def profile_lines(profile: UserProfile) -> list[str]:
    return [
        f"名前: {profile.name or '未登録'}",
        f"性別: {profile.gender or '未登録'}",
        f"誕生日: {birthday_text(profile) or '未登録'}",
    ]


def is_birthday_today(profile: UserProfile, today: date) -> bool:
    return (
        profile.birthday_month is not None
        and profile.birthday_day is not None
        and profile.birthday_month == today.month
        and profile.birthday_day == today.day
    )


async def agent_update_profile(session: AsyncSession, arguments: dict) -> dict:
    """Apply one ``update_profile`` tool call on the caller's session.

    Only the fields the agent actually sent change: a string sets a
    field, and an explicit null (or a blank string) clears it. The
    write only flushes; the caller's commit settles it, so an
    unsettled stage takes the profile change back with it.
    """
    if not arguments:
        # A call carrying no field at all (its arguments failed to
        # parse upstream, or named nothing the tool accepts) must
        # not read as a success: the agent would believe the profile
        # was recorded and never retry.
        return {"error": "no_profile_fields"}
    if "birthday" in arguments and arguments["birthday"] is not None:
        if parse_birthday(arguments["birthday"]) is None:
            return {
                "error": "invalid_birthday",
                "detail": "birthday must be YYYY-MM-DD or MM-DD",
            }
    row = await get_profile(session)
    if "birthday" in arguments:
        if arguments["birthday"] is None:
            row.birthday_year = None
            row.birthday_month = None
            row.birthday_day = None
        else:
            parsed = parse_birthday(arguments["birthday"])
            assert parsed is not None
            row.birthday_year, row.birthday_month, row.birthday_day = parsed
    for key in ("name", "gender"):
        if key not in arguments:
            continue
        raw = arguments[key]
        text = str(raw).strip() if raw is not None else ""
        setattr(row, key, text or None)
    row.updated_at = utc_now()
    await session.flush()
    return {"ok": True, "profile": profile_payload(row)}
