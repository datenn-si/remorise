import re
from dataclasses import dataclass

from sqlalchemy import Text, cast, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.models import Memory
from app.services.memory_lifecycle import STATUS_ACTIVE, STATUS_FORGOTTEN


def split_terms(query: str) -> list[str]:
    return re.findall(r"[\w]+", query, flags=re.UNICODE)


def _term_matches_stored(term: str, stored: str) -> bool:
    """Whether a query term matches one stored term.

    The same overlap rule everywhere (it mirrors the substring nature
    of the trigram index and of the literal path): exact equality, the
    term inside the stored word ("香川" against "香川県"), or a stored
    word of at least three characters inside the term.
    """
    return term == stored or term in stored or (len(stored) >= 3 and stored in term)


def classify_terms(memory: Memory, terms: list[str]) -> tuple[set[str], set[str]]:
    """Split query terms by which side of a memory they hit.

    Returns ``(strong, weak)``: a term is *strong* for a memory when
    it hits the fact itself — it appears in the content, or matches
    one of the specific terms — and *weak* when it only reaches the
    memory through its abstract (concept) terms or its category. This
    match provenance is what the forgetting border runs on: only a
    strong term may carry a forgotten row back across it, and the
    backfill files every learned term under the side it hit. The
    classification is decided here, from how the database actually
    matched — never from how the caller chose to split its query
    terms (spec §7.1/§7.2).
    """
    strong: set[str] = set()
    weak: set[str] = set()
    content = memory.content or ""
    specifics = [term for term in (memory.specific_terms or []) if term]
    concepts = [term for term in (memory.keywords or []) if term]
    for term in terms:
        if not term:
            continue
        if term in content or any(_term_matches_stored(term, stored) for stored in specifics):
            strong.add(term)
        elif term == memory.category or any(
            _term_matches_stored(term, stored) for stored in concepts
        ):
            weak.add(term)
    return strong, weak


@dataclass
class SearchHit:
    """One search result with its match provenance.

    ``strong_terms`` / ``weak_terms`` are the query terms that hit
    this row's content-or-specific side / concept-or-category side,
    as classified by :func:`classify_terms`. ``rank`` is the result's
    position in the backend's fixed ordering (bm25 scaled by
    importance), kept so the handover side can rank deliveries
    without re-searching.
    """

    memory: Memory
    strong_terms: frozenset[str] = frozenset()
    weak_terms: frozenset[str] = frozenset()
    rank: int = 0


class FTS5SearchProvider:
    """Trigram FTS5 search over memory content plus the stored terms.

    The index keeps content, abstract terms, specific terms, and
    category in separate columns; ``search_detailed`` reports, per
    result, which side of the fact the query terms hit (see
    :func:`classify_terms`).

    Ranking is bm25 scaled by importance: FTS hits form the body of
    the result, ordered by ``bm25 / importance`` so relevance stays
    primary and importance only weighs it. Literal substring (LIKE)
    matching is only an auxiliary path — it covers terms shorter than
    three characters, which the trigram tokenizer cannot index, and
    acts as a fallback when the FTS body is thinner than the requested
    limit.
    """

    async def search(
        self,
        session: AsyncSession,
        query: str,
        limit: int = 5,
        *,
        status: str = STATUS_ACTIVE,
    ) -> list[Memory]:
        hits = await self.search_detailed(session, query, limit, status=status)
        return [hit.memory for hit in hits]

    async def search_detailed(
        self,
        session: AsyncSession,
        query: str,
        limit: int = 5,
        *,
        status: str = STATUS_ACTIVE,
    ) -> list[SearchHit]:
        terms = split_terms(query)
        if not terms:
            return []
        # The caller owns the cap. Stage A passes its own limit; the
        # browsing API passes the request's limit. Do not clamp here.
        fts_terms = [term for term in terms if len(term) >= 3]
        short_terms = [term for term in terms if len(term) < 3]

        ids: list[int] = []
        if fts_terms:
            ids.extend(await self._fts_ids(session, fts_terms, limit, status))
        if short_terms:
            literal = await self._literal_matches(session, short_terms, limit, status)
            short_ids = [memory.id for memory in literal if memory.id not in ids]
            # Short terms (often proper nouns like 日本) only have the literal
            # path; reserve room for them at the tail instead of letting a
            # saturated FTS body crowd them out entirely.
            ids = ids[: max(0, limit - len(short_ids))]
            ids.extend(short_ids)
        ids = list(dict.fromkeys(ids))
        if len(ids) < limit:
            # FTS body is thin: fall back to literal matching over all terms
            # so wording the trigram index cannot phrase-match still surfaces.
            literal = await self._literal_matches(session, terms, limit, status)
            ids.extend(memory.id for memory in literal)
            ids = list(dict.fromkeys(ids))
        ids = ids[:limit]
        if not ids:
            return []
        found = await session.scalars(select(Memory).where(Memory.id.in_(ids)))
        memories = {memory.id: memory for memory in found}
        hits: list[SearchHit] = []
        for rank, memory_id in enumerate(ids):
            memory = memories.get(memory_id)
            if memory is None:
                continue
            strong, weak = classify_terms(memory, terms)
            hits.append(
                SearchHit(
                    memory=memory,
                    strong_terms=frozenset(strong),
                    weak_terms=frozenset(weak),
                    rank=rank,
                )
            )
        return hits

    async def _fts_ids(
        self,
        session: AsyncSession,
        terms: list[str],
        limit: int,
        status: str,
    ) -> list[int]:
        clause, params = _status_params(status)
        fts_query = " OR ".join(
            f'{{content keywords specific_terms category}} : "{term.replace(chr(34), chr(34) * 2)}"'
            for term in terms
        )
        result = await session.execute(
            text(
                f"""
                SELECT m.id
                FROM memories_fts
                JOIN memories AS m ON m.id = memories_fts.rowid
                WHERE memories_fts MATCH :query{clause}
                ORDER BY bm25(memories_fts) / MAX(m.importance, 1), m.last_reinforced_at DESC
                LIMIT :limit
                """
            ),
            {"query": fts_query, "limit": limit, **params},
        )
        return [row.id for row in result]

    async def _literal_matches(
        self,
        session: AsyncSession,
        terms: list[str],
        limit: int,
        status: str,
    ) -> list[Memory]:
        escaped_terms = [
            term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") for term in terms
        ]
        conditions = [
            condition
            for term in escaped_terms
            for condition in (
                Memory.content.ilike(f"%{term}%", escape="\\"),
                cast(Memory.keywords, Text).ilike(f"%{term}%", escape="\\"),
                cast(Memory.specific_terms, Text).ilike(f"%{term}%", escape="\\"),
            )
        ]
        statement = select(Memory).where(or_(*conditions))
        if status == STATUS_ACTIVE:
            statement = statement.where(Memory.status == STATUS_ACTIVE)
        elif status == STATUS_FORGOTTEN:
            statement = statement.where(Memory.status == STATUS_FORGOTTEN)
        statement = statement.order_by(
            Memory.importance.desc(), Memory.last_reinforced_at.desc()
        ).limit(limit)
        return list((await session.scalars(statement)).all())


def _status_params(status: str) -> tuple[str, dict[str, str]]:
    """``all`` leaves the status open. The other two values are bound,
    never interpolated, and match the list endpoint's filter.
    """
    if status in (STATUS_ACTIVE, STATUS_FORGOTTEN):
        return " AND m.status = :status", {"status": status}
    return "", {}
