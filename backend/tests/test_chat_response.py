from app.llm.chat_response import StreamedResponseParser


def test_streamed_parser_keeps_ordinary_text() -> None:
    parser = StreamedResponseParser()
    # A trailing foreign-script run is held until it is clear no
    # gloss parenthesis follows (see the gloss rewrite), so ordinary
    # text is asserted on the concatenated output.
    visible = parser.feed("Plain ") + parser.feed("response") + parser.feed("1 < 2")
    visible += parser.finish()
    assert visible == "Plain response1 < 2"


def test_streamed_parser_treats_a_state_tag_as_ordinary_text() -> None:
    parser = StreamedResponseParser()
    text = '前<remorise_state>{"emotion": "happy"}</remorise_state>後'
    assert parser.feed(text) + parser.finish() == text


def test_streamed_parser_strips_a_leading_send_time_label() -> None:
    parser = StreamedResponseParser()
    visible = parser.feed("[2026-11-13T23:43+09:00] タロウ、か。")
    visible += parser.finish()
    assert visible == "タロウ、か。"


def test_streamed_parser_strips_a_label_split_across_chunks() -> None:
    parser = StreamedResponseParser()
    assert parser.feed("[2026-11-13T2") == ""
    assert parser.feed("3:43+09:00] こん") == "こん"
    assert parser.feed("にちは") == "にちは"
    assert parser.finish() == ""


def test_streamed_parser_strips_label_variants() -> None:
    for raw, want in [
        ("[2026-11-13T23:43:05Z] hi", "hi"),
        ("[2026-11-13T23:43] hi", "hi"),
        ("\n[2026-11-13T23:43+09:00] hi", "hi"),
    ]:
        parser = StreamedResponseParser()
        assert parser.feed(raw) + parser.finish() == want


def test_streamed_parser_keeps_other_brackets_and_inner_labels() -> None:
    parser = StreamedResponseParser()
    assert parser.feed("[メモ] こんにちは") == "[メモ] こんにちは"
    parser = StreamedResponseParser()
    text = "時刻は [2026-11-13T23:43+09:00] です"
    assert parser.feed(text) + parser.finish() == text


def test_streamed_parser_flushes_a_partial_label_at_finish() -> None:
    parser = StreamedResponseParser()
    assert parser.feed("[2026-11") == ""
    assert parser.finish() == "[2026-11"


def _visible(text: str, chunks: list[str] | None = None) -> str:
    parser = StreamedResponseParser()
    parts = chunks if chunks is not None else [text]
    return "".join(parser.feed(part) for part in parts) + parser.finish()


def test_gloss_rewrite_drops_an_english_phrase_for_its_translation() -> None:
    assert _visible("I really missed you（本当に会いたかった）") == "本当に会いたかった"


def test_gloss_rewrite_works_mid_sentence_and_with_halfwidth_parens() -> None:
    text = "今日はね、Je t'aime（愛してる）って言いたい"
    assert _visible(text) == "今日はね、愛してるって言いたい"
    assert _visible("I missed you(会いたかった)") == "会いたかった"
    assert _visible("Hello（こんにちは）") == "こんにちは"


def test_gloss_rewrite_covers_simplified_chinese_and_korean() -> None:
    assert _visible("我很想你（会いたかった）") == "会いたかった"
    assert _visible("너무 보고 싶었어（すごく会いたかった）") == "すごく会いたかった"


def test_gloss_rewrite_survives_chunk_splits() -> None:
    text = "I really missed you（本当に会いたかった）"
    assert _visible(text, chunks=list(text)) == "本当に会いたかった"
    chunks = ["I really ", "missed you（本当に", "会いたかった）"]
    assert _visible(text, chunks=chunks) == "本当に会いたかった"


def test_gloss_rewrite_leaves_readings_and_term_glosses_alone() -> None:
    for text in [
        "Remorise（レモライズ）の話",
        "API（エーピーアイ）の話",
        "entropy（エントロピー）",
        "cross entropy（交差エントロピー）の計算",
        "東京大学（とうきょうだいがく）",
        "先生（せんせい）に聞く",
        "$f(x)$（関数）のグラフ",
        "example.com（ドメインの例）",
        "我想吃拉面（ラーメンが食べたい）",
        "彼は「I missed you」と言った",
    ]:
        assert _visible(text) == text, text


def test_gloss_rewrite_leaves_plain_english_and_japanese_alone() -> None:
    assert _visible("Hello, how are you today?") == "Hello, how are you today?"
    parser = StreamedResponseParser()
    assert parser.feed("彼は学生") == "彼は"
    assert parser.feed("です") == "学生です"
    assert parser.finish() == ""
