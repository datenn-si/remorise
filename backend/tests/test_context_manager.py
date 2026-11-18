import time
from datetime import UTC, datetime, timedelta, timezone

import pytest

from app.database.models import CharacterState, Memory, Message
from app.schemas.character import CharacterConfig
from app.services.context_manager import (
    build_system_prompt,
    elapsed_since_text,
    format_current_time,
    history_as_messages,
    message_time_text,
)
from app.services.memory_store import DeliveredMemory


def _character(**overrides: object) -> CharacterConfig:
    data: dict[str, object] = {"name": "テスト"}
    data.update(overrides)
    return CharacterConfig(**data)


def _state() -> CharacterState:
    return CharacterState(emotion="neutral", intensity=0.0, mood="neutral", affinity=50)


def _prompt(character: CharacterConfig) -> str:
    return build_system_prompt(character, _state(), summary=None).replace("\r\n", "\n")


def test_speech_style_line_is_included_when_set() -> None:
    prompt = _prompt(_character(speech_style="語尾は『〜だよ』"))
    assert "口調: 語尾は『〜だよ』" in prompt


def test_speech_style_line_keeps_its_position_when_set() -> None:
    prompt = _prompt(_character(speech_style="穏やかで簡潔"))
    assert "性格: 未指定\n口調: 穏やかで簡潔\n一人称: 私 / 二人称: あなた" in prompt


def test_speech_style_line_is_omitted_when_empty() -> None:
    prompt = _prompt(_character(speech_style=""))
    assert "口調" not in prompt
    assert "性格: 未指定\n一人称: 私 / 二人称: あなた" in prompt


def test_speech_style_line_is_omitted_when_unset() -> None:
    prompt = _prompt(_character())
    assert "口調" not in prompt


def test_speech_style_line_is_omitted_when_whitespace_only() -> None:
    prompt = _prompt(_character(speech_style=" 　"))
    assert "口調" not in prompt


def test_sentence_endings_line_is_separate_from_speech_style() -> None:
    prompt = _prompt(_character(speech_style="穏やかで簡潔", sentence_endings="〜だよ、〜だね"))
    assert (
        "性格: 未指定\n口調: 穏やかで簡潔\n語尾の例: 〜だよ、〜だね\n一人称: 私 / 二人称: あなた"
        in prompt
    )


def test_sentence_endings_line_is_omitted_when_unset() -> None:
    prompt = _prompt(_character(speech_style="穏やかで簡潔"))
    assert "語尾の例" not in prompt
    assert "性格: 未指定\n口調: 穏やかで簡潔\n一人称: 私 / 二人称: あなた" in prompt


def test_basic_attributes_render_as_their_own_lines() -> None:
    prompt = _prompt(_character(gender="女性", birthday="4月3日", appearance="銀髪で小柄"))
    assert "性別: 女性\n誕生日: 4月3日\n容姿: 銀髪で小柄\n" in prompt


def test_basic_attributes_are_omitted_when_unset() -> None:
    prompt = _prompt(_character())
    assert "性別:" not in prompt
    assert "誕生日:" not in prompt
    assert "容姿:" not in prompt


def test_legacy_character_json_loads_with_empty_new_fields() -> None:
    legacy = CharacterConfig.model_validate_json('{"name": "旧", "speech_style": "穏やか"}')
    assert legacy.sentence_endings == ""
    assert legacy.gender == ""
    assert legacy.birthday == ""
    assert legacy.appearance == ""


def test_reply_language_rule_is_in_the_prompt() -> None:
    prompt = build_system_prompt(_character(), _state(), summary=None)
    assert "応答は日本語で書いてください" in prompt
    assert "日本語以外での応答を明示的に求めた場合だけ" in prompt


def test_anger_rule_is_in_the_prompt() -> None:
    prompt = build_system_prompt(_character(), _state(), summary=None)
    assert "怒りを感じて、その気持ちを素直に表してかまいません" in prompt
    assert "常に穏やかでいようとしたりする必要はありません" in prompt
    assert "怒り方や言葉遣いは、あなた自身の性格や話し方のままにしてください" in prompt


def test_current_time_is_injected_only_when_given() -> None:
    without = build_system_prompt(_character(), _state(), summary=None)
    assert "現在日時:" not in without
    with_time = build_system_prompt(
        _character(),
        _state(),
        summary=None,
        current_time="2026年11月9日（月曜日） 22時26分（JST / UTC+09:00）",
    )
    assert "現在日時: 2026年11月9日（月曜日） 22時26分（JST / UTC+09:00）" in with_time


def test_system_prompt_has_no_tool_instructions() -> None:
    prompt = _prompt(_character())
    assert "get_current_time" not in prompt
    assert "lineage_key" not in prompt
    assert "推測せず" in prompt
    assert "挨拶は、実際の時間帯に合わせてください" in prompt


def _memory(content: str, **kwargs: object) -> Memory:
    defaults: dict[str, object] = {
        "category": "state",
        "importance": 3,
        "status": "active",
        "is_active": True,
        "provenance": "explicit",
        "source_type": "conversation",
    }
    defaults.update(kwargs)
    return Memory(content=content, **defaults)


def test_latest_and_resident_memories_render_with_delivery_labels() -> None:
    hit = DeliveredMemory(memory=_memory("紅茶が好き", id=1), delivery="hit")
    recalled = DeliveredMemory(memory=_memory("猫を飼っている", id=2), delivery="recall")
    created = DeliveredMemory(
        memory=_memory("来週旅行に行く", id=3, category="event"), delivery="new"
    )
    prompt = build_system_prompt(
        _character(),
        _state(),
        summary=None,
        latest=[hit, created],
        resident=[hit, recalled],
    ).replace("\r\n", "\n")
    assert "今回の記憶:" in prompt
    assert "[知っている記憶]（状態）紅茶が好き" in prompt
    assert "[今回覚えたこと]（出来事）来週旅行に行く" in prompt
    assert "これまでの文脈にある記憶:" in prompt
    assert "[指摘されて今思い出した記憶]（状態）猫を飼っている" in prompt
    # The resident copy of a memory also in the latest set is not repeated.
    assert prompt.count("紅茶が好き") == 1


def test_ask_back_material_is_not_presented_as_fact() -> None:
    provisional = _memory("昔ピアノを習っていた", id=7, provisional=True)
    prompt = build_system_prompt(
        _character(), _state(), summary=None, ask_back=[provisional]
    ).replace("\r\n", "\n")
    assert "昔ピアノを習っていた（時期不明）" in prompt
    assert "事実として扱わず" in prompt
    assert "繰り返し聞かないでください" in prompt


def test_forgotten_notification_carries_terms_but_no_content() -> None:
    prompt = build_system_prompt(
        _character(),
        _state(),
        summary=None,
        notification={"terms": ["ピアノ"]},
    ).replace("\r\n", "\n")
    assert "「ピアノ」に関連して、何か忘れていることがあるようです" in prompt
    assert "内容を推測で作らないでください" in prompt


def test_format_current_time_includes_weekday_and_timezone() -> None:
    jst = timezone(timedelta(hours=9))
    text = format_current_time(datetime(2026, 11, 9, 22, 26, tzinfo=jst))
    assert "2026年11月9日（月曜日）" in text
    assert "22時26分" in text
    assert "UTC+09:00" in text


@pytest.fixture
def local_timezone(monkeypatch: pytest.MonkeyPatch):
    """The machine running the tests may itself be on UTC, where the
    local rendering of a stored instant coincides with UTC; pinning
    the zone keeps the local rendering observable everywhere.
    """
    if not hasattr(time, "tzset"):
        pytest.skip("time.tzset is unavailable on this platform")

    def set_zone(name: str) -> None:
        monkeypatch.setenv("TZ", name)
        time.tzset()

    yield set_zone
    monkeypatch.undo()
    time.tzset()


def test_message_time_text_is_local_iso_with_offset(local_timezone) -> None:
    local_timezone("Asia/Tokyo")
    value = datetime(2026, 11, 12, 22, 45, tzinfo=UTC)
    assert message_time_text(value) == "2026-11-13T07:45+09:00"


def test_history_labels_mark_user_messages_only(local_timezone) -> None:
    local_timezone("Asia/Tokyo")
    rows = [
        Message(
            role="user",
            content="おはよう",
            created_at=datetime(2026, 11, 12, 22, 45, tzinfo=UTC),
        ),
        Message(
            role="assistant",
            content="おはようございます",
            created_at=datetime(2026, 11, 12, 22, 46, tzinfo=UTC),
        ),
    ]
    messages = history_as_messages(rows)
    assert messages[0]["role"] == "user"
    assert messages[0]["content"] == "[2026-11-13T07:45+09:00] おはよう"
    # The character's own past messages carry no label: shown one on
    # its own speech, it imitates the shape in its replies.
    assert messages[1]["content"] == "おはようございます"


def test_history_label_treats_a_naive_stamp_as_utc(local_timezone) -> None:
    local_timezone("Asia/Tokyo")
    rows = [
        Message(
            role="user",
            content="時刻なし",
            created_at=datetime(2026, 11, 12, 22, 45),
        )
    ]
    messages = history_as_messages(rows)
    assert messages[0]["content"] == "[2026-11-13T07:45+09:00] 時刻なし"


_NOW = datetime(2026, 11, 13, 15, 20, tzinfo=UTC)


def test_elapsed_under_an_hour_is_not_mentioned() -> None:
    assert elapsed_since_text(_NOW - timedelta(minutes=59), _NOW) is None
    assert elapsed_since_text(_NOW - timedelta(minutes=5), _NOW) is None


def test_elapsed_in_the_future_is_not_mentioned() -> None:
    assert elapsed_since_text(_NOW + timedelta(hours=2), _NOW) is None


def test_elapsed_hours_are_rounded_to_a_rough_unit() -> None:
    assert elapsed_since_text(_NOW - timedelta(hours=1), _NOW) == "約1時間"
    assert elapsed_since_text(_NOW - timedelta(hours=3, minutes=12), _NOW) == "約3時間"
    assert elapsed_since_text(_NOW - timedelta(hours=23), _NOW) == "約23時間"


def test_elapsed_days_months_and_years() -> None:
    assert elapsed_since_text(_NOW - timedelta(days=2), _NOW) == "約2日"
    assert elapsed_since_text(_NOW - timedelta(days=10), _NOW) == "約10日"
    assert elapsed_since_text(_NOW - timedelta(days=45), _NOW) == "約1か月"
    assert elapsed_since_text(_NOW - timedelta(days=90), _NOW) == "約3か月"
    assert elapsed_since_text(_NOW - timedelta(days=400), _NOW) == "約1年"


def test_elapsed_line_follows_the_current_time_in_the_prompt() -> None:
    prompt = build_system_prompt(
        _character(),
        _state(),
        summary=None,
        current_time="2026年11月13日（金曜日） 15時20分（JST / UTC+09:00）",
        elapsed_since_previous="約2日",
    ).replace("\r\n", "\n")
    assert (
        "現在日時: 2026年11月13日（金曜日） 15時20分（JST / UTC+09:00）\n"
        "前回のメッセージから約2日経過しています\n"
    ) in prompt


def test_elapsed_line_is_absent_by_default() -> None:
    prompt = _prompt(_character())
    assert "前回のメッセージから" not in prompt


def test_system_prompt_explains_the_history_time_labels() -> None:
    prompt = _prompt(_character())
    label_rule = (
        "会話履歴のユーザーのメッセージの先頭にある [日時] は、"
        "そのメッセージが送られた時刻を示す目印です"
    )
    assert label_rule in prompt
    assert "目印はあなたの発言に付けるものではありません" in prompt


def test_state_is_presented_as_a_system_record_not_a_voice_model() -> None:
    prompt = _prompt(_character())
    assert (
        "現在の状態（システムによる判定の記録）: 感情=neutral（強さ 0.00）"
        " / 気分=neutral / 好感度=50"
    ) in prompt
    assert "状態の文面は、あなたの発言の手本ではありません。" in prompt
