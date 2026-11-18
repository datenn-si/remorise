"""Backend memory operations for the period model.

This module is the fixed-rule side of the front stage: the memory
agent (stage A) may only reach memory through these functions, and
the rules that decide what a hit is, when a forgotten row may be
crossed, and how periods are adjusted live here — never in the
model's discretion (spec §8.7). Search itself is never narrowed by
the delivery limits; caps apply only when results are handed over to
the emotion analysis and the reply generation.
"""

import difflib
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.database.models import Memory, Message, MessageMemoryLink, Summary, utc_now
from app.services import memory_lifecycle
from app.services.memory_lifecycle import as_utc
from app.services.memory_search import FTS5SearchProvider, classify_terms

logger = logging.getLogger(__name__)
search_provider = FTS5SearchProvider()

_MIN = datetime.min.replace(tzinfo=UTC)
_MAX = datetime.max.replace(tzinfo=UTC)

_MAX_STORED_TERMS = 16

# How many rows one agent search surfaces to the agent itself. The
# search is a fixed backend rule; this only bounds the agent's own
# view, not what counts as a hit (deliveries are capped separately).
_AGENT_SEARCH_LIMIT = 20


def as_local(value: datetime) -> datetime:
    """Everything handed to a model is rendered in local time;
    storage and comparison stay in UTC.
    """
    return as_utc(value).astimezone()


def utc_offset_text(value: datetime) -> str:
    offset = value.utcoffset()
    if offset is None:
        return "UTC"
    seconds = int(offset.total_seconds())
    sign = "+" if seconds >= 0 else "-"
    seconds = abs(seconds)
    return f"UTC{sign}{seconds // 3600:02d}:{seconds % 3600 // 60:02d}"


def parse_datetime(value: object) -> datetime | None:
    """Parse an ISO date or datetime from a tool argument.

    The agent is shown the current time in the machine's local
    timezone, so a value without an offset is read as local time:
    a plain date is the start of that day locally, and a naive
    datetime is a local wall-clock time. A value that carries an
    offset keeps its own. Either way the result is the same
    instant expressed as an aware datetime in UTC. Anything
    unparseable resolves to None.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    # astimezone() presumes the local timezone for a naive value
    # and converts from its own offset for an aware one.
    return parsed.astimezone(UTC)


def periods_overlap(
    a_start: datetime | None,
    a_end: datetime | None,
    b_start: datetime | None,
    b_end: datetime | None,
) -> bool:
    """Overlap of two periods; a null bound is unbounded on that side."""
    a_s = as_utc(a_start) if a_start else _MIN
    a_e = as_utc(a_end) if a_end else _MAX
    b_s = as_utc(b_start) if b_start else _MIN
    b_e = as_utc(b_end) if b_end else _MAX
    return a_s <= b_e and b_s <= a_e


def memory_in_period(
    memory: Memory,
    period_start: datetime | None,
    period_end: datetime | None,
) -> bool:
    """Whether a memory matches a search period (spec §7.1).

    States match on overlap; events match when their point lies
    inside the search period.
    """
    if period_start is None and period_end is None:
        return True
    if memory.category == "event":
        if memory.event_at is None:
            return False
        point = as_utc(memory.event_at)
        if period_start is not None and point < as_utc(period_start):
            return False
        if period_end is not None and point > as_utc(period_end):
            return False
        return True
    return periods_overlap(memory.period_start, memory.period_end, period_start, period_end)


def period_sort_key(memory: Memory) -> tuple[datetime, int]:
    start = memory.period_start or memory.event_at or memory.created_at
    return (as_utc(start), memory.id or 0)


def period_text(memory: Memory) -> str:
    """The period of a memory as handed to the character and the analyst.

    Rendered in the machine's local timezone, like the current time
    the models are shown: an event's time always carries its UTC
    offset, and a state's bounds are local calendar dates, so a bound
    stored as a local midnight never shows as the previous day.
    """
    if memory.category == "event":
        if memory.event_at is None:
            return "日時不明"
        local = as_local(memory.event_at)
        return f"{local.strftime('%Y-%m-%d %H:%M')}（{utc_offset_text(local)}）"
    start = (
        as_local(memory.period_start).strftime("%Y-%m-%d") if memory.period_start else "ずっと前"
    )
    end = as_local(memory.period_end).strftime("%Y-%m-%d") if memory.period_end else "現在も継続"
    return f"{start}〜{end}"


def content_similarity(left: str, right: str) -> float:
    def normalize(value: str) -> str:
        return re.sub(r"\s+", "", value.casefold())

    a, b = normalize(left), normalize(right)
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()


# Memories about the act of searching or operating the memory system
# itself are meta-records, not facts about the user. The agent prompt
# forbids them, and this filter drops any that slip through anyway.
_META_MEMORY_PATTERNS = (
    r"検索(した|を行|を使用|で調)",
    r"キーワード",
    r"(記憶|メモリ)を(検索|保存|更新|削除)(した|する)",
)


def is_meta_memory(content: str) -> bool:
    return any(re.search(pattern, content) for pattern in _META_MEMORY_PATTERNS)


def clean_terms(terms: Sequence[str]) -> list[str]:
    cleaned: list[str] = []
    for term in terms:
        term = term.strip()
        if term and term not in cleaned:
            cleaned.append(term)
    return cleaned


def merge_term_lists(existing: Sequence[str] | None, incoming: Sequence[str]) -> list[str]:
    merged = list(existing or [])
    for term in incoming:
        if term and term not in merged:
            merged.append(term)
    return merged[:_MAX_STORED_TERMS]


def file_terms(
    memory: Memory, specific_terms: Sequence[str], abstract_terms: Sequence[str]
) -> bool:
    specifics = merge_term_lists(memory.specific_terms, clean_terms(specific_terms))
    concepts = merge_term_lists(memory.keywords, clean_terms(abstract_terms))
    changed = specifics != list(memory.specific_terms or []) or concepts != list(
        memory.keywords or []
    )
    if changed:
        memory.specific_terms = specifics
        memory.keywords = concepts
    return changed


def learn_terms(memory: Memory, terms: Sequence[str], *, missed: bool = False) -> bool:
    """Learn search terms into a memory's stored term lists.

    The backfill, classified by how the database actually matched
    (:func:`classify_terms`): a term that hit the content or the
    specific terms is itself a specific term; a term that only reached
    the memory through its abstract terms is an abstract term. A term
    already known as an abstract term that proves itself against the
    content side is *promoted* to the specific list — the border
    privilege (crossing to a forgotten row) is earned by exactly this
    kind of demonstrated hit, never granted to a term that merely rode
    along in a successful query. There is no demotion.

    With ``missed=True`` (the vocabulary-gap path: a search missed
    this memory on these terms and the fact was reached another way),
    terms that match neither side are filed as abstract terms anyway:
    they are the user's own words for the topic, and filing them is
    what makes the next similar query match. They never enter the
    specific list without a demonstrated content-side hit.
    """
    strong, weak = classify_terms(memory, list(terms))
    specifics = list(memory.specific_terms or [])
    concepts = list(memory.keywords or [])
    changed = False
    for term in terms:
        if not term:
            continue
        if term in strong:
            if term not in specifics:
                specifics.append(term)
                changed = True
            if term in concepts:
                concepts.remove(term)
                changed = True
        elif term in weak or missed:
            if term not in concepts and term not in specifics:
                concepts.append(term)
                changed = True
    if changed:
        memory.specific_terms = specifics[:_MAX_STORED_TERMS]
        memory.keywords = concepts[:_MAX_STORED_TERMS]
    return changed


@dataclass
class SearchRecord:
    terms: list[str]
    pointing: bool
    # hit / no_hit / forgotten_undisclosed: the last separates "nothing
    # was found" from "something exists but stays undisclosed" — the
    # distinction the duplicate-prevention judgement relies on.
    result: str


@dataclass
class TurnContext:
    """Everything one turn's memory processing settles, in memory.

    Nothing here is disclosed to the character directly: the emotion
    analysis and the reply generation receive only what the disclosure
    gate (:func:`select_disclosure`) lets through. Outcomes are keyed
    by memory id: hit / recall / restored / created / forgotten /
    reference. Only hit, recall, and created may pass the gate.
    """

    settings: Settings
    source_date: datetime
    searches: list[SearchRecord] = field(default_factory=list)
    outcomes: dict[int, str] = field(default_factory=dict)
    rows: dict[int, Memory] = field(default_factory=dict)
    ranks: dict[int, int] = field(default_factory=dict)
    notification_terms: set[str] = field(default_factory=set)
    missed_terms: list[str] = field(default_factory=list)
    created_ids: list[int] = field(default_factory=list)
    restored_ids: list[int] = field(default_factory=list)
    recalled_ids: list[int] = field(default_factory=list)
    corrected_ids: list[int] = field(default_factory=list)
    confirmed_ids: list[int] = field(default_factory=list)

    def note_row(self, memory: Memory, outcome: str, rank: int | None = None) -> None:
        self.rows[memory.id] = memory
        if rank is not None:
            self.ranks[memory.id] = rank
        previous = self.outcomes.get(memory.id)
        # Stronger outcomes win: a created or recalled row stays what
        # it is even if a later search in the same session hits it.
        if previous in ("created", "recall"):
            return
        if previous == "restored" and outcome == "hit":
            return
        self.outcomes[memory.id] = outcome


def agent_row_payload(
    memory: Memory, *, hit_type: str | None = None, action: str | None = None
) -> dict:
    payload: dict = {
        "id": memory.id,
        "content": memory.content,
        "category": memory.category,
        "period": period_text(memory),
        "importance": memory.importance,
        "provenance": memory.provenance,
        "status": memory.status,
        "provisional": memory.provisional,
    }
    if memory.category == "event":
        payload["event_at"] = as_local(memory.event_at).isoformat() if memory.event_at else None
    else:
        payload["period_start"] = (
            as_local(memory.period_start).isoformat() if memory.period_start else None
        )
        payload["period_end"] = (
            as_local(memory.period_end).isoformat() if memory.period_end else None
        )
    if hit_type is not None:
        payload["hit_type"] = hit_type
    if action is not None:
        payload["action"] = action
    return payload


async def agent_search(
    session: AsyncSession,
    ctx: TurnContext,
    *,
    terms: Sequence[str],
    period_start: datetime | None = None,
    period_end: datetime | None = None,
    pointing: bool = False,
) -> dict:
    """One fixed-rule search for the memory agent.

    The hit conditions are the backend's alone: every row the terms
    reach is reported with its status, forgotten rows included (their
    content too — the agent needs it for its editing judgements). The
    read flow's side effects happen here, per row:

    - an active row is returned (an access; its clock moves);
    - a forgotten row hit concretely (content / specific terms) is
      *recalled* when the user is pointing back at it, and *restored*
      when the fact is simply being stated again;
    - a forgotten row hit only abstractly never crosses: with pointing
      it becomes the "something is forgotten" notification terms,
      without pointing the search reports ``forgotten_undisclosed``,
      a status kept separate from a true no-hit.
    """
    terms = clean_terms([str(term) for term in terms])
    if not terms:
        return {"status": "no_hit", "hits": []}
    hits = await search_provider.search_detailed(
        session, " ".join(terms), _AGENT_SEARCH_LIMIT, include_inactive=True
    )
    results: list[dict] = []
    reached: list[Memory] = []
    undisclosed = False
    for hit in hits:
        row = hit.memory
        if not memory_in_period(row, period_start, period_end):
            continue
        strong = bool(hit.strong_terms)
        weak = bool(hit.weak_terms)
        hit_type = "both" if strong and weak else "concrete" if strong else "abstract"
        if row.status == memory_lifecycle.STATUS_FORGOTTEN:
            if strong:
                if pointing:
                    memory_lifecycle.reactivate_memory(row)
                    ctx.note_row(row, "recall", hit.rank)
                    ctx.recalled_ids.append(row.id)
                    action = "recalled"
                else:
                    memory_lifecycle.restore_memory(row)
                    ctx.note_row(row, "restored", hit.rank)
                    ctx.restored_ids.append(row.id)
                    action = "restored"
                if learn_terms(row, terms):
                    memory_lifecycle.record_content_update(row, "conversation", "explicit")
                reached.append(row)
            else:
                action = "forgotten_abstract"
                ctx.note_row(row, "forgotten", hit.rank)
                if pointing:
                    ctx.notification_terms.update(hit.weak_terms)
                else:
                    undisclosed = True
            results.append(agent_row_payload(row, hit_type=hit_type, action=action))
            continue
        memory_lifecycle.record_memory_use([row])
        ctx.note_row(row, "hit", hit.rank)
        reached.append(row)
        results.append(agent_row_payload(row, hit_type=hit_type, action="accessed"))
    if reached:
        # Vocabulary-gap learning: terms of earlier searches in this
        # session (or of the previous turn) that missed entirely are
        # filed into the first memory this search reached, as abstract
        # terms — the user's own words for the topic.
        if ctx.missed_terms:
            target = reached[0]
            if learn_terms(target, ctx.missed_terms, missed=True):
                memory_lifecycle.record_content_update(target, "conversation", "explicit")
            ctx.missed_terms = []
        status = "hit"
    else:
        for term in terms:
            if term not in ctx.missed_terms:
                ctx.missed_terms.append(term)
        status = "forgotten_undisclosed" if undisclosed else "no_hit"
    ctx.searches.append(SearchRecord(terms=list(terms), pointing=pointing, result=status))
    await session.flush()
    return {"status": status, "hits": results}


async def _topic_rows(session: AsyncSession, anchor: Memory) -> list[Memory]:
    """Rows on the anchor's topic: sharing a specific term with it.

    When the anchor carries no specific terms, shared abstract terms
    define the topic instead. This grouping is what the pseudo-lineage
    (±n) traversal walks, in period order.
    """
    rows = list((await session.scalars(select(Memory))).all())
    specifics = {term for term in (anchor.specific_terms or []) if term}
    concepts = {term for term in (anchor.keywords or []) if term}
    topic: list[Memory] = []
    for row in rows:
        if row.id == anchor.id:
            continue
        row_specifics = {term for term in (row.specific_terms or []) if term}
        row_concepts = {term for term in (row.keywords or []) if term}
        if specifics:
            if row_specifics & specifics:
                topic.append(row)
        elif (row_specifics | row_concepts) & concepts:
            topic.append(row)
    return topic


async def agent_search_neighbors(
    session: AsyncSession,
    ctx: TurnContext,
    *,
    anchor_id: int | None = None,
    offset: int = 0,
    period_start: datetime | None = None,
    period_end: datetime | None = None,
) -> dict:
    """Reference-only retrieval: ±n along a topic, or a period sweep.

    What this returns is for the agent's orientation only — it never
    becomes material for a new registration (registrations are built
    from the user's utterance alone), and the disclosure gate ignores
    rows that only ever surfaced here.
    """
    rows: list[Memory] = []
    if anchor_id is not None and offset != 0:
        anchor = await session.get(Memory, anchor_id)
        if anchor is None:
            return {"status": "no_hit", "reference_only": True, "rows": []}
        ordered = sorted([anchor, *await _topic_rows(session, anchor)], key=period_sort_key)
        index = next(i for i, row in enumerate(ordered) if row.id == anchor.id)
        target = index + offset
        if 0 <= target < len(ordered):
            rows = [ordered[target]]
    elif period_start is not None or period_end is not None:
        all_rows = list((await session.scalars(select(Memory))).all())
        rows = [
            row
            for row in sorted(all_rows, key=period_sort_key)
            if memory_in_period(row, period_start, period_end)
        ][:10]
    for row in rows:
        ctx.note_row(row, "reference")
    return {
        "status": "hit" if rows else "no_hit",
        "reference_only": True,
        "rows": [agent_row_payload(row) for row in rows],
    }


def _widen_period(
    memory: Memory,
    period_start: datetime | None,
    period_end: datetime | None,
) -> None:
    """Grow a state's period to the union with a restated wider one.

    Only a concrete incoming bound moves a stored one: a restatement
    that leaves a bound unsaid (which the caller cannot tell apart
    from an open bound) never erases the bound the row already has.
    """
    if memory.period_start is not None and period_start is not None:
        memory.period_start = min(as_utc(memory.period_start), as_utc(period_start))
    if memory.period_end is not None and period_end is not None:
        memory.period_end = max(as_utc(memory.period_end), as_utc(period_end))


def apply_period_surgery(session: AsyncSession, new_row: Memory, target: Memory) -> str | None:
    """Adjust an existing state's period around a preferred new row.

    Deterministic backend arithmetic (the agent only declares which
    rows overlap): the new row wins the overlap — an existing period
    is trimmed at the shared edge, closed when the new period covers
    it entirely, and split in two when the new period lands inside
    it. Split-off rows inherit the original's attributes and live on
    as independent memories. Events are points and are never cut.
    """
    if target.category != "state" or new_row.category != "state":
        return None
    ns, ne = new_row.period_start, new_row.period_end
    ts, te = target.period_start, target.period_end
    if not periods_overlap(ns, ne, ts, te):
        return None
    n_s = as_utc(ns) if ns else _MIN
    n_e = as_utc(ne) if ne else _MAX
    t_s = as_utc(ts) if ts else _MIN
    t_e = as_utc(te) if te else _MAX
    now = utc_now()
    if n_s <= t_s and n_e >= t_e:
        anchor = as_utc(ts) if ts else as_utc(target.created_at)
        target.period_start = anchor
        target.period_end = anchor
        target.last_reinforced_at = now
        return "closed"
    if n_s > t_s and n_e < t_e:
        right = Memory(
            content=target.content,
            category=target.category,
            importance=target.importance,
            status=target.status,
            is_active=target.is_active,
            provenance=target.provenance,
            keywords=list(target.keywords or []),
            specific_terms=list(target.specific_terms or []),
            period_start=ne,
            period_end=te,
            provisional=target.provisional,
            source_type=target.source_type,
            source_date=target.source_date,
            content_updated_at=target.content_updated_at,
            content_update_source_type=target.content_update_source_type,
            content_update_provenance=target.content_update_provenance,
            created_at=now,
            last_reinforced_at=now,
        )
        session.add(right)
        target.period_end = ns
        target.last_reinforced_at = now
        return "split"
    if t_s < n_s < t_e and n_e >= t_e:
        target.period_end = ns
        target.last_reinforced_at = now
        return "trimmed"
    if t_s < n_e < t_e and n_s <= t_s:
        target.period_start = ne
        target.last_reinforced_at = now
        return "trimmed"
    return None


async def agent_save(
    session: AsyncSession,
    ctx: TurnContext,
    *,
    content: str,
    category: str,
    importance: int,
    provenance: str,
    specific_terms: Sequence[str],
    abstract_terms: Sequence[str],
    period_start: datetime | None = None,
    period_end: datetime | None = None,
    event_at: datetime | None = None,
    provisional: bool = False,
    overlap_ids: Sequence[int] = (),
) -> dict:
    """Save one memory from the user's utterance, through the gates.

    The write-time similarity gate runs first: content at least
    ``memory_similarity_threshold`` similar to an existing row is a
    match of that row, never a second insert — an active row is
    accessed (and its period widened when the restatement is wider),
    a forgotten row is restored. Otherwise the row is inserted and
    the declared overlapping rows go through period surgery.
    """
    settings = ctx.settings
    content = content.strip()
    if not content or is_meta_memory(content):
        return {"error": "meta_memory_rejected"}
    if category not in ("state", "event"):
        return {"error": "invalid_category"}
    if provenance not in ("explicit", "inferred"):
        provenance = "inferred"
    rows = list((await session.scalars(select(Memory))).all())
    best: Memory | None = None
    best_score = 0.0
    for row in rows:
        score = content_similarity(row.content, content)
        if score > best_score:
            best, best_score = row, score
    if best is not None and best_score >= settings.memory_similarity_threshold:
        if best.status == memory_lifecycle.STATUS_FORGOTTEN:
            memory_lifecycle.restore_memory(best)
            ctx.note_row(best, "restored")
            ctx.restored_ids.append(best.id)
            action = "restored"
        else:
            memory_lifecycle.record_memory_use([best])
            ctx.note_row(best, ctx.outcomes.get(best.id, "hit"))
            action = "matched"
        if file_terms(best, specific_terms, abstract_terms):
            memory_lifecycle.record_content_update(best, "conversation", provenance)
        if category == "state" and best.category == "state":
            _widen_period(best, period_start, period_end)
        await session.flush()
        return {"id": best.id, "action": action, "matched_existing": True}
    now = utc_now()
    row = Memory(
        content=content,
        category=category,
        importance=max(1, min(5, importance)),
        provenance=provenance,
        keywords=clean_terms(abstract_terms)[:_MAX_STORED_TERMS],
        specific_terms=clean_terms(specific_terms)[:_MAX_STORED_TERMS],
        period_start=period_start if category == "state" else None,
        period_end=period_end if category == "state" else None,
        event_at=event_at if category == "event" else None,
        provisional=provisional,
        source_type="conversation",
        source_date=ctx.source_date,
        content_updated_at=now,
        content_update_source_type="conversation",
        content_update_provenance=provenance,
        created_at=now,
        last_reinforced_at=now,
    )
    session.add(row)
    await session.flush()
    ctx.note_row(row, "created")
    ctx.created_ids.append(row.id)
    surgery: list[dict] = []
    if category == "state":
        for target_id in overlap_ids:
            if target_id == row.id:
                continue
            target = await session.get(Memory, target_id)
            if target is None:
                continue
            action = apply_period_surgery(session, row, target)
            if action is not None:
                surgery.append({"id": target_id, "action": action})
    await session.flush()
    return {"id": row.id, "action": "created", "surgery": surgery}


async def agent_correct(
    session: AsyncSession,
    ctx: TurnContext,
    *,
    memory_id: int,
    updates: dict,
) -> dict:
    """Correction overwrite: rewrite a row that turned out to be wrong.

    The one exception to "the past is never edited directly": a value
    that was simply mistaken is replaced in its own row (for events
    and states alike) instead of being period-adjusted, so the wrong
    value does not linger as a formerly-true one. ``updates`` carries
    only the fields the agent actually sent.
    """
    row = await session.get(Memory, memory_id)
    if row is None:
        return {"error": "memory_not_found"}
    if "content" in updates:
        text = str(updates["content"]).strip()
        if not text or is_meta_memory(text):
            return {"error": "meta_memory_rejected"}
        row.content = text
    if "category" in updates and updates["category"] in ("event", "state"):
        row.category = updates["category"]
    if "importance" in updates:
        row.importance = max(1, min(5, int(updates["importance"])))
    if "provenance" in updates and updates["provenance"] in ("explicit", "inferred"):
        row.provenance = updates["provenance"]
    if "specific_terms" in updates:
        row.specific_terms = clean_terms(updates["specific_terms"])[:_MAX_STORED_TERMS]
    if "abstract_terms" in updates:
        row.keywords = clean_terms(updates["abstract_terms"])[:_MAX_STORED_TERMS]
    for key in ("period_start", "period_end", "event_at"):
        if key not in updates:
            continue
        raw = updates[key]
        if raw is None:
            # An explicit null is a deliberate clear of the bound.
            setattr(row, key, None)
            continue
        parsed = parse_datetime(raw)
        # An unparseable value is not an update: it must not land as
        # None and silently open the bound it meant to move.
        if parsed is not None:
            setattr(row, key, parsed)
    memory_lifecycle.record_content_update(row, "conversation", row.provenance)
    row.last_reinforced_at = utc_now()
    ctx.note_row(row, ctx.outcomes.get(row.id, "reference"))
    ctx.corrected_ids.append(row.id)
    await session.flush()
    return {"id": row.id, "action": "corrected"}


async def agent_confirm_period(
    session: AsyncSession,
    ctx: TurnContext,
    *,
    memory_id: int,
    period_start: datetime | None = None,
    period_end: datetime | None = None,
    event_at: datetime | None = None,
) -> dict:
    """Settle a provisional row's real time, in the same row.

    Confirming a provisional placement is an update of that row, not
    a correction overwrite and not a copy: once its time is known the
    row simply becomes an ordinary memory.
    """
    row = await session.get(Memory, memory_id)
    if row is None:
        return {"error": "memory_not_found"}
    if not row.provisional:
        return {"error": "not_provisional"}
    if row.category == "event":
        if event_at is None:
            return {"error": "no_time_given"}
        row.event_at = event_at
    else:
        if period_start is None and period_end is None:
            return {"error": "no_time_given"}
        # Only the bounds actually given move: an omitted bound
        # keeps its stored value instead of being erased to open.
        if period_start is not None:
            row.period_start = period_start
        if period_end is not None:
            row.period_end = period_end
    row.provisional = False
    row.last_reinforced_at = utc_now()
    if ctx.outcomes.get(row.id) in (None, "reference", "forgotten"):
        ctx.note_row(row, "hit")
    ctx.confirmed_ids.append(row.id)
    await session.flush()
    return {"id": row.id, "action": "confirmed"}


@dataclass
class DeliveredMemory:
    memory: Memory
    delivery: str  # hit / recall / new


def select_disclosure(
    ctx: TurnContext,
    requested_ids: Sequence[int],
    ask_back_ids: Sequence[int],
) -> tuple[list[DeliveredMemory], list[Memory], dict | None]:
    """The disclosure gate (A.5): filter the agent's ID selection.

    The agent selects by ID only; what passes is decided here. Hits,
    recalls, and this turn's new memories pass. Restored rows are
    dropped (the fact is already in the conversation as the user's
    own restatement; it reaches the character as a memory from the
    next turn on), as are forgotten rows, reference-only rows, and
    provisional rows — provisional rows may only be named as
    ask-back material, never disclosed as facts.
    """
    delivered: list[DeliveredMemory] = []
    seen: set[int] = set()
    for memory_id in requested_ids:
        if memory_id in seen:
            continue
        seen.add(memory_id)
        outcome = ctx.outcomes.get(memory_id)
        row = ctx.rows.get(memory_id)
        if row is None or row.provisional:
            continue
        if outcome == "hit":
            delivered.append(DeliveredMemory(row, "hit"))
        elif outcome == "recall":
            delivered.append(DeliveredMemory(row, "recall"))
        elif outcome == "created":
            delivered.append(DeliveredMemory(row, "new"))
    ask_back: list[Memory] = []
    for memory_id in ask_back_ids:
        row = ctx.rows.get(memory_id)
        if row is not None and row.provisional and row not in ask_back:
            ask_back.append(row)
    notification = None
    if ctx.notification_terms:
        notification = {"terms": sorted(ctx.notification_terms)}
    delivered.sort(key=lambda item: ctx.ranks.get(item.memory.id, 1_000))
    return delivered, ask_back, notification


async def resident_memories(
    session: AsyncSession,
    settings: Settings,
    *,
    before_message_id: int,
) -> list[DeliveredMemory]:
    """The resident set: memories linked to not-yet-summarized messages.

    A memory stays resident while a message it was delivered for is
    still in the unsummarized window; when the window moves past the
    message (or the message is invalidated), the memory leaves the
    set. Most recently linked first, capped by the configured item
    limit. A memory delivered as new on its turn reads as a plain hit
    here — "new" is a one-turn label.
    """
    summary = await session.scalar(
        select(Summary)
        .where(Summary.active.is_(True), Summary.archived_at.is_(None))
        .order_by(Summary.id.desc())
    )
    window_start = summary.end_message_id if summary else 0
    rows = (
        await session.execute(
            select(MessageMemoryLink, Memory)
            .join(Memory, Memory.id == MessageMemoryLink.memory_id)
            .join(Message, Message.id == MessageMemoryLink.message_id)
            .where(
                MessageMemoryLink.message_id > window_start,
                MessageMemoryLink.message_id < before_message_id,
                Message.archived_at.is_(None),
                Memory.is_active.is_(True),
            )
            .order_by(MessageMemoryLink.message_id.desc(), MessageMemoryLink.id.desc())
        )
    ).all()
    resident: list[DeliveredMemory] = []
    seen: set[int] = set()
    for link, memory in rows:
        if memory.id in seen:
            continue
        seen.add(memory.id)
        resident.append(DeliveredMemory(memory, "recall" if link.delivery == "recall" else "hit"))
        if len(resident) >= settings.memory_resident_max_items:
            break
    return resident


async def record_links(
    session: AsyncSession,
    message_id: int,
    delivered: Sequence[DeliveredMemory],
) -> None:
    """Link a turn's delivered memories to its user message.

    This is what makes a memory part of the resident set for the
    following turns (spec §8.7: linked = delivered as a hit or a
    recall on that turn; new deliveries join on the same rule and
    read as hits from the next turn on).
    """
    for item in delivered:
        exists = await session.scalar(
            select(MessageMemoryLink.id).where(
                MessageMemoryLink.message_id == message_id,
                MessageMemoryLink.memory_id == item.memory.id,
            )
        )
        if exists is None:
            session.add(
                MessageMemoryLink(
                    message_id=message_id,
                    memory_id=item.memory.id,
                    delivery=item.delivery,
                )
            )
    await session.flush()


async def search_memories_simple(session: AsyncSession, query: str, limit: int = 5) -> list[Memory]:
    return await search_provider.search(session, query, limit)
