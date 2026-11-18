import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.api import chat
from app.config import Settings
from app.database.models import CharacterState, UserProfile
from app.database.session import create_engine, initialize_database
from app.main import create_app
from app.schemas.state import StateAnalysis
from app.services import profile_store
from app.services.context_manager import build_system_prompt
from app.services.emotion_service import _emotion_user_content
from app.services.memory_agent import AgentResult, run_memory_agent
from app.services.memory_store import TurnContext

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)


async def make_factory(tmp_path: Path, name: str = "profile.db"):
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / name}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)
    return engine, factory


@pytest.mark.asyncio
async def test_profile_get_or_create_and_partial_updates(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    async with factory() as session:
        profile = await profile_store.get_profile(session)
        assert profile.name is None
        assert profile.gender is None
        assert profile.birthday_month is None
        result = await profile_store.agent_update_profile(
            session, {"name": "タロウ", "birthday": "1990-04-03"}
        )
        assert result["ok"] is True
        assert result["profile"] == {
            "name": "タロウ",
            "gender": None,
            "birthday": "1990-04-03",
        }
        await profile_store.agent_update_profile(session, {"gender": "男性"})
        await session.commit()
    async with factory() as session:
        profile = await profile_store.get_profile(session)
        assert profile.name == "タロウ"
        assert profile.gender == "男性"
        assert (profile.birthday_year, profile.birthday_month, profile.birthday_day) == (
            1990,
            4,
            3,
        )
        await profile_store.agent_update_profile(session, {"name": None})
        await session.commit()
    async with factory() as session:
        profile = await profile_store.get_profile(session)
        assert profile.name is None
        assert profile.gender == "男性"
        assert profile.birthday_month == 4
    await engine.dispose()


@pytest.mark.asyncio
async def test_profile_yearless_birthday_and_clear(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    async with factory() as session:
        result = await profile_store.agent_update_profile(session, {"birthday": "04-03"})
        assert result["profile"]["birthday"] == "04-03"
        profile = await profile_store.get_profile(session)
        assert profile.birthday_year is None
        assert profile_store.birthday_text(profile) == "4月3日"
        await profile_store.agent_update_profile(session, {"birthday": None})
        profile = await profile_store.get_profile(session)
        assert profile.birthday_month is None
        assert profile_store.birthday_text(profile) is None
    await engine.dispose()


def test_parse_birthday_variants() -> None:
    assert profile_store.parse_birthday("1990-04-03") == (1990, 4, 3)
    assert profile_store.parse_birthday("04-03") == (None, 4, 3)
    # A yearless February 29 is a real birthday.
    assert profile_store.parse_birthday("02-29") == (None, 2, 29)
    assert profile_store.parse_birthday("2023-02-29") is None
    assert profile_store.parse_birthday("2026-13-01") is None
    assert profile_store.parse_birthday("1990年4月3日") == (1990, 4, 3)
    assert profile_store.parse_birthday("4月3日") == (None, 4, 3)
    assert profile_store.parse_birthday("1990/4/3") == (1990, 4, 3)
    assert profile_store.parse_birthday("4/3") == (None, 4, 3)
    assert profile_store.parse_birthday("2023年2月29日") is None
    assert profile_store.parse_birthday("abc") is None
    assert profile_store.parse_birthday(None) is None
    assert profile_store.parse_birthday(403) is None


@pytest.mark.asyncio
async def test_profile_invalid_birthday_changes_nothing(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    async with factory() as session:
        await profile_store.agent_update_profile(session, {"name": "タロウ"})
        result = await profile_store.agent_update_profile(
            session, {"name": "ジロウ", "birthday": "2023-02-29"}
        )
        assert result["error"] == "invalid_birthday"
        # The error names the accepted shapes so a retry can fix it.
        assert "YYYY-MM-DD" in result["detail"]
        await session.commit()
    async with factory() as session:
        profile = await profile_store.get_profile(session)
        assert profile.name == "タロウ"
        assert profile.birthday_month is None
    await engine.dispose()


@pytest.mark.asyncio
async def test_profile_empty_update_is_an_error_not_a_success(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    async with factory() as session:
        result = await profile_store.agent_update_profile(session, {})
        assert result == {"error": "no_profile_fields"}
        await session.commit()
    async with factory() as session:
        profile = await profile_store.get_profile(session)
        assert profile.name is None
    await engine.dispose()


def test_is_birthday_today_matches_on_local_month_day() -> None:
    profile = UserProfile(id=1, birthday_month=4, birthday_day=3)
    assert profile_store.is_birthday_today(profile, date(2026, 4, 3)) is True
    assert profile_store.is_birthday_today(profile, date(2026, 4, 4)) is False
    assert profile_store.is_birthday_today(UserProfile(id=1), date(2026, 4, 3)) is False
    leap = UserProfile(id=1, birthday_month=2, birthday_day=29)
    assert profile_store.is_birthday_today(leap, date(2028, 2, 29)) is True


def test_profile_lines_render_unset_fields() -> None:
    empty = UserProfile(id=1)
    assert profile_store.profile_lines(empty) == [
        "名前: 未登録",
        "性別: 未登録",
        "誕生日: 未登録",
    ]
    filled = UserProfile(
        id=1,
        name="タロウ",
        gender="男性",
        birthday_year=1990,
        birthday_month=4,
        birthday_day=3,
    )
    assert profile_store.profile_lines(filled) == [
        "名前: タロウ",
        "性別: 男性",
        "誕生日: 1990年4月3日",
    ]


def tool_call(name: str, arguments: dict, call_id: str = "call-1") -> SimpleNamespace:
    return SimpleNamespace(
        id=call_id,
        function=SimpleNamespace(name=name, arguments=json.dumps(arguments)),
    )


def response(*calls: SimpleNamespace) -> SimpleNamespace:
    return SimpleNamespace(
        choices=[
            SimpleNamespace(message=SimpleNamespace(content=None, tool_calls=list(calls) or None))
        ],
        usage=SimpleNamespace(total_tokens=10),
    )


class FakeClient:
    def __init__(self, script: list) -> None:
        self.script = list(script)
        self.requests: list[dict] = []

        async def create(**kwargs: object) -> SimpleNamespace:
            self.requests.append(kwargs)
            step = self.script.pop(0)
            if isinstance(step, Exception):
                raise step
            return step

        self.chat = SimpleNamespace(completions=SimpleNamespace(create=create))


def make_state() -> CharacterState:
    return CharacterState(emotion="neutral", intensity=0.0, mood="neutral", affinity=50)


async def run_agent(factory, client: FakeClient, *, commit: bool):
    async with factory() as session:
        # The chat flow loads the profile on this session before stage
        # A runs; doing the same here means the session's transaction
        # is already open when the first tool savepoint starts (a
        # savepoint opened as a session's very first statement would
        # act as the transaction itself on SQLite).
        profile = await profile_store.get_profile(session)
        profile.name = "タロウ"
        profile.birthday_month = 4
        profile.birthday_day = 3
        await session.flush()
        result = await run_memory_agent(
            session,
            client,
            Settings(),
            question="私の名前はタロウ。誕生日は4月3日だよ",
            state=make_state(),
            session_factory=factory,
            message_id=1,
            source_date=NOW,
            profile=profile,
            birthday_today=True,
        )
        if commit:
            await session.commit()
        else:
            await session.rollback()
        return result


@pytest.mark.asyncio
async def test_update_profile_tool_commits_with_stage_a(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path, "agent-commit.db")
    client = FakeClient(
        [
            response(
                tool_call(
                    "update_profile",
                    {"name": "タロウ", "gender": "男性", "birthday": "04-03"},
                )
            ),
            response(
                tool_call(
                    "finish_selection",
                    {"disclose_ids": [], "ask_back_ids": []},
                    call_id="call-2",
                )
            ),
        ]
    )
    await run_agent(factory, client, commit=True)
    async with factory() as session:
        profile = await profile_store.get_profile(session)
        assert profile.name == "タロウ"
        assert profile.gender == "男性"
        assert profile.birthday_year is None
        assert (profile.birthday_month, profile.birthday_day) == (4, 3)
    first_request = client.requests[0]["messages"]
    user_content = first_request[1]["content"]
    assert "ユーザーの基本情報（専用の記録）:" in user_content
    assert "名前: タロウ" in user_content
    assert "通知: 今日はユーザーの誕生日です。" in user_content
    await engine.dispose()


@pytest.mark.asyncio
async def test_update_profile_tool_accepts_a_japanese_birthday(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path, "agent-japanese.db")
    client = FakeClient(
        [
            response(tool_call("update_profile", {"birthday": "1990年4月3日"})),
            response(
                tool_call(
                    "finish_selection",
                    {"disclose_ids": [], "ask_back_ids": []},
                    call_id="call-2",
                )
            ),
        ]
    )
    await run_agent(factory, client, commit=True)
    async with factory() as session:
        profile = await profile_store.get_profile(session)
        assert (profile.birthday_year, profile.birthday_month, profile.birthday_day) == (
            1990,
            4,
            3,
        )
    await engine.dispose()


@pytest.mark.asyncio
async def test_update_profile_tool_rolls_back_with_stage_a(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path, "agent-rollback.db")
    client = FakeClient(
        [
            response(tool_call("update_profile", {"name": "タロウ"})),
            response(
                tool_call(
                    "finish_selection",
                    {"disclose_ids": [], "ask_back_ids": []},
                    call_id="call-2",
                )
            ),
        ]
    )
    await run_agent(factory, client, commit=False)
    async with factory() as session:
        profile = await profile_store.get_profile(session)
        assert profile.name is None
    await engine.dispose()


def test_emotion_content_includes_profile_and_birthday_notice() -> None:
    profile = UserProfile(id=1, name="タロウ", birthday_month=4, birthday_day=3)
    content = _emotion_user_content(
        "こんにちは",
        make_state(),
        [],
        [],
        [],
        [],
        None,
        datetime.now().astimezone(),
        profile=profile,
        birthday_today=True,
    )
    assert "ユーザーの基本情報:" in content
    assert "名前: タロウ" in content
    assert "通知: 今日はユーザーの誕生日です。" in content
    plain = _emotion_user_content(
        "こんにちは",
        make_state(),
        [],
        [],
        [],
        [],
        None,
        datetime.now().astimezone(),
        profile=profile,
    )
    assert "名前: タロウ" in plain
    assert "誕生日です" not in plain


def test_system_prompt_includes_profile_and_birthday_notice() -> None:
    from app.schemas.character import CharacterConfig

    character = CharacterConfig(name="テスト")
    profile = UserProfile(id=1, name="タロウ", birthday_month=4, birthday_day=3)
    prompt = build_system_prompt(
        character,
        make_state(),
        summary=None,
        user_profile=profile,
        birthday_today=True,
    )
    assert "ユーザーについて: 名前: タロウ / 性別: 未登録 / 誕生日: 4月3日" in prompt
    assert "今日はユーザーの誕生日です。" in prompt
    plain = build_system_prompt(character, make_state(), summary=None)
    assert "ユーザーについて" not in plain
    assert "誕生日です" not in plain


class FakeStream:
    def __init__(self, chunks: list[str] | None = None) -> None:
        self.chunks = chunks if chunks is not None else ["Hel", "lo"]

    def __aiter__(self):
        async def generate():
            for text in self.chunks:
                yield SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content=text, tool_calls=None))]
                )

        return generate()

    async def close(self) -> None:
        return None


def make_analysis() -> StateAnalysis:
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


async def run_wired_turn(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, birthday: str, name: str
) -> dict:
    captured: dict = {}

    async def agent(*args: object, **kwargs: object) -> AgentResult:
        profile = kwargs.get("profile")
        captured["agent"] = {
            "name": profile.name if profile is not None else None,
            "birthday_today": kwargs.get("birthday_today"),
        }
        settings = kwargs.get("settings") or args[2]
        return AgentResult(
            ctx=TurnContext(settings=settings, source_date=kwargs.get("source_date"))
        )

    async def emotion(*args: object, **kwargs: object) -> StateAnalysis:
        profile = kwargs.get("profile")
        captured["emotion"] = {
            "name": profile.name if profile is not None else None,
            "birthday_today": kwargs.get("birthday_today"),
        }
        return make_analysis()

    async def completion(*args: object, **kwargs: object) -> FakeStream:
        return FakeStream()

    real_prompt = chat.build_system_prompt

    def prompt_spy(*args: object, **kwargs: object) -> str:
        profile = kwargs.get("user_profile")
        captured["prompt_kwargs"] = {
            "name": profile.name if profile is not None else None,
            "birthday_today": kwargs.get("birthday_today"),
        }
        rendered = real_prompt(*args, **kwargs)
        captured["prompt"] = rendered
        return rendered

    monkeypatch.setattr(chat, "run_memory_agent", agent)
    monkeypatch.setattr(chat, "analyze_emotion", emotion)
    monkeypatch.setattr(chat, "start_completion", completion)
    monkeypatch.setattr(chat, "build_system_prompt", prompt_spy)

    app = create_app(Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'wired.db'}"))
    async with app.router.lifespan_context(app):
        async with app.state.session_factory() as session:
            await profile_store.agent_update_profile(session, {"name": name, "birthday": birthday})
            await session.commit()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post("/api/chat", json={"message": "こんにちは"})
            assert response.status_code == 200
    return captured


@pytest.mark.asyncio
async def test_turn_on_birthday_notifies_stages_b_and_c(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    today = datetime.now().astimezone().date()
    captured = await run_wired_turn(
        tmp_path, monkeypatch, f"{today.month:02d}-{today.day:02d}", "タロウ"
    )
    assert captured["agent"] == {"name": "タロウ", "birthday_today": True}
    assert captured["emotion"] == {"name": "タロウ", "birthday_today": True}
    assert captured["prompt_kwargs"] == {"name": "タロウ", "birthday_today": True}
    assert "ユーザーについて: 名前: タロウ" in captured["prompt"]
    assert "今日はユーザーの誕生日です。" in captured["prompt"]


@pytest.mark.asyncio
async def test_turn_off_birthday_passes_profile_without_notice(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    other = datetime.now().astimezone().date() + timedelta(days=30)
    captured = await run_wired_turn(
        tmp_path, monkeypatch, f"{other.month:02d}-{other.day:02d}", "タロウ"
    )
    assert captured["agent"] == {"name": "タロウ", "birthday_today": False}
    assert captured["emotion"] == {"name": "タロウ", "birthday_today": False}
    assert captured["prompt_kwargs"] == {"name": "タロウ", "birthday_today": False}
    assert "ユーザーについて: 名前: タロウ" in captured["prompt"]
    assert "誕生日です" not in captured["prompt"]
