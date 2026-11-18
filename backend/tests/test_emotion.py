from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import Settings
from app.database.models import CharacterState, Message, StateHistory
from app.database.session import create_engine, initialize_database
from app.schemas.state import EmotionAnalysis, StateAnalysis
from app.services.emotion_service import (
    MOOD_MAX_LENGTH,
    apply_state_analysis,
    decay_emotion,
    effective_mood,
    fallback_mood,
    normalize_mood,
)


def test_puzzled_is_a_valid_emotion() -> None:
    parsed = EmotionAnalysis(primary="puzzled", intensity=0.3, mood="考え中")
    assert parsed.primary == "puzzled"


def test_emotion_decays_exponentially_and_resets_to_neutral() -> None:
    now = datetime.now(UTC)
    state = CharacterState(
        emotion="happy",
        intensity=0.8,
        secondary_emotion="surprised",
        secondary_intensity=0.4,
        last_emotion_update=now - timedelta(minutes=30),
    )
    settings = Settings(emotion_half_life_minutes=30)

    assert decay_emotion(state, settings, now)
    assert state.intensity == 0.4
    assert state.secondary_intensity == 0.2

    state.last_emotion_update = now - timedelta(minutes=180)
    decay_emotion(state, settings, now)
    assert state.emotion == "neutral"
    assert state.intensity == 0.0
    assert state.secondary_emotion is None


async def test_state_analysis_limits_affinity_and_is_idempotent(tmp_path) -> None:
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / 'analysis.db'}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)
    async with factory() as session:
        state = CharacterState(id=1, affinity=50)
        session.add(state)
        await session.commit()
        settings = Settings()
        analysis = StateAnalysis.model_validate(
            {
                "emotion": {
                    "primary": "happy",
                    "intensity": 0.8,
                    "secondary": None,
                    "secondary_intensity": 0,
                    "mood": "positive",
                },
                "affinity": {"delta": 50, "reason": "kindness"},
            }
        )
        result = await apply_state_analysis(session, settings, 17, analysis)
        assert result is not None
        assert result.affinity == 55
        await apply_state_analysis(session, settings, 17, analysis)
        history = list((await session.scalars(select(StateHistory))).all())
        assert len(history) == 1
    await engine.dispose()


async def test_state_analysis_clamps_affinity_at_the_default_cap(tmp_path) -> None:
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / 'cap.db'}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)
    async with factory() as session:
        session.add(CharacterState(id=1, affinity=198))
        await session.commit()
        analysis = StateAnalysis.model_validate(
            {
                "emotion": {
                    "primary": "happy",
                    "intensity": 0.8,
                    "secondary": None,
                    "secondary_intensity": 0,
                    "mood": "positive",
                },
                "affinity": {"delta": 50, "reason": "kindness"},
            }
        )
        result = await apply_state_analysis(session, Settings(), 23, analysis)
        assert result is not None
        assert result.affinity == 200
    await engine.dispose()


async def test_reused_message_id_does_not_keep_a_stale_analysis(tmp_path) -> None:
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / 'reuse.db'}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)
    async with factory() as session:
        session.add(CharacterState(id=1, affinity=50))
        session.add(
            Message(
                id=17,
                role="user",
                content="いまの話",
                created_at=datetime(2026, 11, 5, tzinfo=UTC),
            )
        )
        session.add(
            StateHistory(
                message_id=17,
                emotion_before="neutral",
                emotion_after="sad",
                affinity_before=40,
                affinity_after=40,
                reason="old turn",
                created_at=datetime(2026, 10, 31, tzinfo=UTC),
            )
        )
        await session.commit()
        analysis = StateAnalysis.model_validate(
            {
                "emotion": {
                    "primary": "happy",
                    "intensity": 0.7,
                    "secondary": None,
                    "secondary_intensity": 0,
                    "mood": "安心",
                },
                "affinity": {"delta": 2, "reason": "満足"},
            }
        )
        result = await apply_state_analysis(session, Settings(), 17, analysis)
        assert result is not None
        assert result.emotion == "happy"
        assert result.affinity == 52
        history = list((await session.scalars(select(StateHistory))).all())
        assert [row.message_id for row in history].count(17) == 1
        assert any(row.message_id is None for row in history)
    await engine.dispose()


def test_normalize_mood_strips_dialogue_framing() -> None:
    assert normalize_mood("「あたし、ドキドキしちゃう…！」") == "あたし、ドキドキしちゃう…！"
    assert normalize_mood("ほっとしている\n余計な二行目") == "ほっとしている"
    assert normalize_mood("  少し緊張しているが楽しそう  ") == "少し緊張しているが楽しそう"
    assert normalize_mood("「」") == ""


def test_normalize_mood_caps_length() -> None:
    assert len(normalize_mood("あ" * 100)) == MOOD_MAX_LENGTH


async def test_applied_mood_is_normalized_and_never_emptied(tmp_path) -> None:
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / 'mood.db'}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)

    def analysis_with(mood: str) -> StateAnalysis:
        return StateAnalysis.model_validate(
            {
                "emotion": {
                    "primary": "happy",
                    "intensity": 0.6,
                    "secondary": None,
                    "secondary_intensity": 0,
                    "mood": mood,
                },
                "affinity": {"delta": 0, "reason": ""},
            }
        )

    async with factory() as session:
        session.add(CharacterState(id=1, affinity=50, mood="穏やか"))
        await session.commit()
        result = await apply_state_analysis(
            session, Settings(), 21, analysis_with("「嬉しいな…！」")
        )
        assert result is not None
        assert result.mood == "嬉しいな…！"
        result = await apply_state_analysis(session, Settings(), 22, analysis_with("「」"))
        assert result is not None
        assert result.mood == "嬉しいな…！"
    await engine.dispose()


def _emotion(mood: str, primary: str = "happy", intensity: float = 0.4) -> EmotionAnalysis:
    return EmotionAnalysis(primary=primary, intensity=intensity, mood=mood)


def test_effective_mood_replaces_a_multi_sentence_monologue() -> None:
    monologue = "え、そうか。計算して覚えていたんだな。ちょっと嬉しい。"
    assert effective_mood(_emotion(monologue)) == "嬉しそう"
    assert effective_mood(_emotion("嬉しい！本当に嬉しい！")) == "嬉しそう"


def test_effective_mood_keeps_a_single_short_phrase() -> None:
    assert effective_mood(_emotion("少し嬉しそう")) == "少し嬉しそう"
    assert effective_mood(_emotion("驚いて喜んでいる")) == "驚いて喜んでいる"
    assert effective_mood(_emotion("ほっとしている。")) == "ほっとしている。"


def test_fallback_mood_scales_with_intensity() -> None:
    assert fallback_mood(_emotion("x", intensity=0.8)) == "とても嬉しそう"
    assert fallback_mood(_emotion("x", intensity=0.2)) == "少し嬉しそう"
    assert fallback_mood(_emotion("x", primary="surprised", intensity=0.5)) == "驚いている"


async def test_applied_monologue_mood_becomes_the_neutral_fallback(tmp_path) -> None:
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / 'monologue.db'}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)
    analysis = StateAnalysis.model_validate(
        {
            "emotion": {
                "primary": "happy",
                "intensity": 0.4,
                "secondary": "surprised",
                "secondary_intensity": 0.3,
                "mood": "え、そうか。計算して覚えていたんだな。ちょっと嬉しい。",
            },
            "affinity": {"delta": 1, "reason": "覚えていてくれた"},
        }
    )
    async with factory() as session:
        session.add(CharacterState(id=1, affinity=50, mood="穏やか"))
        await session.commit()
        result = await apply_state_analysis(session, Settings(), 23, analysis)
        assert result is not None
        assert result.mood == "嬉しそう"
    await engine.dispose()
