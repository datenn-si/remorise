"""Token accounting for the summary budget.

Counts live on the message and summary rows as ``{"model id": tokens}``.
Filling a missing key is a read-merge-write of that JSON, so it runs
only inside the post-processing worker, which is the one place that
holds the inference lock without a chat turn also writing the column.
A startup pass would race those writes and drop a count.
"""

import hashlib
from collections.abc import Sequence

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.database.models import (
    CharacterState,
    Message,
    Summary,
    SystemPromptTokens,
    UserProfile,
)
from app.schemas.character import CharacterConfig
from app.services.context_manager import (
    count_tokens,
    fixed_system_text,
    history_as_messages,
    state_value_line,
)


def with_model_count(current: dict | None, model: str, count: int) -> dict[str, int]:
    merged = dict(current or {})
    merged[model] = count
    return merged


def model_count(current: dict | None, model: str) -> int | None:
    if not current or model not in current:
        return None
    try:
        return int(current[model])
    except (TypeError, ValueError):
        return None


def message_token_text(row: Message) -> str:
    """What this message contributes to the context the budget plans for.

    A user message is counted as stage C sends it, send-time label
    included. An assistant message is the saved body: the turn stores
    ``completion_tokens`` when the stream reported usage, and this text
    is the fallback plus the recount for a model that did not generate it.
    """
    if row.role == "assistant":
        return row.content or ""
    rendered = history_as_messages([row])
    return str(rendered[0]["content"]) if rendered else ""


def summary_token_estimate(previous_tokens: int, max_tokens: int) -> int:
    """The next summary is the last measured one plus room to grow.

    The room is another copy of the last summary: folding in a range
    can about double it. One generation is as long as the summarizer
    can return. With no measurement, reserve that whole generation.
    """
    if previous_tokens <= 0:
        return max_tokens
    return min(previous_tokens * 2, max_tokens)


def older_keep_budget(
    settings: Settings,
    *,
    summary_tokens: int,
    fixed_tokens: int,
    state_tokens: int,
) -> int:
    """Tokens the messages older than the protected tail may still occupy.

    The protected tail is kept regardless of this budget, so it is not
    subtracted here.
    """
    target = int(settings.llm_context_size * settings.context_target_ratio)
    return (
        target
        - summary_tokens
        - fixed_tokens
        - settings.memory_handover_token_budget
        - state_tokens
    )


def split_protected(
    rows: Sequence[Message], protected_count: int
) -> tuple[list[Message], list[Message]]:
    """``(older, protected)``. The protected tail is the last N messages.

    When the oldest protected message is an assistant reply, the user
    message it answers is protected too, so a pair is never split.
    """
    if protected_count <= 0 or not rows:
        return list(rows), []
    count = min(protected_count, len(rows))
    older = list(rows[:-count])
    protected = list(rows[-count:])
    if protected[0].role == "assistant" and older and older[-1].role == "user":
        protected.insert(0, older.pop())
    return older, protected


def summary_range_end(older: Sequence[Message], tokens: dict[int, int], budget: int) -> int | None:
    """Id of the newest message the summary should cover, or None.

    Walks the older side from the newest message backward. The message
    that pushes the sum past ``budget`` is the newest end of the range;
    everything older than it is covered too. None means the older side
    fits and nothing should be summarized.
    """
    running = 0
    for row in reversed(older):
        running += tokens.get(row.id, 0)
        if running > budget:
            return row.id
    return None


async def fill_current_model_tokens(
    session: AsyncSession,
    settings: Settings,
    rows: Sequence[Message],
    summary: Summary | None,
) -> None:
    """Count the current model where its key is missing.

    ``rows`` must already be the unsummarized window. Summarized
    messages are left alone, and no other model's key is written.
    """
    model = settings.llm_model
    for row in rows:
        if model_count(row.token, model) is not None:
            continue
        counted = await count_tokens(message_token_text(row), settings)
        row.token = with_model_count(row.token, model, counted)
    if summary is not None and model_count(summary.token, model) is None:
        counted = await count_tokens(summary.content or "", settings)
        summary.token = with_model_count(summary.token, model, counted)
    await session.flush()


async def fixed_prompt_tokens(
    session: AsyncSession,
    settings: Settings,
    character: CharacterConfig,
    profile: UserProfile | None,
) -> int:
    """Stored size of the stable system prompt for the current model.

    Counts and stores the row when this model has not measured this
    text. A changed text drops that model's previous hash.
    """
    text = fixed_system_text(character, profile)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    model = settings.llm_model
    row = await session.get(SystemPromptTokens, (model, digest))
    await session.execute(
        delete(SystemPromptTokens).where(
            SystemPromptTokens.model_id == model,
            SystemPromptTokens.content_hash != digest,
        )
    )
    if row is None:
        counted = await count_tokens(text, settings)
        session.add(SystemPromptTokens(model_id=model, content_hash=digest, token_count=counted))
        await session.flush()
        return counted
    await session.flush()
    return row.token_count


async def state_line_tokens(session: AsyncSession, settings: Settings) -> int:
    state = await session.get(CharacterState, 1)
    if state is None:
        state = CharacterState(emotion="neutral", intensity=0.0, mood="neutral", affinity=50)
    return await count_tokens(state_value_line(state), settings)


async def load_profile(session: AsyncSession) -> UserProfile | None:
    """The stored profile, without creating the row the chat path creates."""
    return await session.scalar(select(UserProfile).where(UserProfile.id == 1))
