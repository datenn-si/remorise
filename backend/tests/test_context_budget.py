from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import Settings
from app.database.models import Message, Summary, SystemPromptTokens
from app.database.session import create_engine, initialize_database
from app.schemas.character import CharacterConfig
from app.services import context_budget, job_service
from app.services.context_manager import fixed_system_text


def _messages(count: int) -> list[Message]:
    return [
        Message(id=index + 1, role="user" if index % 2 == 0 else "assistant", content="x")
        for index in range(count)
    ]


def test_split_protected_extends_to_the_user_message_of_a_pair() -> None:
    rows = _messages(6)
    older, protected = context_budget.split_protected(rows, 3)
    assert [row.id for row in older] == [1, 2]
    assert [row.id for row in protected] == [3, 4, 5, 6]


def test_split_protected_keeps_a_user_boundary_as_is() -> None:
    rows = _messages(6)
    older, protected = context_budget.split_protected(rows, 2)
    assert [row.id for row in older] == [1, 2, 3, 4]
    assert [row.id for row in protected] == [5, 6]


def test_split_protected_with_zero_protects_nothing() -> None:
    rows = _messages(3)
    older, protected = context_budget.split_protected(rows, 0)
    assert [row.id for row in older] == [1, 2, 3]
    assert protected == []


def test_summary_range_end_is_the_message_that_crosses_the_budget() -> None:
    rows = _messages(5)
    tokens = {row.id: 10 for row in rows}
    assert context_budget.summary_range_end(rows, tokens, 25) == 3
    assert context_budget.summary_range_end(rows, tokens, 0) == 5
    assert context_budget.summary_range_end(rows, tokens, 100) is None


def test_older_keep_budget_subtracts_every_reservation() -> None:
    settings = Settings(
        llm_context_size=10000,
        context_target_ratio=0.5,
        memory_handover_token_budget=1500,
    )
    budget = context_budget.older_keep_budget(
        settings, summary_tokens=1000, fixed_tokens=200, state_tokens=50
    )
    assert budget == 5000 - 1000 - 200 - 1500 - 50


def test_summary_token_estimate() -> None:
    assert context_budget.summary_token_estimate(0, 2048) == 2048
    assert context_budget.summary_token_estimate(100, 2048) == 200
    assert context_budget.summary_token_estimate(2000, 2048) == 2048


async def _factory(tmp_path: Path):
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / 'budget.db'}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)
    return engine, factory


@pytest.mark.asyncio
async def test_fill_counts_only_the_current_model_and_keeps_other_keys(
    tmp_path: Path,
) -> None:
    engine, factory = await _factory(tmp_path)
    settings = Settings()
    async with factory() as session:
        plain = Message(role="user", content="こんにちは")
        other_model = Message(role="assistant", content="返答です", token={"other-model": 42})
        already = Message(role="user", content="済み", token={"test-model": 7})
        summary = Summary(content="要約文", start_message_id=1, end_message_id=2)
        session.add_all([plain, other_model, already, summary])
        await session.commit()
        await context_budget.fill_current_model_tokens(
            session, settings, [plain, other_model, already], summary
        )
        assert plain.token == {"test-model": len(context_budget.message_token_text(plain))}
        assert other_model.token == {
            "other-model": 42,
            "test-model": len(context_budget.message_token_text(other_model)),
        }
        assert already.token == {"test-model": 7}
        assert summary.token == {"test-model": len("要約文")}
    await engine.dispose()


@pytest.mark.asyncio
async def test_fixed_prompt_tokens_are_stored_per_model_and_text(tmp_path: Path) -> None:
    engine, factory = await _factory(tmp_path)
    settings = Settings()
    character = CharacterConfig(name="テスト")
    async with factory() as session:
        counted = await context_budget.fixed_prompt_tokens(session, settings, character, None)
        assert counted == len(fixed_system_text(character, None))
        again = await context_budget.fixed_prompt_tokens(session, settings, character, None)
        assert again == counted
        rows = (await session.scalars(select(SystemPromptTokens))).all()
        assert len(rows) == 1
        assert rows[0].model_id == "test-model"
        changed = CharacterConfig(name="別キャラ")
        recounted = await context_budget.fixed_prompt_tokens(session, settings, changed, None)
        assert recounted == len(fixed_system_text(changed, None))
        rows = (await session.scalars(select(SystemPromptTokens))).all()
        assert len(rows) == 1
        assert rows[0].token_count == recounted
    await engine.dispose()


async def _add_turns(factory, count: int, last_usage: dict | None) -> list[int]:
    async with factory() as session:
        rows = []
        for index in range(count):
            role = "user" if index % 2 == 0 else "assistant"
            metadata = None
            if last_usage is not None and index == count - 1:
                metadata = {"usage": last_usage}
            row = Message(role=role, content="短い", metadata_json=metadata)
            session.add(row)
            rows.append(row)
        await session.commit()
        return [row.id for row in rows]


@pytest.mark.asyncio
async def test_enqueue_trigger_uses_the_latest_turn_usage(tmp_path: Path) -> None:
    engine, factory = await _factory(tmp_path)
    ids = await _add_turns(factory, 30, {"prompt_tokens": 900, "completion_tokens": 200})
    settings = Settings(
        llm_context_size=1000,
        context_summary_ratio=0.5,
        context_target_ratio=0.3,
        summary_protected_messages=4,
    )
    async with factory() as session:
        job = await job_service.maybe_enqueue_summary(
            session, settings, CharacterConfig(name="テスト")
        )
        assert job is not None
        assert job.start_message_id == ids[0]
    await engine.dispose()


@pytest.mark.asyncio
async def test_enqueue_trigger_ignores_the_fallback_count_when_usage_exists(
    tmp_path: Path,
) -> None:
    engine, factory = await _factory(tmp_path)
    await _add_turns(factory, 30, {"prompt_tokens": 10, "completion_tokens": 10})
    settings = Settings(
        llm_context_size=1000,
        context_summary_ratio=0.5,
        context_target_ratio=0.3,
        summary_protected_messages=4,
    )
    async with factory() as session:
        # The bodies alone would cross the ratio under the tokenize
        # fallback, but the stored usage is what decides when present.
        for row in (await session.scalars(select(Message))).all():
            row.content = "あ" * 40
        await session.commit()
        job = await job_service.maybe_enqueue_summary(
            session, settings, CharacterConfig(name="テスト")
        )
        assert job is None
    await engine.dispose()
