import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import Settings
from app.database.models import CharacterState, Memory
from app.database.session import create_engine, initialize_database
from app.services.memory_agent import _SYSTEM_PROMPT, TOOL_DEFINITIONS, run_memory_agent

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)


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


async def make_factory(tmp_path: Path, name: str = "agent.db"):
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / name}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)
    return engine, factory


def make_state() -> CharacterState:
    return CharacterState(emotion="neutral", intensity=0.0, mood="neutral", affinity=50)


async def run(factory, client: FakeClient, settings: Settings | None = None):
    async with factory() as session:
        result = await run_memory_agent(
            session,
            client,
            settings or Settings(),
            question="紅茶が好きなんだ",
            state=make_state(),
            session_factory=factory,
            message_id=1,
            source_date=NOW,
        )
        await session.commit()
        return result


@pytest.mark.asyncio
async def test_agent_session_searches_saves_and_selects(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    client = FakeClient(
        [
            response(tool_call("search_memories", {"terms": ["紅茶"]})),
            response(
                tool_call(
                    "save_memory",
                    {
                        "content": "紅茶が好き",
                        "category": "state",
                        "importance": 4,
                        "provenance": "explicit",
                        "specific_terms": ["紅茶"],
                        "abstract_terms": ["飲み物"],
                    },
                    call_id="call-2",
                )
            ),
            response(
                tool_call(
                    "finish_selection",
                    {"disclose_ids": [1], "ask_back_ids": []},
                    call_id="call-3",
                )
            ),
        ]
    )
    result = await run(factory, client)
    async with factory() as session:
        rows = (await session.scalars(select(Memory))).all()
        assert len(rows) == 1
        row = rows[0]
        assert row.content == "紅茶が好き"
        assert row.period_start is not None
        assert row.period_end is None
    assert [(item.memory.id, item.delivery) for item in result.delivered] == [(row.id, "new")]
    payload = result.debug_payload()
    assert payload["created_ids"] == [row.id]
    assert payload["searches"][0]["result"] == "no_hit"
    await engine.dispose()


@pytest.mark.asyncio
async def test_agent_failure_is_fail_soft(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    client = FakeClient([RuntimeError("llm down")])
    result = await run(factory, client)
    assert result.delivered == []
    async with factory() as session:
        assert (await session.scalars(select(Memory))).all() == []
    await engine.dispose()


@pytest.mark.asyncio
async def test_agent_tool_budget_stops_further_writes(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    save = {
        "category": "state",
        "importance": 3,
        "provenance": "explicit",
        "specific_terms": [],
        "abstract_terms": [],
    }
    client = FakeClient(
        [
            response(tool_call("save_memory", {**save, "content": "一つ目の事実"})),
            response(
                tool_call("save_memory", {**save, "content": "二つ目の事実"}, call_id="call-2")
            ),
            response(),
        ]
    )
    settings = Settings(memory_agent_max_calls=1)
    result = await run(factory, client, settings)
    async with factory() as session:
        rows = (await session.scalars(select(Memory))).all()
        assert [row.content for row in rows] == ["一つ目の事実"]
    assert [item.delivery for item in result.delivered] == ["new"]
    await engine.dispose()


@pytest.mark.asyncio
async def test_agent_without_finish_discloses_gate_passing_outcomes(
    tmp_path: Path,
) -> None:
    engine, factory = await make_factory(tmp_path)
    async with factory() as session:
        row = Memory(
            content="ピアノを習っている",
            category="state",
            importance=3,
            status="active",
            is_active=True,
            provenance="explicit",
            keywords=["音楽"],
            specific_terms=["ピアノ"],
            provisional=False,
            source_type="conversation",
            source_date=NOW,
            created_at=NOW - timedelta(days=3),
            last_reinforced_at=NOW - timedelta(days=3),
            reactivation_count=0,
            restoration_count=0,
        )
        session.add(row)
        await session.commit()
        memory_id = row.id
    client = FakeClient(
        [
            response(tool_call("search_memories", {"terms": ["ピアノ"]})),
            response(),
        ]
    )
    result = await run(factory, client)
    assert [(item.memory.id, item.delivery) for item in result.delivered] == [(memory_id, "hit")]
    await engine.dispose()


@pytest.mark.asyncio
async def test_agent_selection_cannot_disclose_a_restoration(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    async with factory() as session:
        row = Memory(
            content="ピアノを習っていた",
            category="state",
            importance=3,
            status="forgotten",
            is_active=False,
            provenance="explicit",
            keywords=["音楽"],
            specific_terms=["ピアノ"],
            provisional=False,
            source_type="conversation",
            source_date=NOW,
            created_at=NOW - timedelta(days=90),
            last_reinforced_at=NOW - timedelta(days=90),
            reactivation_count=0,
            restoration_count=0,
        )
        session.add(row)
        await session.commit()
        memory_id = row.id
    client = FakeClient(
        [
            response(tool_call("search_memories", {"terms": ["ピアノ"], "pointing": False})),
            response(
                tool_call(
                    "finish_selection",
                    {"disclose_ids": [memory_id], "ask_back_ids": []},
                    call_id="call-2",
                )
            ),
        ]
    )
    result = await run(factory, client)
    assert result.ctx.restored_ids == [memory_id]
    assert result.delivered == []
    await engine.dispose()


def test_agent_wording_names_the_character_and_the_user() -> None:
    # Terminology discipline: the character is "キャラクター" and the
    # user is "ユーザー", in instructions and in stored content alike;
    # meta words such as "エージェント" / "AI" appear only inside the
    # prohibition sentence itself.
    assert "キャラクターのことは「キャラクター」" in _SYSTEM_PROMPT
    assert "ユーザーのことは「ユーザー」" in _SYSTEM_PROMPT
    assert "保存する記憶の内容についても同じです" in _SYSTEM_PROMPT
    assert "ユーザーの発言と同じ言語で書いてください" in _SYSTEM_PROMPT
    assert _SYSTEM_PROMPT.count("エージェント") == 1
    for tool in TOOL_DEFINITIONS:
        description = tool["function"]["description"]
        assert "エージェント" not in description
        assert "AI" not in description
