import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.types import TypeDecorator


def utc_now() -> datetime:
    return datetime.now(UTC)


class KeywordListJSON(TypeDecorator):
    """The memories FTS index reads this column directly, so Japanese
    keywords must be stored as literal characters: ASCII-escaped
    storage would make them unmatchable by Japanese query terms.
    """

    impl = Text
    cache_ok = True

    def process_bind_param(self, value: list[str] | None, dialect: object) -> str | None:
        if value is None:
            return None
        return json.dumps(value, ensure_ascii=False)

    def process_result_value(self, value: str | None, dialect: object) -> list[str] | None:
        if value is None:
            return None
        loaded = json.loads(value)
        return loaded if isinstance(loaded, list) else []


class Base(DeclarativeBase):
    pass


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    messages: Mapped[list["Message"]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan"
    )


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), default=1, index=True
    )
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text, default="")
    tool_calls: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, nullable=True)
    tool_call_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    metadata_json: Mapped[dict[str, Any] | None] = mapped_column("metadata", JSON, nullable=True)
    archived_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    conversation: Mapped[Conversation] = relationship(back_populates="messages")


class Summary(Base):
    __tablename__ = "summaries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    content: Mapped[str] = mapped_column(Text)
    start_message_id: Mapped[int] = mapped_column(Integer)
    end_message_id: Mapped[int] = mapped_column(Integer)
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    archived_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    metadata_json: Mapped[dict[str, Any] | None] = mapped_column("metadata", JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class Memory(Base):
    """One long-term memory row in the period model.

    There are no lineages or versions: each row is one fact with its own
    period. ``category`` is ``state`` (the fact holds over the period
    [``period_start``, ``period_end``]; a null bound is unbounded on that
    side) or ``event`` (the fact is a point in time, ``event_at``).
    A row whose time could not be determined from the user's statement
    is ``provisional``: it takes part in search and editing like any row
    but is never disclosed to the character as a fact — it only reaches
    the character as material for asking back, until its time is
    confirmed and the same row becomes an ordinary memory.
    """

    __tablename__ = "memories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    content: Mapped[str] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(10), index=True)
    importance: Mapped[int] = mapped_column(Integer, default=3)
    # Lifecycle state is the source of truth for why a memory is (in)active;
    # ``is_active`` is kept in sync with it (``status == "active"``) because
    # most queries filter on the boolean. Transitions must go through the
    # helpers in app.services.memory_lifecycle so the two never diverge.
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    # explicit: stated directly by the user; inferred: guessed by the model.
    provenance: Mapped[str] = mapped_column(String(20), default="inferred")
    # Abstract (concept) terms: what the fact is about. Stored apart from
    # the specific terms because the two play different roles at the
    # forgetting border: a forgotten row may only be crossed (recalled or
    # restored) on a cue that hits the fact's content or its specific
    # terms, never on a concept word alone. Both lists are part of the
    # FTS index, in their own columns, so a search can tell which side
    # of the fact a term hit.
    keywords: Mapped[list[str] | None] = mapped_column(KeywordListJSON, nullable=True)
    # Specific terms: the words proper to this fact alone — proper nouns,
    # place and person names, titles.
    specific_terms: Mapped[list[str] | None] = mapped_column(KeywordListJSON, nullable=True)
    # The period a state holds over. Null start = unbounded past, null
    # end = unbounded future. Unused for events.
    period_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # The point in time of an event. Unused for states.
    event_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    provisional: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    source_type: Mapped[str] = mapped_column(String(30), default="conversation")
    source_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Last time a search returned or read this memory: a weak
    # reinforcement, and the only thing ordinary use writes here.
    last_accessed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Last time a forgotten memory was recalled by the user pointing
    # back at it (reactivation). Ordinary search hits never write this;
    # the decay clock runs from the most recent reinforcement.
    last_recalled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    reactivation_count: Mapped[int] = mapped_column(Integer, default=0)
    # Restoration bookkeeping, kept apart from recall: a memory whose
    # fact was stated again (through the read flow or the write-time
    # similarity gate) is revived in place — a *restoration*, not a
    # recall — because the user did not point back at it. Only that
    # path writes these; organic recall never does.
    last_restored_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    restoration_count: Mapped[int] = mapped_column(Integer, default=0)
    # Content bookkeeping, kept apart from the lifecycle timestamps:
    # these move only when the fact itself changes (a save, a correction,
    # a keyword backfill), never on lifecycle events such as forgetting,
    # recall, restoration, or search hits.
    content_updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    content_update_source_type: Mapped[str | None] = mapped_column(String(30), nullable=True)
    content_update_provenance: Mapped[str | None] = mapped_column(String(20), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    # The stored stamp of the forgetting (decay) clock: every write to
    # the row — a lifecycle transition, a content change, a revival —
    # refreshes it, except ordinary search use, which stamps only
    # last_accessed_at. The effective reinforcement the decay runs from
    # is the newest of the three stamps (services.memory_lifecycle).
    last_reinforced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class MessageMemoryLink(Base):
    """A memory delivered to the character for one message's turn.

    Written when a turn's front stage completes: the memories that were
    handed over as hits, recalls, or newly learned facts for the user
    message that opened the turn. The resident set (the memories the
    character still has in context) is derived from these links over
    the not-yet-summarized messages. The "something is forgotten"
    notification is deliberately not a link: it is a per-turn signal,
    not a delivered memory.
    """

    __tablename__ = "message_memory_links"
    __table_args__ = (
        UniqueConstraint("message_id", "memory_id", name="uq_message_memory_links_pair"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    message_id: Mapped[int] = mapped_column(Integer, index=True)
    memory_id: Mapped[int] = mapped_column(Integer, index=True)
    # hit / recall / new: how the memory was delivered on that turn.
    delivery: Mapped[str] = mapped_column(String(10))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class CharacterState(Base):
    __tablename__ = "character_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    emotion: Mapped[str] = mapped_column(String(30), default="neutral")
    intensity: Mapped[float] = mapped_column(Float, default=0.0)
    secondary_emotion: Mapped[str | None] = mapped_column(String(30), nullable=True)
    secondary_intensity: Mapped[float] = mapped_column(Float, default=0.0)
    mood: Mapped[str] = mapped_column(String(100), default="neutral")
    affinity: Mapped[int] = mapped_column(Integer, default=50)
    last_emotion_update: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class ConversationMeta(Base):
    """Single-row bookkeeping for the post-processing job queue.

    ``epoch`` identifies the conversation generation a job was enqueued
    under, so jobs can tell message ids from an older generation apart
    from reused ones.
    """

    __tablename__ = "conversation_meta"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    epoch: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class PostJob(Base):
    __tablename__ = "post_jobs"
    __table_args__ = (
        UniqueConstraint(
            "kind",
            "conversation_epoch",
            "start_message_id",
            "end_message_id",
            name="uq_post_jobs_range",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(30), index=True)
    start_message_id: Mapped[int] = mapped_column(Integer)
    end_message_id: Mapped[int] = mapped_column(Integer)
    conversation_epoch: Mapped[int] = mapped_column(Integer, index=True)
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    result_json: Mapped[dict[str, Any] | None] = mapped_column("result", JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class LlmRawLog(Base):
    """Raw request/response record for one LLM call.

    Kept separately from the conversation history so failures (e.g. an
    unparsable analysis response) can be diagnosed from what the model
    actually returned, not from parsed results. Rows are purged by
    the retention pass once they expire.
    """

    __tablename__ = "llm_raw_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # memory_agent / emotion / chat / summary
    kind: Mapped[str] = mapped_column(String(30), index=True)
    request: Mapped[str] = mapped_column(Text)
    response: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The user message the call belongs to (foreground calls).
    message_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    # The post-processing job the call belongs to (background calls).
    job_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    start_message_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    end_message_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class AppSetting(Base):
    """One DB-stored settings override.

    Only layered (behavior-tuning) fields ever appear here (see
    ``app.services.settings_service``); base-layer configuration
    (connection info, data directory) stays in ``.env``. A row means
    "this field's effective value comes from the database"; no row
    means the ``.env`` / default value from the base ``Settings``
    applies. Values are stored as JSON scalars.
    """

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class StateHistory(Base):
    __tablename__ = "state_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    message_id: Mapped[int | None] = mapped_column(Integer, unique=True, nullable=True)
    emotion_before: Mapped[str] = mapped_column(String(30))
    emotion_after: Mapped[str] = mapped_column(String(30))
    affinity_before: Mapped[int] = mapped_column(Integer)
    affinity_after: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(Text, default="")
    # Full pre-application snapshot of the remaining state fields, kept
    # as the audit record of what the state was before this turn's
    # analysis was applied.
    intensity_before: Mapped[float] = mapped_column(Float, default=0.0)
    secondary_emotion_before: Mapped[str | None] = mapped_column(String(30), nullable=True)
    secondary_intensity_before: Mapped[float] = mapped_column(Float, default=0.0)
    mood_before: Mapped[str] = mapped_column(String(100), default="neutral")
    last_emotion_update_before: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class UserProfile(Base):
    """The user's basic facts, kept apart from long-term memory.

    Name, gender, and birthday live in this single row instead of
    the memories table: they are never forgotten, never pass the
    disclosure gate, and are handed to every stage of every turn.
    Only stage A edits them, through its profile tool, on the
    user's explicit statements. The birthday is split so a
    month/day pair can stand on its own when the year is unknown
    (``birthday_year`` stays null then).
    """

    __tablename__ = "user_profile"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    gender: Mapped[str | None] = mapped_column(String(100), nullable=True)
    birthday_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    birthday_month: Mapped[int | None] = mapped_column(Integer, nullable=True)
    birthday_day: Mapped[int | None] = mapped_column(Integer, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
