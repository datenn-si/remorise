import asyncio
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from openai import APIConnectionError, APIStatusError, APITimeoutError, AsyncOpenAI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.database.models import Memory, Message, Summary, UserProfile
from app.database.session import get_db
from app.llm.chat_response import StreamedResponseParser
from app.schemas.chat import (
    ChatRequest,
    HistoryResponse,
    InferenceStatusResponse,
    MessageResponse,
)
from app.schemas.events import SSE_EVENT_SCHEMAS, APIError
from app.schemas.state import CharacterStateResponse, StateAnalysis
from app.services import profile_store, raw_log_service
from app.services.context_manager import (
    build_system_prompt,
    elapsed_since_text,
    format_current_time,
    history_as_messages,
    memory_line,
)
from app.services.emotion_service import (
    analyze_emotion,
    apply_state_analysis,
    get_state_with_decay,
    recent_state_history,
    state_application_exists,
    state_history_lines,
)
from app.services.inference_status import PHASE_SPEAKING, PHASE_THINKING, InferenceActivity
from app.services.memory_agent import AgentResult, run_memory_agent
from app.services.memory_store import (
    DeliveredMemory,
    as_utc,
    record_links,
    resident_memories,
)

router = APIRouter(prefix="/api/chat", tags=["chat"])
logger = logging.getLogger(__name__)

# User-message metadata key holding the turn's front-stage record: what
# stage A settled (its debug payload and the delivered selection) and
# whether stage B's analysis was applied. A resend of a failed turn
# uses it to resume at the first unsettled stage instead of repeating
# settled work (spec §13.2). The record is also stage A's commit
# marker: it is stored in the same commit as stage A's writes.
FRONT_STAGE_METADATA_KEY = "front_stage"


@dataclass
class _TurnPrep:
    llm_messages: list[dict[str, Any]]
    front_state_analysis: dict[str, Any] | None
    applied_state_payload: dict[str, Any] | None
    memory_search_debug: dict[str, Any] | None


def sse_event(name: str, data: dict[str, Any]) -> str:
    return f"event: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def start_completion(
    client: AsyncOpenAI,
    settings: Settings,
    messages: list[dict[str, Any]],
) -> Any:
    """The character has no tools in stage C."""
    options: dict[str, Any] = {}
    # Sampling settings are only sent when configured; leaving them unset
    # keeps the llama.cpp server defaults.
    if settings.llm_temperature is not None:
        options["temperature"] = settings.llm_temperature
    if settings.llm_frequency_penalty is not None:
        options["frequency_penalty"] = settings.llm_frequency_penalty
    if settings.llm_presence_penalty is not None:
        options["presence_penalty"] = settings.llm_presence_penalty
    extra_body: dict[str, Any] = {"chat_template_kwargs": {"enable_thinking": False}}
    if settings.llm_repeat_penalty is not None:
        # llama.cpp-specific: not part of the OpenAI API surface, so it
        # travels in extra_body like the chat template kwargs.
        extra_body["repeat_penalty"] = settings.llm_repeat_penalty
    return await client.chat.completions.create(
        model=settings.llm_model,
        messages=messages,
        max_tokens=settings.llm_max_tokens,
        stream=True,
        stream_options={"include_usage": True},
        extra_body=extra_body,
        **options,
    )


def _stored_front_record(user_message: Message) -> dict[str, Any] | None:
    metadata = user_message.metadata_json or {}
    raw = metadata.get(FRONT_STAGE_METADATA_KEY)
    if not isinstance(raw, dict) or raw.get("version") != 2:
        return None
    return raw


def _previous_missed_terms(rows: list[Message]) -> list[str]:
    """Search terms of the previous turn whose retrieval missed entirely.

    When that turn's recorded debug shows searches but no disclosure
    and no recall, its words are candidates for the vocabulary-gap
    backfill: if this turn's session reaches a memory, the missed
    words are filed into it as abstract terms (in memory_store).
    """
    for row in reversed(rows):
        if row.role != "assistant" or not row.metadata_json:
            continue
        debug = row.metadata_json.get("memory_search")
        if not isinstance(debug, dict):
            return []
        if debug.get("searches") and not debug.get("disclosed") and not debug.get("recalled_ids"):
            terms: list[str] = []
            for search in debug["searches"]:
                if isinstance(search, dict):
                    for term in search.get("terms") or []:
                        term = str(term)
                        if term not in terms:
                            terms.append(term)
            return terms
        return []
    return []


def _apply_handover_limits(
    settings: Settings,
    delivered: list[DeliveredMemory],
    resident: list[DeliveredMemory],
) -> tuple[list[DeliveredMemory], list[DeliveredMemory]]:
    """Bound what stages B and C receive (spec §20-12).

    The search itself is never narrowed; only the delivery is. The
    latest set is capped by count, then the combined rendering is
    trimmed to the token budget — resident entries (least recently
    linked last in the list) go first, then the latest set's tail.
    The budget is measured on the rendered text; character count is
    the conservative proxy the tokenizer fallback also uses.
    """
    latest = delivered[: settings.memory_handover_limit]
    resident_kept = [
        item for item in resident if all(item.memory.id != other.memory.id for other in latest)
    ]

    def rendered() -> int:
        return sum(len(memory_line(item)) for item in latest) + sum(
            len(memory_line(item)) for item in resident_kept
        )

    while resident_kept and rendered() > settings.memory_handover_token_budget:
        resident_kept.pop()
    while len(latest) > 1 and rendered() > settings.memory_handover_token_budget:
        latest.pop()
    return latest, resident_kept


async def _run_emotion_stage(
    request: Request,
    session: AsyncSession,
    user_message: Message,
    state: Any,
    rows: list[Message],
    *,
    resident: list[DeliveredMemory],
    delivered: list[DeliveredMemory],
    notification: dict[str, Any] | None,
    record: dict[str, Any],
    profile: UserProfile | None = None,
    birthday_today: bool = False,
) -> tuple[StateAnalysis | None, Any, dict[str, Any] | None]:
    """Stage B for one turn, then mark the front-stage record applied.

    Returns (analysis, state, applied_state_payload). A failed or
    unparsable analysis leaves the state unchanged and the record
    unapplied, so a later resend retries this stage only.
    """
    settings: Settings = request.app.state.settings
    client: AsyncOpenAI = request.app.state.llm_client
    history_rows = await recent_state_history(session, 3)
    analysis = await analyze_emotion(
        client,
        settings,
        user_message.content,
        state,
        [row for row in rows if row.id != user_message.id],
        history_rows=history_rows,
        resident=resident,
        latest=delivered,
        notification=notification,
        session_factory=request.app.state.session_factory,
        message_id=user_message.id,
        now=datetime.now().astimezone(),
        profile=profile,
        birthday_today=birthday_today,
    )
    if analysis is None:
        return None, state, None
    applied = await apply_state_analysis(session, settings, user_message.id, analysis)
    if applied is None:
        return analysis, state, None
    record["emotion"] = analysis.model_dump(mode="json")
    record["emotion_applied"] = True
    user_message.metadata_json = {
        **(user_message.metadata_json or {}),
        FRONT_STAGE_METADATA_KEY: record,
    }
    await session.commit()
    payload = CharacterStateResponse.model_validate(applied).model_dump(mode="json")
    return analysis, applied, payload


async def _prepare_turn(
    request: Request,
    user_message_id: int,
    *,
    reuse_front_stage: bool,
) -> _TurnPrep:
    """Build the generation context for one turn.

    The front stage runs A (memory processing) then B (emotion
    analysis) as separate calls, and each stage commits before the
    next begins: A's writes, the turn's memory links, and the
    front-stage record land in one commit, and B's state application
    (idempotent per message) marks the record applied. With
    ``reuse_front_stage`` (a resend of a failed turn), settled stages
    are skipped from the record — A is never repeated, and B is only
    retried when its application never landed.
    """
    settings: Settings = request.app.state.settings
    client: AsyncOpenAI = request.app.state.llm_client
    session_factory = request.app.state.session_factory
    async with session_factory() as session:
        user_message = await session.get(Message, user_message_id)
        if user_message is None:
            raise RuntimeError("user_message_missing")
        rows = list(
            (
                await session.scalars(
                    select(Message).where(Message.archived_at.is_(None)).order_by(Message.id.asc())
                )
            ).all()
        )
        state = await get_state_with_decay(session, settings)
        resident = await resident_memories(session, settings, before_message_id=user_message_id)
        profile = await profile_store.get_profile(session)
        birthday_today = profile_store.is_birthday_today(
            profile, datetime.now().astimezone().date()
        )
        delivered: list[DeliveredMemory] = []
        ask_back: list[Memory] = []
        notification: dict[str, Any] | None = None
        front_state_analysis: dict[str, Any] | None = None
        applied_state_payload: dict[str, Any] | None = None
        memory_search_debug: dict[str, Any] | None = None

        record = _stored_front_record(user_message) if reuse_front_stage else None
        if record is not None:
            # Resume from the stored record: rebuild the disclosure
            # from the rows it names (rows forgotten or provisional
            # since then no longer pass), and retry stage B only if
            # its application never landed.
            wanted = record.get("delivered") or []
            ids = [int(item["id"]) for item in wanted if isinstance(item, dict)]
            by_id: dict[int, Memory] = {}
            if ids:
                by_id = {
                    row.id: row
                    for row in (
                        await session.scalars(select(Memory).where(Memory.id.in_(ids)))
                    ).all()
                }
            for item in wanted:
                if not isinstance(item, dict):
                    continue
                row = by_id.get(int(item.get("id") or 0))
                if row is not None and row.is_active and not row.provisional:
                    delivered.append(DeliveredMemory(row, str(item.get("delivery"))))
            ask_ids = [int(i) for i in record.get("ask_back_ids") or []]
            if ask_ids:
                ask_rows = {
                    row.id: row
                    for row in (
                        await session.scalars(select(Memory).where(Memory.id.in_(ask_ids)))
                    ).all()
                }
                ask_back = [
                    ask_rows[i] for i in ask_ids if i in ask_rows and ask_rows[i].provisional
                ]
            terms = [str(t) for t in record.get("notification_terms") or []]
            notification = {"terms": terms} if terms else None
            memory_search_debug = record.get("agent")
            if isinstance(record.get("emotion"), dict):
                front_state_analysis = record["emotion"]
            applied_state_payload = CharacterStateResponse.model_validate(state).model_dump(
                mode="json"
            )
            if not record.get("emotion_applied") and not await state_application_exists(
                session, user_message
            ):
                analysis, state, payload = await _run_emotion_stage(
                    request,
                    session,
                    user_message,
                    state,
                    rows,
                    resident=resident,
                    delivered=delivered,
                    notification=notification,
                    record=record,
                    profile=profile,
                    birthday_today=birthday_today,
                )
                if analysis is not None:
                    front_state_analysis = analysis.model_dump(mode="json")
                if payload is not None:
                    applied_state_payload = payload
        elif reuse_front_stage and await state_application_exists(session, user_message):
            # Legacy guard: a state-history row proves the front stage
            # was applied before records existed; never apply it twice.
            applied_state_payload = CharacterStateResponse.model_validate(state).model_dump(
                mode="json"
            )
        else:
            history_rows = await recent_state_history(session, 3)
            agent: AgentResult = await run_memory_agent(
                session,
                client,
                settings,
                question=user_message.content,
                state=state,
                recent_messages=[row for row in rows if row.id != user_message.id],
                state_history_lines=state_history_lines(history_rows),
                session_factory=session_factory,
                message_id=user_message.id,
                source_date=as_utc(user_message.created_at),
                previous_missed_terms=_previous_missed_terms(rows),
                profile=profile,
                birthday_today=birthday_today,
            )
            delivered = agent.delivered
            ask_back = agent.ask_back
            notification = agent.notification
            memory_search_debug = agent.debug_payload()
            await record_links(session, user_message.id, delivered)
            record = {
                "version": 2,
                "agent": memory_search_debug,
                "emotion": None,
                "emotion_applied": False,
                "delivered": [
                    {"id": item.memory.id, "delivery": item.delivery} for item in delivered
                ],
                "ask_back_ids": [row.id for row in ask_back],
                "notification_terms": (list(notification["terms"]) if notification else []),
            }
            user_message.metadata_json = {
                **(user_message.metadata_json or {}),
                FRONT_STAGE_METADATA_KEY: record,
            }
            # Stage A's commit point: its writes, the links, and the
            # record land together. A crash before this commit leaves
            # nothing behind, and the stage is simply run again.
            await session.commit()
            analysis, state, payload = await _run_emotion_stage(
                request,
                session,
                user_message,
                state,
                rows,
                resident=resident,
                delivered=delivered,
                notification=notification,
                record=record,
                profile=profile,
                birthday_today=birthday_today,
            )
            if analysis is not None:
                front_state_analysis = analysis.model_dump(mode="json")
            if payload is not None:
                applied_state_payload = payload

        latest, resident_kept = _apply_handover_limits(settings, delivered, resident)
        summary = await session.scalar(
            select(Summary)
            .where(Summary.active.is_(True), Summary.archived_at.is_(None))
            .order_by(Summary.id.desc())
        )
        now_local = datetime.now().astimezone()
        previous_rows = [row for row in rows if row.id < user_message.id]
        elapsed_text = (
            elapsed_since_text(previous_rows[-1].created_at, now_local) if previous_rows else None
        )
        system_prompt = build_system_prompt(
            request.app.state.character,
            state,
            summary=summary,
            latest=latest,
            resident=resident_kept,
            ask_back=ask_back,
            notification=notification,
            current_time=format_current_time(now_local),
            elapsed_since_previous=elapsed_text,
            user_profile=profile,
            birthday_today=birthday_today,
        )
        recent_rows = rows
        if summary:
            recent_rows = [row for row in rows if row.id > summary.end_message_id]
        llm_messages = [
            {"role": "system", "content": system_prompt},
            *history_as_messages(recent_rows),
        ]
    return _TurnPrep(
        llm_messages=llm_messages,
        front_state_analysis=front_state_analysis,
        applied_state_payload=applied_state_payload,
        memory_search_debug=memory_search_debug,
    )


async def _stream_turn(
    request: Request,
    user_message_id: int,
    prep: _TurnPrep,
    upstream: Any,
) -> AsyncIterator[str]:
    """Produce the SSE events of one turn's generation (stage C).

    This only produces events. The locks are owned by the detached
    turn task (`_run_turn`), which drives this generator and releases
    everything in its own ``finally`` however the generation ends.
    The generation itself is a single tool-less segment; if it fails,
    no reply is saved and the turn stays dangling for a resend —
    nothing is rolled back (withdrawal was abolished, spec §13.1).
    An accepted turn always runs to completion: there is no stop
    control (spec §13.1).
    """
    activity: InferenceActivity = request.app.state.inference_activity
    speaking_noted = False

    def note_speaking() -> None:
        nonlocal speaking_noted
        if not speaking_noted:
            speaking_noted = True
            activity.note_foreground_phase(PHASE_SPEAKING)

    try:
        yield sse_event("message_start", {"message_id": user_message_id})
        if prep.front_state_analysis is not None:
            yield sse_event("state_analysis", prep.front_state_analysis)
        if prep.applied_state_payload is not None:
            yield sse_event("character_state", prep.applied_state_payload)
        response_parser = StreamedResponseParser()
        visible_content: list[str] = []
        raw_segment: list[str] = []
        prompt_tokens = 0
        completion_tokens = 0
        total_tokens = 0
        saw_usage = False
        recorded = False

        async def record_segment(error: str | None = None) -> None:
            nonlocal recorded
            if recorded:
                return
            recorded = True
            await raw_log_service.record_raw_log(
                request.app.state.session_factory,
                kind=raw_log_service.KIND_CHAT,
                request=raw_log_service.serialize_request(
                    prep.llm_messages, model=request.app.state.settings.llm_model
                ),
                response="".join(raw_segment) or None,
                error=error,
                message_id=user_message_id,
            )

        def absorb_usage(chunk: Any) -> None:
            nonlocal prompt_tokens, completion_tokens, total_tokens, saw_usage
            usage = getattr(chunk, "usage", None)
            if usage is None:
                return

            def number(name: str) -> int:
                raw = usage.get(name) if isinstance(usage, dict) else getattr(usage, name, 0)
                try:
                    return int(raw or 0)
                except (TypeError, ValueError):
                    return 0

            saw_usage = True
            prompt_tokens += number("prompt_tokens")
            completion_tokens += number("completion_tokens")
            total_tokens += number("total_tokens")

        def usage_body() -> dict[str, int]:
            return {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": total_tokens,
            }

        async for chunk in upstream:
            absorb_usage(chunk)
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta.content:
                raw_segment.append(delta.content)
                visible = response_parser.feed(delta.content)
                if visible:
                    visible_content.append(visible)
                    note_speaking()
                    yield sse_event("token", {"content": visible})
        trailing_text = response_parser.finish()
        if trailing_text:
            visible_content.append(trailing_text)
            note_speaking()
            yield sse_event("token", {"content": trailing_text})
        await record_segment()
        final_answer = "".join(visible_content)
        async with request.app.state.session_factory() as write_session:
            metadata: dict[str, Any] = {}
            if saw_usage:
                metadata["usage"] = usage_body()
            if prep.front_state_analysis is not None:
                metadata["state_analysis"] = prep.front_state_analysis
            if prep.memory_search_debug is not None:
                metadata["memory_search"] = prep.memory_search_debug
            assistant_message = Message(
                role="assistant",
                content=final_answer,
                metadata_json=metadata or None,
            )
            write_session.add(assistant_message)
            await write_session.commit()
            await write_session.refresh(assistant_message)
            request.app.state.job_notify.set()
        if saw_usage:
            yield sse_event("usage", usage_body())
        yield sse_event("message_end", {"message_id": user_message_id})
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Chat stream failed")
        yield sse_event("error", {"code": "generation_failed"})
    finally:
        await upstream.close()


@dataclass
class _TurnOutcome:
    """How the request learns whether the detached turn got started.

    Preparation runs inside the detached task, but its failures are the
    endpoint's HTTP errors, so the task records the mapped error here
    and the request re-raises it. ``ready`` is set once preparation has
    either failed (``error`` set) or produced the first completion.
    """

    ready: asyncio.Event = field(default_factory=asyncio.Event)
    error: BaseException | None = None


def _as_http_error(exc: BaseException) -> BaseException:
    """A failure before the stream is established is an HTTP error;
    anything else propagates unchanged.
    """
    if isinstance(exc, (HTTPException, asyncio.CancelledError)):
        return exc
    if isinstance(exc, APITimeoutError):
        return HTTPException(status_code=504, detail={"code": "llm_timeout"})
    if isinstance(exc, APIConnectionError):
        return HTTPException(status_code=503, detail={"code": "llm_unavailable"})
    if isinstance(exc, APIStatusError):
        return HTTPException(status_code=502, detail={"code": "llm_error"})
    return exc


async def _run_turn(
    request: Request,
    outcome: _TurnOutcome,
    events: asyncio.Queue[str | None],
    prepare: Callable[[], Awaitable[int]],
    *,
    reuse_front_stage: bool,
    generation_lock: asyncio.Lock,
) -> None:
    """Execute one accepted turn to completion, detached from the client.

    This task owns the turn: it waits for the shared inference lock,
    runs the preparation and the generation, saves the reply, and
    releases everything it holds in its ``finally`` — the generation
    lock and the inference lock (with the activity tracker) — however
    the turn ends. The client connection plays no part here; the SSE
    events are queued for `_forward_events` to forward for as long as
    someone is listening, and are simply discarded once the turn is
    over if nobody is.

    There is no stop control (spec §13.1): an accepted turn always
    runs to completion, and an unfinished turn stays dangling for a
    resend, which resumes from the front-stage record.
    """
    state = request.app.state
    settings: Settings = state.settings
    inference_lock: asyncio.Lock = state.inference_lock
    activity: InferenceActivity = state.inference_activity
    inference_held = False

    def release_inference() -> None:
        nonlocal inference_held
        if inference_held:
            inference_held = False
            activity.foreground_released()
            inference_lock.release()

    try:
        activity.foreground_wait()
        try:
            await inference_lock.acquire()
        except BaseException:
            activity.foreground_wait_cancelled()
            raise
        inference_held = True
        activity.foreground_acquired()
        activity.note_foreground_phase(PHASE_THINKING)
        try:
            user_message_id = await prepare()
            prep = await _prepare_turn(
                request, user_message_id, reuse_front_stage=reuse_front_stage
            )
            try:
                upstream = await start_completion(state.llm_client, settings, prep.llm_messages)
            except Exception as exc:
                await raw_log_service.record_raw_log(
                    state.session_factory,
                    kind=raw_log_service.KIND_CHAT,
                    request=raw_log_service.serialize_request(
                        prep.llm_messages, model=settings.llm_model
                    ),
                    error=raw_log_service.format_error(exc),
                    message_id=user_message_id,
                )
                raise
        except BaseException as exc:
            # Preparation failed before the stream was established:
            # hand the error to the request, which reports it as this
            # endpoint's HTTP error. If the client is already gone the
            # value is simply never read.
            outcome.error = _as_http_error(exc)
            return
        outcome.ready.set()
        async for event in _stream_turn(request, user_message_id, prep, upstream):
            events.put_nowait(event)
    finally:
        release_inference()
        generation_lock.release()
        # Wake the request if preparation never got to report (the task
        # itself was cancelled), and end the forwarded stream.
        outcome.ready.set()
        events.put_nowait(None)


async def _forward_events(events: asyncio.Queue[str | None]) -> AsyncIterator[str]:
    """Forward a detached turn's SSE events to the client.

    The ``None`` sentinel ends the stream. If the client disconnects,
    forwarding stops here; the turn keeps running in its own task and
    its remaining events are discarded unread.
    """
    while True:
        event = await events.get()
        if event is None:
            return
        yield event


async def _execute_turn(
    request: Request,
    prepare: Callable[[], Awaitable[int]],
    *,
    reuse_front_stage: bool,
) -> StreamingResponse:
    """Accept one chat turn and stream its events.

    ``prepare`` resolves (creating, for a new message) the user message
    the turn answers and returns its id. The turn itself runs in a
    detached task (`_run_turn`) that owns the generation lock, so once
    a turn is accepted it runs to completion and saves its reply even
    if the client disconnects; this request only waits until the turn
    is prepared — preparation failures are the endpoint's HTTP errors,
    exactly as before — and then forwards the turn's events.
    """
    lock: asyncio.Lock = request.app.state.generation_lock
    if lock.locked():
        raise HTTPException(status_code=409, detail={"code": "generation_in_progress"})
    await lock.acquire()
    outcome = _TurnOutcome()
    events: asyncio.Queue[str | None] = asyncio.Queue()
    task = asyncio.create_task(
        _run_turn(
            request,
            outcome,
            events,
            prepare,
            reuse_front_stage=reuse_front_stage,
            generation_lock=lock,
        )
    )
    request.app.state.turn_task = task

    def forget_task(done: asyncio.Task[None]) -> None:
        if request.app.state.turn_task is done:
            request.app.state.turn_task = None

    task.add_done_callback(forget_task)
    # If the client disconnects during preparation, this wait is
    # cancelled and the endpoint goes away — the detached task is
    # untouched and finishes the turn regardless.
    await outcome.ready.wait()
    if outcome.error is not None:
        raise outcome.error
    return StreamingResponse(
        _forward_events(events),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


_SSE_RESPONSES: dict[int | str, dict[str, Any]] = {
    200: {
        "description": "SSE stream. Each frame is event: <name> followed by data: <JSON>.",
        "content": {
            "text/event-stream": {
                "schema": {"type": "string"},
                "x-sse-events": SSE_EVENT_SCHEMAS,
            }
        },
    },
    502: {"model": APIError, "description": "The LLM server returned an error."},
    503: {"model": APIError, "description": "The LLM server is unavailable."},
    504: {"model": APIError, "description": "The LLM request timed out."},
}


@router.post(
    "",
    status_code=status.HTTP_200_OK,
    response_class=StreamingResponse,
    responses={
        **_SSE_RESPONSES,
        409: {"model": APIError, "description": "A chat generation is already in progress."},
    },
    openapi_extra={
        "description": (
            "Streams `message_start`, `token`, `usage`, "
            "`state_analysis`, `character_state`, `message_end`, and `error` events. "
            "Event payload schemas are in "
            "`200.content['text/event-stream'].x-sse-events`. HTTP errors apply only before "
            "the stream is established; later errors are sent as `error` events."
        )
    },
)
async def send_message(payload: ChatRequest, request: Request) -> StreamingResponse:
    async def prepare() -> int:
        async with request.app.state.session_factory() as session:
            user_message = Message(role="user", content=payload.message)
            session.add(user_message)
            await session.commit()
            await session.refresh(user_message)
            return user_message.id

    return await _execute_turn(request, prepare, reuse_front_stage=False)


@router.post(
    "/resend",
    status_code=status.HTTP_200_OK,
    response_class=StreamingResponse,
    responses={
        **_SSE_RESPONSES,
        409: {
            "model": APIError,
            "description": (
                "A chat generation is already in progress "
                "(`generation_in_progress`), or the last user message already "
                "has its assistant reply / there is no user message "
                "(`no_dangling_turn`)."
            ),
        },
    },
    openapi_extra={
        "description": (
            "Retries generation for the last user message when it has no "
            "assistant reply yet (a dangling turn, left behind when a "
            "generation failed after the user message was saved). "
            "No new user message is created. The front stage "
            "resumes from its stored record: stage A is never repeated, "
            "and the emotion analysis is applied at most once. The stream "
            "has the same events as `POST /api/chat`."
        )
    },
)
async def resend_message(request: Request) -> StreamingResponse:
    async def prepare() -> int:
        async with request.app.state.session_factory() as session:
            rows = (
                await session.scalars(
                    select(Message).where(Message.archived_at.is_(None)).order_by(Message.id.asc())
                )
            ).all()
            last_user = next((row for row in reversed(rows) if row.role == "user"), None)
            if last_user is None or any(
                row.role == "assistant" for row in rows if row.id > last_user.id
            ):
                raise HTTPException(status_code=409, detail={"code": "no_dangling_turn"})
            return last_user.id

    return await _execute_turn(request, prepare, reuse_front_stage=True)


@router.get("/history", response_model=HistoryResponse)
async def get_history(
    before_id: int | None = Query(default=None, ge=1),
    limit: int = Query(default=100, ge=1, le=500),
    include_archived: bool = False,
    session: AsyncSession = Depends(get_db),
) -> HistoryResponse:
    """One page of conversation history, newest page first-class.

    Messages are returned in chronological order. Without parameters
    this is the latest page of the active conversation; pass
    ``before_id`` (the oldest id of the page already held) to walk
    further back, and ``has_more`` says whether anything older
    exists. Archived (invalidated) rows are excluded unless
    ``include_archived`` is set — the debug view uses that to show
    what forgetting removed, marked with ``archived``; they never
    re-enter the conversation itself.
    """
    statement = select(Message).order_by(Message.id.desc()).limit(limit + 1)
    if not include_archived:
        statement = statement.where(Message.archived_at.is_(None))
    if before_id is not None:
        statement = statement.where(Message.id < before_id)
    rows = list((await session.scalars(statement)).all())
    has_more = len(rows) > limit
    page = list(reversed(rows[:limit]))
    return HistoryResponse(
        messages=[
            MessageResponse.model_validate(row).model_copy(
                update={"archived": row.archived_at is not None}
            )
            for row in page
        ],
        has_more=has_more,
    )


@router.get("/inference-status", response_model=InferenceStatusResponse)
async def get_inference_status(request: Request) -> InferenceStatusResponse:
    activity: InferenceActivity = request.app.state.inference_activity
    return InferenceStatusResponse(**activity.snapshot())
