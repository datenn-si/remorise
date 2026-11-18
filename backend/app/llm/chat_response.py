import re

# The history handed to stage C prefixes the user's messages with a
# bracketed send-time label ("[2026-11-13T07:45+09:00] "). A model
# shown that shape imitates it and opens its own reply with a label;
# the label is a context marker, never speech, so a leading one is
# dropped by the parser — deterministically, before the text is
# shown or saved.
_TIME_LABEL = re.compile(r"\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:?\d{2}|Z)?\]")
_LABEL_PREFIX_CHARS = frozenset("0123456789-+:.TZ")
# The longest label body ("2026-11-13T23:43:05+09:00") is 25 chars;
# a longer run without a closing bracket is ordinary text.
_LABEL_PREFIX_MAX = 25


def _leading_label_drop(buffer: str) -> int | None:
    """How much of ``buffer``'s head is a copied send-time label.

    Returns the number of characters to drop — the label and any
    spaces right after it — when the buffer starts with one, 0 when
    it plainly starts with something else, and None while the buffer
    could still grow into a label (a partial prefix at a chunk
    boundary), in which case nothing may be emitted yet.
    """
    text = buffer.lstrip()
    if not text:
        return None
    if not text.startswith("["):
        return 0
    closing = text.find("]", 1)
    if closing >= 0:
        if _TIME_LABEL.fullmatch(text[: closing + 1]) is None:
            return 0
        drop = len(buffer) - len(text) + closing + 1
        while drop < len(buffer) and buffer[drop] in " \t":
            drop += 1
        return drop
    inner = text[1:]
    if len(inner) <= _LABEL_PREFIX_MAX and all(char in _LABEL_PREFIX_CHARS for char in inner):
        return None
    return 0


# Language drift under the Japanese-only rule often takes the shape
# "foreign text (Japanese translation)": the model writes a phrase in
# another language and appends its Japanese gloss in parentheses. A
# completed pattern is rewritten to the gloss alone, deterministically,
# before the text is shown or saved — the same treatment the copied
# send-time label gets. The match is kept deliberately narrow so
# ordinary Japanese is never rewritten: the gloss must contain
# hiragana (a translation does; readings and term glosses are
# katakana / kanji and stay), and a run of CJK ideographs counts as
# foreign only when it contains a simplified-Chinese character that
# Japanese does not use, so Japanese kanji compounds (学生, 時間)
# are never mistaken for Chinese.

_RUN_PUNCT = frozenset(" '’.,!?;:-—–")
_OPEN_PARENS = frozenset("（(")
_CLOSE_PARENS = frozenset("）)")
_GLOSS_MAX_LENGTH = 40
_RUN_HOLD_MAX_LENGTH = 60
_SIMPLIFIED_ONLY = frozenset("们这么吗现时说间对还过很你为让给从个哪咱")
_START_BLOCKERS = frozenset("$`_/")


def _is_latin(char: str) -> bool:
    return (
        "a" <= char <= "z"
        or "A" <= char <= "Z"
        or "À" <= char <= "ÿ"
        and char not in "×÷"
        or "Ā" <= char <= "ſ"
    )


def _is_hangul(char: str) -> bool:
    return "가" <= char <= "힣"


def _is_cyrillic(char: str) -> bool:
    return "Ѐ" <= char <= "ӿ"


def _is_cjk(char: str) -> bool:
    return "一" <= char <= "鿿" or "㐀" <= char <= "䶿"


def _is_hiragana(char: str) -> bool:
    return "぀" <= char <= "ゟ"


def _script_of(char: str) -> str | None:
    if _is_latin(char):
        return "latin"
    if _is_hangul(char):
        return "hangul"
    if _is_cyrillic(char):
        return "cyrillic"
    if _is_cjk(char):
        return "cjk"
    return None


_LETTER_CHECKS = {
    "latin": _is_latin,
    "hangul": _is_hangul,
    "cyrillic": _is_cyrillic,
    "cjk": _is_cjk,
}


def _candidate_start(text: str, cursor: int) -> int | None:
    for index in range(cursor, len(text)):
        script = _script_of(text[index])
        if script is None:
            continue
        if index > 0:
            previous = text[index - 1]
            if previous in _START_BLOCKERS or previous.isdigit():
                continue
            if _script_of(previous) == script:
                continue
        return index
    return None


def _foreign_run(text: str, start: int) -> tuple[int, int, str, bool] | None:
    """Parse the foreign-script run at ``start``.

    Returns (letter_end, consumed_end, script, complete): the run's
    letters end at letter_end (a gloss parenthesis must follow
    there), scanning stopped at consumed_end (trailing punctuation
    and spaces included), and complete is False when the run may
    still grow past the end of ``text``.
    """
    script = _script_of(text[start])
    if script is None:
        return None
    is_letter = _LETTER_CHECKS[script]
    if script == "cjk":
        end = start
        while end < len(text) and is_letter(text[end]):
            end += 1
        return end, end, script, end < len(text)
    letter_end = start
    end = start
    while end < len(text):
        char = text[end]
        if is_letter(char):
            letter_end = end + 1
            end += 1
        elif char in _RUN_PUNCT:
            end += 1
        else:
            break
    return letter_end, end, script, end < len(text)


def _is_gloss_pattern(run: str, script: str, gloss: str) -> bool:
    if not gloss or len(gloss) > _GLOSS_MAX_LENGTH:
        return False
    if any(_is_latin(char) for char in gloss):
        return False
    if not any(_is_hiragana(char) for char in gloss):
        return False
    if script == "cjk":
        return len(run) >= 2 and any(char in _SIMPLIFIED_ONLY for char in run)
    if script == "latin":
        if sum(1 for char in run if _is_latin(char)) < 2:
            return False
        return "." not in run.rsplit(" ", 1)[-1]
    return sum(1 for char in run if char not in _RUN_PUNCT) >= 2


def _gloss_rewrite(text: str, final: bool) -> tuple[str, int]:
    """Rewrite completed "foreign (Japanese gloss)" patterns.

    Returns the possibly rewritten text and how much of it is
    settled — safe to emit. An unfinished pattern at the end holds
    the text from its start (a foreign run longer than the hold
    limit is settled as-is; the drift this targets is short
    phrases). ``final`` settles everything.
    """
    cursor = 0
    while cursor < len(text):
        start = _candidate_start(text, cursor)
        if start is None:
            return text, len(text)
        parsed = _foreign_run(text, start)
        if parsed is None:
            cursor = start + 1
            continue
        letter_end, consumed_end, script, complete = parsed
        if not complete:
            if final or letter_end - start > _RUN_HOLD_MAX_LENGTH:
                return text, len(text)
            return text, start
        if (
            letter_end == consumed_end
            and letter_end < len(text)
            and text[letter_end] in _OPEN_PARENS
        ):
            gloss_start = letter_end + 1
            close = gloss_start
            while close < len(text):
                char = text[close]
                if (
                    char in _CLOSE_PARENS
                    or char in _OPEN_PARENS
                    or char == "\n"
                    or close - gloss_start >= _GLOSS_MAX_LENGTH
                ):
                    break
                close += 1
            if close >= len(text):
                return (text, len(text)) if final else (text, start)
            if text[close] in _CLOSE_PARENS:
                gloss = text[gloss_start:close]
                if _is_gloss_pattern(text[start:letter_end], script, gloss):
                    text = text[:start] + gloss + text[close + 1 :]
                    cursor = 0
                    continue
                cursor = close + 1
                continue
            cursor = gloss_start
            continue
        cursor = consumed_end
    return text, len(text)


class StreamedResponseParser:
    def __init__(self) -> None:
        self._buffer = ""
        self._label_pending = True

    def feed(self, chunk: str) -> str:
        self._buffer += chunk
        if self._label_pending:
            drop = _leading_label_drop(self._buffer)
            if drop is None:
                return ""
            self._label_pending = False
            if drop:
                self._buffer = self._buffer[drop:]
        self._buffer, settled = _gloss_rewrite(self._buffer, final=False)
        output = self._buffer[:settled]
        self._buffer = self._buffer[settled:]
        return output

    def finish(self) -> str:
        output, self._buffer = self._buffer, ""
        output, _ = _gloss_rewrite(output, final=True)
        return output
