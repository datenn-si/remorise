from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import Settings
from app.database.models import Memory, Message, Summary
from app.database.session import create_engine, initialize_database
from app.services import memory_store
from app.services.memory_store import DeliveredMemory, TurnContext

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)


async def make_factory(tmp_path: Path, name: str = "store.db"):
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / name}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)
    return engine, factory


def make_ctx() -> TurnContext:
    return TurnContext(settings=Settings(), source_date=NOW)


def memory_row(content: str, **kwargs: object) -> Memory:
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
        "source_date": NOW,
        "created_at": NOW - timedelta(days=30),
        "last_reinforced_at": NOW - timedelta(days=30),
        "reactivation_count": 0,
        "restoration_count": 0,
    }
    defaults.update(kwargs)
    return Memory(content=content, **defaults)


async def add_memory(factory, row: Memory) -> Memory:
    async with factory() as session:
        session.add(row)
        await session.commit()
        await session.refresh(row)
    return row


@pytest.mark.asyncio
async def test_active_hit_is_an_access_not_a_reinforcement(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    row = await add_memory(
        factory,
        memory_row("ピアノを習っている", specific_terms=["ピアノ"], keywords=["音楽"]),
    )
    async with factory() as session:
        ctx = make_ctx()
        result = await memory_store.agent_search(session, ctx, terms=["ピアノ"])
        await session.commit()
        assert result["status"] == "hit"
        assert ctx.outcomes[row.id] == "hit"
        stored = await session.get(Memory, row.id)
        assert stored.last_accessed_at is not None
        assert stored.reactivation_count == 0
        assert memory_store.as_utc(stored.last_reinforced_at) == NOW - timedelta(days=30)
    await engine.dispose()


@pytest.mark.asyncio
async def test_forgotten_concrete_hit_with_pointing_is_a_recall(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    row = await add_memory(
        factory,
        memory_row(
            "ピアノを習っていた",
            status="forgotten",
            is_active=False,
            specific_terms=["ピアノ"],
            keywords=["音楽"],
        ),
    )
    async with factory() as session:
        ctx = make_ctx()
        result = await memory_store.agent_search(session, ctx, terms=["ピアノ"], pointing=True)
        await session.commit()
        assert result["status"] == "hit"
        assert ctx.outcomes[row.id] == "recall"
        assert ctx.recalled_ids == [row.id]
        stored = await session.get(Memory, row.id)
        assert stored.is_active is True
        assert stored.reactivation_count == 1
        assert stored.restoration_count == 0
    await engine.dispose()


@pytest.mark.asyncio
async def test_forgotten_concrete_hit_without_pointing_is_a_restoration(
    tmp_path: Path,
) -> None:
    engine, factory = await make_factory(tmp_path)
    row = await add_memory(
        factory,
        memory_row(
            "ピアノを習っていた",
            status="forgotten",
            is_active=False,
            specific_terms=["ピアノ"],
            keywords=["音楽"],
        ),
    )
    async with factory() as session:
        ctx = make_ctx()
        result = await memory_store.agent_search(session, ctx, terms=["ピアノ"], pointing=False)
        await session.commit()
        assert result["status"] == "hit"
        assert ctx.outcomes[row.id] == "restored"
        stored = await session.get(Memory, row.id)
        assert stored.is_active is True
        assert stored.restoration_count == 1
        assert stored.reactivation_count == 0
        # A restoration never passes the disclosure gate on its own turn.
        delivered, _, _ = memory_store.select_disclosure(ctx, [row.id], [])
        assert delivered == []
    await engine.dispose()


@pytest.mark.asyncio
async def test_forgotten_abstract_hit_with_pointing_only_notifies(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    row = await add_memory(
        factory,
        memory_row(
            "ピアノを習っていた",
            status="forgotten",
            is_active=False,
            specific_terms=["ピアノ"],
            keywords=["音楽"],
        ),
    )
    async with factory() as session:
        ctx = make_ctx()
        result = await memory_store.agent_search(session, ctx, terms=["音楽"], pointing=True)
        await session.commit()
        assert result["hits"][0]["hit_type"] == "abstract"
        assert ctx.notification_terms == {"音楽"}
        stored = await session.get(Memory, row.id)
        assert stored.is_active is False
        delivered, _, notification = memory_store.select_disclosure(ctx, [row.id], [])
        assert delivered == []
        assert notification == {"terms": ["音楽"]}
    await engine.dispose()


@pytest.mark.asyncio
async def test_forgotten_abstract_hit_without_pointing_stays_undisclosed(
    tmp_path: Path,
) -> None:
    engine, factory = await make_factory(tmp_path)
    row = await add_memory(
        factory,
        memory_row(
            "ピアノを習っていた",
            status="forgotten",
            is_active=False,
            specific_terms=["ピアノ"],
            keywords=["音楽"],
        ),
    )
    async with factory() as session:
        ctx = make_ctx()
        result = await memory_store.agent_search(session, ctx, terms=["音楽"], pointing=False)
        await session.commit()
        assert result["status"] == "forgotten_undisclosed"
        assert ctx.notification_terms == set()
        _, _, notification = memory_store.select_disclosure(ctx, [], [])
        assert notification is None
        stored = await session.get(Memory, row.id)
        assert stored.is_active is False
    await engine.dispose()


@pytest.mark.asyncio
async def test_period_matching_uses_overlap_and_event_points(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    state_row = await add_memory(
        factory,
        memory_row(
            "東京に住んでいる",
            specific_terms=["東京"],
            period_start=datetime(2024, 1, 1, tzinfo=UTC),
            period_end=datetime(2024, 3, 31, tzinfo=UTC),
        ),
    )
    event_row = await add_memory(
        factory,
        memory_row(
            "東京へ旅行した",
            category="event",
            specific_terms=["旅行"],
            event_at=datetime(2024, 6, 15, tzinfo=UTC),
        ),
    )
    async with factory() as session:
        ctx = make_ctx()
        overlapping = await memory_store.agent_search(
            session,
            ctx,
            terms=["東京"],
            period_start=datetime(2024, 3, 15, tzinfo=UTC),
            period_end=datetime(2024, 4, 15, tzinfo=UTC),
        )
        assert overlapping["status"] == "hit"
        assert ctx.outcomes[state_row.id] == "hit"

        ctx = make_ctx()
        outside = await memory_store.agent_search(
            session,
            ctx,
            terms=["東京"],
            period_start=datetime(2024, 5, 1, tzinfo=UTC),
            period_end=datetime(2024, 5, 31, tzinfo=UTC),
        )
        assert outside["status"] == "no_hit"

        ctx = make_ctx()
        event_hit = await memory_store.agent_search(
            session,
            ctx,
            terms=["旅行"],
            period_start=datetime(2024, 6, 1, tzinfo=UTC),
            period_end=datetime(2024, 6, 30, tzinfo=UTC),
        )
        assert event_hit["status"] == "hit"
        assert ctx.outcomes[event_row.id] == "hit"
    await engine.dispose()


def test_disclosure_gate_passes_only_hits_recalls_and_new() -> None:
    ctx = make_ctx()
    rows = {}
    for memory_id, outcome in [
        (1, "hit"),
        (2, "recall"),
        (3, "created"),
        (4, "restored"),
        (5, "forgotten"),
        (6, "reference"),
    ]:
        row = memory_row(f"内容{memory_id}")
        row.id = memory_id
        ctx.note_row(row, outcome)
        rows[memory_id] = row
    provisional = memory_row("時期不明の話")
    provisional.id = 7
    provisional.provisional = True
    ctx.note_row(provisional, "hit")

    delivered, ask_back, notification = memory_store.select_disclosure(
        ctx, [1, 2, 3, 4, 5, 6, 7], [7]
    )
    assert [(item.memory.id, item.delivery) for item in delivered] == [
        (1, "hit"),
        (2, "recall"),
        (3, "new"),
    ]
    assert ask_back == [provisional]
    assert notification is None


@pytest.mark.asyncio
async def test_similarity_gate_matches_instead_of_duplicating(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    async with factory() as session:
        ctx = make_ctx()
        first = await memory_store.agent_save(
            session,
            ctx,
            content="紅茶が好きで毎朝飲んでいる",
            category="state",
            importance=3,
            provenance="explicit",
            specific_terms=["紅茶"],
            abstract_terms=["飲み物"],
            period_start=NOW,
            period_end=None,
        )
        await session.commit()
        assert first["action"] == "created"

        ctx = make_ctx()
        second = await memory_store.agent_save(
            session,
            ctx,
            content="紅茶が好きで毎朝飲んでいる",
            category="state",
            importance=3,
            provenance="explicit",
            specific_terms=["紅茶"],
            abstract_terms=["飲み物"],
            period_start=NOW,
            period_end=None,
        )
        await session.commit()
        assert second["action"] == "matched"
        assert second["id"] == first["id"]
        assert len((await session.scalars(select(Memory))).all()) == 1
    await engine.dispose()


@pytest.mark.asyncio
async def test_similarity_gate_restores_a_forgotten_match(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    row = await add_memory(
        factory,
        memory_row(
            "紅茶が好きで毎朝飲んでいる",
            status="forgotten",
            is_active=False,
            specific_terms=["紅茶"],
        ),
    )
    async with factory() as session:
        ctx = make_ctx()
        result = await memory_store.agent_save(
            session,
            ctx,
            content="紅茶が好きで毎朝飲んでいる",
            category="state",
            importance=3,
            provenance="explicit",
            specific_terms=["紅茶"],
            abstract_terms=[],
            period_start=NOW,
            period_end=None,
        )
        await session.commit()
        assert result["action"] == "restored"
        assert result["id"] == row.id
        stored = await session.get(Memory, row.id)
        assert stored.is_active is True
        assert stored.restoration_count == 1
        assert len((await session.scalars(select(Memory))).all()) == 1
    await engine.dispose()


@pytest.mark.asyncio
async def test_period_surgery_splits_an_engulfed_period(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    existing = await add_memory(
        factory,
        memory_row(
            "大阪に住んでいた",
            specific_terms=["大阪"],
            period_start=datetime(2024, 1, 1, tzinfo=UTC),
            period_end=datetime(2024, 12, 31, tzinfo=UTC),
        ),
    )
    async with factory() as session:
        ctx = make_ctx()
        result = await memory_store.agent_save(
            session,
            ctx,
            content="京都に住んでいた",
            category="state",
            importance=3,
            provenance="explicit",
            specific_terms=["京都"],
            abstract_terms=[],
            period_start=datetime(2024, 4, 1, tzinfo=UTC),
            period_end=datetime(2024, 6, 30, tzinfo=UTC),
            overlap_ids=[existing.id],
        )
        await session.commit()
        assert result["surgery"] == [{"id": existing.id, "action": "split"}]
        rows = list((await session.scalars(select(Memory).order_by(Memory.id))).all())
        by_content: dict[str, list[Memory]] = {}
        for row in rows:
            by_content.setdefault(row.content, []).append(row)
        osaka = sorted(by_content["大阪に住んでいた"], key=lambda r: r.period_start)
        assert len(osaka) == 2
        assert memory_store.as_utc(osaka[0].period_end) == datetime(2024, 4, 1, tzinfo=UTC)
        assert memory_store.as_utc(osaka[1].period_start) == datetime(2024, 6, 30, tzinfo=UTC)
        assert memory_store.as_utc(osaka[1].period_end) == datetime(2024, 12, 31, tzinfo=UTC)
    await engine.dispose()


@pytest.mark.asyncio
async def test_period_surgery_trims_and_closes(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    trimmed = await add_memory(
        factory,
        memory_row(
            "名古屋に住んでいた",
            specific_terms=["名古屋"],
            period_start=datetime(2024, 1, 1, tzinfo=UTC),
            period_end=datetime(2024, 12, 31, tzinfo=UTC),
        ),
    )
    closed = await add_memory(
        factory,
        memory_row(
            "福岡に住んでいた",
            specific_terms=["福岡"],
            period_start=datetime(2024, 3, 1, tzinfo=UTC),
            period_end=datetime(2024, 5, 31, tzinfo=UTC),
        ),
    )
    async with factory() as session:
        ctx = make_ctx()
        result = await memory_store.agent_save(
            session,
            ctx,
            content="札幌に住んでいた",
            category="state",
            importance=3,
            provenance="explicit",
            specific_terms=["札幌"],
            abstract_terms=[],
            period_start=datetime(2024, 6, 1, tzinfo=UTC),
            period_end=datetime(2025, 6, 1, tzinfo=UTC),
            overlap_ids=[trimmed.id],
        )
        await session.commit()
        assert result["surgery"] == [{"id": trimmed.id, "action": "trimmed"}]
        stored = await session.get(Memory, trimmed.id)
        assert memory_store.as_utc(stored.period_end) == datetime(2024, 6, 1, tzinfo=UTC)

        ctx = make_ctx()
        result = await memory_store.agent_save(
            session,
            ctx,
            content="仙台に住んでいた",
            category="state",
            importance=3,
            provenance="explicit",
            specific_terms=["仙台"],
            abstract_terms=[],
            period_start=datetime(2024, 1, 1, tzinfo=UTC),
            period_end=datetime(2024, 12, 31, tzinfo=UTC),
            overlap_ids=[closed.id],
        )
        await session.commit()
        assert result["surgery"] == [{"id": closed.id, "action": "closed"}]
        stored = await session.get(Memory, closed.id)
        assert stored.period_start == stored.period_end
    await engine.dispose()


@pytest.mark.asyncio
async def test_provisional_confirmation_settles_the_same_row(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    async with factory() as session:
        ctx = make_ctx()
        saved = await memory_store.agent_save(
            session,
            ctx,
            content="昔バイオリンを習っていた",
            category="state",
            importance=3,
            provenance="explicit",
            specific_terms=["バイオリン"],
            abstract_terms=["音楽"],
            period_start=None,
            period_end=NOW,
            provisional=True,
        )
        await session.commit()
        memory_id = saved["id"]
        stored = await session.get(Memory, memory_id)
        assert stored.provisional is True

        ctx = make_ctx()
        confirmed = await memory_store.agent_confirm_period(
            session,
            ctx,
            memory_id=memory_id,
            period_start=datetime(2015, 4, 1, tzinfo=UTC),
            period_end=datetime(2019, 3, 31, tzinfo=UTC),
        )
        await session.commit()
        assert confirmed == {"id": memory_id, "action": "confirmed"}
        stored = await session.get(Memory, memory_id)
        assert stored.provisional is False
        assert memory_store.as_utc(stored.period_start) == datetime(2015, 4, 1, tzinfo=UTC)
        assert len((await session.scalars(select(Memory))).all()) == 1
    await engine.dispose()


@pytest.mark.asyncio
async def test_neighbors_are_reference_only(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    first = await add_memory(
        factory,
        memory_row(
            "春に引っ越した",
            category="event",
            specific_terms=["引っ越し"],
            event_at=datetime(2024, 4, 1, tzinfo=UTC),
        ),
    )
    second = await add_memory(
        factory,
        memory_row(
            "秋に引っ越した",
            category="event",
            specific_terms=["引っ越し"],
            event_at=datetime(2024, 10, 1, tzinfo=UTC),
        ),
    )
    async with factory() as session:
        ctx = make_ctx()
        result = await memory_store.agent_search_neighbors(
            session, ctx, anchor_id=first.id, offset=1
        )
        assert result["reference_only"] is True
        assert [row["id"] for row in result["rows"]] == [second.id]
        assert ctx.outcomes[second.id] == "reference"
        delivered, _, _ = memory_store.select_disclosure(ctx, [second.id], [])
        assert delivered == []
    await engine.dispose()


@pytest.mark.asyncio
async def test_missed_terms_are_filed_as_abstract_terms(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    row = await add_memory(
        factory,
        memory_row("ピアノを習っている", specific_terms=["ピアノ"], keywords=[]),
    )
    async with factory() as session:
        ctx = make_ctx()
        missed = await memory_store.agent_search(session, ctx, terms=["レッスン"])
        assert missed["status"] == "no_hit"
        assert ctx.missed_terms == ["レッスン"]
        hit = await memory_store.agent_search(session, ctx, terms=["ピアノ"])
        await session.commit()
        assert hit["status"] == "hit"
        stored = await session.get(Memory, row.id)
        assert "レッスン" in (stored.keywords or [])
        assert "レッスン" not in (stored.specific_terms or [])
    await engine.dispose()


def test_learn_terms_promotes_only_demonstrated_terms() -> None:
    row = memory_row("ピアノを習っている", specific_terms=[], keywords=["音楽", "ピアノ"])
    changed = memory_store.learn_terms(row, ["ピアノ", "音楽", "無関係な語"])
    assert changed is True
    assert "ピアノ" in (row.specific_terms or [])
    assert "ピアノ" not in (row.keywords or [])
    assert "音楽" in (row.keywords or [])
    assert "無関係な語" not in (row.keywords or [])
    assert "無関係な語" not in (row.specific_terms or [])


@pytest.mark.asyncio
async def test_resident_set_follows_links_and_the_summary_window(
    tmp_path: Path,
) -> None:
    engine, factory = await make_factory(tmp_path)
    row = await add_memory(factory, memory_row("紅茶が好き", specific_terms=["紅茶"]))
    async with factory() as session:
        first = Message(role="user", content="一言目", created_at=NOW)
        second = Message(role="user", content="二言目", created_at=NOW)
        session.add_all([first, second])
        await session.commit()
        await memory_store.record_links(session, first.id, [DeliveredMemory(row, "new")])
        await session.commit()

        resident = await memory_store.resident_memories(
            session, Settings(), before_message_id=second.id
        )
        assert [(item.memory.id, item.delivery) for item in resident] == [(row.id, "hit")]

        summary = Summary(
            start_message_id=first.id,
            end_message_id=first.id,
            content="要約",
            active=True,
            created_at=NOW,
        )
        session.add(summary)
        await session.commit()
        resident = await memory_store.resident_memories(
            session, Settings(), before_message_id=second.id
        )
        assert resident == []
    await engine.dispose()


@pytest.mark.asyncio
async def test_meta_memories_are_rejected(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    async with factory() as session:
        ctx = make_ctx()
        result = await memory_store.agent_save(
            session,
            ctx,
            content="キーワードで記憶を検索した",
            category="state",
            importance=3,
            provenance="explicit",
            specific_terms=[],
            abstract_terms=[],
        )
        await session.commit()
        assert result == {"error": "meta_memory_rejected"}
        assert (await session.scalars(select(Memory))).all() == []
    await engine.dispose()


@pytest.mark.asyncio
async def test_confirm_period_keeps_the_unsent_bound(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    row = await add_memory(
        factory,
        memory_row(
            "昔バイオリンを習っていた",
            period_start=None,
            period_end=NOW,
            provisional=True,
        ),
    )
    async with factory() as session:
        ctx = make_ctx()
        result = await memory_store.agent_confirm_period(
            session, ctx, memory_id=row.id, period_start=datetime(2015, 4, 1, tzinfo=UTC)
        )
        await session.commit()
        assert result == {"id": row.id, "action": "confirmed"}
        stored = await session.get(Memory, row.id)
        assert stored.provisional is False
        assert memory_store.as_utc(stored.period_start) == datetime(2015, 4, 1, tzinfo=UTC)
        # The end the provisional placement already carried is kept,
        # not erased to open by the omission.
        assert memory_store.as_utc(stored.period_end) == NOW
    await engine.dispose()


@pytest.mark.asyncio
async def test_confirm_without_any_time_is_rejected(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    state_row = await add_memory(
        factory,
        memory_row(
            "昔バイオリンを習っていた",
            period_start=None,
            period_end=NOW,
            provisional=True,
        ),
    )
    event_row = await add_memory(
        factory,
        memory_row(
            "発表会に出た",
            category="event",
            event_at=NOW,
            provisional=True,
        ),
    )
    async with factory() as session:
        ctx = make_ctx()
        assert await memory_store.agent_confirm_period(session, ctx, memory_id=state_row.id) == {
            "error": "no_time_given"
        }
        assert await memory_store.agent_confirm_period(session, ctx, memory_id=event_row.id) == {
            "error": "no_time_given"
        }
        await session.commit()
        assert (await session.get(Memory, state_row.id)).provisional is True
        assert (await session.get(Memory, event_row.id)).provisional is True
    await engine.dispose()


@pytest.mark.asyncio
async def test_correct_unparseable_period_value_keeps_the_stored_bound(
    tmp_path: Path,
) -> None:
    engine, factory = await make_factory(tmp_path)
    end = datetime(2026, 6, 1, tzinfo=UTC)
    row = await add_memory(
        factory,
        memory_row("東京に住んでいる", period_start=NOW - timedelta(days=30), period_end=end),
    )
    async with factory() as session:
        ctx = make_ctx()
        result = await memory_store.agent_correct(
            session, ctx, memory_id=row.id, updates={"period_end": "来年の春ごろ"}
        )
        await session.commit()
        assert result["action"] == "corrected"
        stored = await session.get(Memory, row.id)
        # The unparseable string did not land as None: the bound stands.
        assert memory_store.as_utc(stored.period_end) == end

        ctx = make_ctx()
        await memory_store.agent_correct(
            session, ctx, memory_id=row.id, updates={"period_end": None}
        )
        await session.commit()
        stored = await session.get(Memory, row.id)
        # An explicit null is a deliberate clear and does open it.
        assert stored.period_end is None
    await engine.dispose()


@pytest.mark.asyncio
async def test_matched_save_keeps_the_known_period_end(tmp_path: Path) -> None:
    engine, factory = await make_factory(tmp_path)
    end = datetime(2026, 6, 1, tzinfo=UTC)
    row = await add_memory(
        factory,
        memory_row(
            "紅茶が好きで毎朝飲んでいる",
            period_start=NOW - timedelta(days=30),
            period_end=end,
            specific_terms=["紅茶"],
            keywords=["飲み物"],
        ),
    )
    async with factory() as session:
        ctx = make_ctx()
        result = await memory_store.agent_save(
            session,
            ctx,
            content="紅茶が好きで毎朝飲んでいる",
            category="state",
            importance=3,
            provenance="explicit",
            specific_terms=["紅茶"],
            abstract_terms=["飲み物"],
            period_start=NOW,
            period_end=None,
        )
        await session.commit()
        assert result["action"] == "matched"
        stored = await session.get(Memory, row.id)
        # The restatement said nothing about the end: it is not
        # widened away to open.
        assert memory_store.as_utc(stored.period_end) == end
    await engine.dispose()


@pytest.mark.asyncio
async def test_save_rejects_an_unknown_category_and_repairs_provenance(
    tmp_path: Path,
) -> None:
    engine, factory = await make_factory(tmp_path)
    async with factory() as session:
        ctx = make_ctx()
        rejected = await memory_store.agent_save(
            session,
            ctx,
            content="来週旅行に行く",
            category="episodic",
            importance=3,
            provenance="explicit",
            specific_terms=["旅行"],
            abstract_terms=["予定"],
            event_at=NOW,
        )
        await session.commit()
        assert rejected == {"error": "invalid_category"}
        assert (await session.scalars(select(Memory))).all() == []

        ctx = make_ctx()
        created = await memory_store.agent_save(
            session,
            ctx,
            content="来週旅行に行く",
            category="event",
            importance=3,
            provenance="guess",
            specific_terms=["旅行"],
            abstract_terms=["予定"],
            event_at=NOW,
        )
        await session.commit()
        assert created["action"] == "created"
        stored = await session.get(Memory, created["id"])
        assert stored.provenance == "inferred"
    await engine.dispose()
