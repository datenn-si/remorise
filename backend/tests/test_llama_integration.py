import asyncio
import json
import os
from pathlib import Path
from typing import Any

import httpx
import pytest
from openai import AsyncOpenAI
from sqlalchemy import select

from app.config import Settings
from app.database.models import Memory, Message
from app.main import create_app
from app.services.context_manager import count_tokens
from app.services.memory_agent import TOOL_DEFINITIONS

LLAMA_BASE_URL = os.getenv("REMORISE_LLAMA_BASE_URL")

pytestmark = pytest.mark.skipif(
    not LLAMA_BASE_URL,
    reason="Set REMORISE_LLAMA_BASE_URL to run tests against a local llama.cpp server.",
)


async def consume_completion(
    stream: Any,
) -> tuple[str, list[dict[str, Any]], list[str], list[str]]:
    content: list[str] = []
    reasoning: list[str] = []
    finish_reasons: list[str] = []
    tool_calls: dict[int, dict[str, str]] = {}
    async for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta.content:
            content.append(delta.content)
        if reasoning_content := getattr(delta, "reasoning_content", None):
            reasoning.append(reasoning_content)
        if finish_reason := chunk.choices[0].finish_reason:
            finish_reasons.append(finish_reason)
        for fragment in delta.tool_calls or []:
            call = tool_calls.setdefault(fragment.index, {"id": "", "name": "", "arguments": ""})
            call["id"] += fragment.id or ""
            call["name"] += fragment.function.name or ""
            call["arguments"] += fragment.function.arguments or ""
    await stream.close()
    return (
        "".join(content),
        [tool_calls[index] for index in sorted(tool_calls)],
        reasoning,
        finish_reasons,
    )


@pytest.mark.asyncio
async def test_local_llama_streaming_tools_and_tokenizer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert LLAMA_BASE_URL is not None
    settings = Settings(
        llm_base_url=LLAMA_BASE_URL,
        llm_max_tokens=160,
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'llama-integration.db'}",
    )
    sample = "Remorise local tokenizer check"
    tokenizer_url = f"{settings.llm_base_url.rstrip('/').removesuffix('/v1')}/tokenize"
    async with httpx.AsyncClient(timeout=15) as tokenizer_client:
        tokenizer_response = await tokenizer_client.post(tokenizer_url, json={"content": sample})
        tokenizer_response.raise_for_status()
        expected_token_count = len(tokenizer_response.json()["tokens"])
    assert await count_tokens(sample, settings) == expected_token_count

    client = AsyncOpenAI(base_url=settings.llm_base_url, api_key=settings.llm_api_key, timeout=180)
    try:
        for thinking in (False, True):
            stream = await client.chat.completions.create(
                model=settings.llm_model,
                messages=[{"role": "user", "content": "Reply with one short greeting."}],
                max_tokens=48,
                stream=True,
                extra_body={"chat_template_kwargs": {"enable_thinking": thinking}},
            )
            answer, _, reasoning, finish_reasons = await consume_completion(stream)
            assert finish_reasons
            if thinking:
                assert reasoning
            else:
                assert answer.strip()
                assert not reasoning

        # Stage A's tool surface: the model must be able to call its
        # fixed backend functions.
        tool_stream = await client.chat.completions.create(
            model=settings.llm_model,
            messages=[
                {
                    "role": "user",
                    "content": (
                        "Call search_memories exactly once with terms "
                        "['remorise-integration-marker']. Do not answer before calling it."
                    ),
                }
            ],
            tools=TOOL_DEFINITIONS,
            tool_choice={"type": "function", "function": {"name": "search_memories"}},
            max_tokens=128,
            stream=True,
            extra_body={"chat_template_kwargs": {"enable_thinking": False}},
        )
        _, calls, _, _ = await consume_completion(tool_stream)
        assert len(calls) == 1
        assert calls[0]["name"] == "search_memories"
        assert json.loads(calls[0]["arguments"])["terms"]
    finally:
        await client.close()

    app = create_app(settings)
    async with app.router.lifespan_context(app):
        async with app.state.session_factory() as session:
            session.add(
                Memory(
                    content="remorise-integration-marker memory exists",
                    category="state",
                    importance=5,
                    status="active",
                    is_active=True,
                    provenance="explicit",
                    keywords=[],
                    specific_terms=["remorise-integration-marker"],
                    provisional=False,
                    source_type="conversation",
                )
            )
            await session.commit()

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test", timeout=240
        ) as api:
            response = await api.post(
                "/api/chat",
                json={"message": ("remorise-integration-marker について覚えていることを教えて。")},
            )
            assert response.status_code == 200
            assert response.text.count("event: token") >= 1
            assert "event: tool_start" not in response.text
            assert "event: tool_end" not in response.text
            assert "event: message_end" in response.text
            async with app.state.session_factory() as session:
                messages = list(
                    (await session.scalars(select(Message).order_by(Message.id.asc()))).all()
                )
                assert [row.role for row in messages] == ["user", "assistant"]
                assert messages[-1].content


@pytest.mark.asyncio
async def test_local_llama_concurrent_request_rejection(
    tmp_path: Path,
) -> None:
    assert LLAMA_BASE_URL is not None
    settings = Settings(
        llm_base_url=LLAMA_BASE_URL,
        llm_max_tokens=2_048,
        database_url="sqlite+aiosqlite:///" + str(tmp_path / "llama-busy.db"),
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test", timeout=180
        ) as api:
            generation = asyncio.create_task(
                api.post(
                    "/api/chat",
                    json={
                        "message": (
                            "Write a very long, detailed story of at least two thousand words. "
                            "Continue until you reach the output limit."
                        )
                    },
                )
            )
            for _ in range(500):
                if app.state.generation_lock.locked():
                    break
                await asyncio.sleep(0.01)
            assert app.state.generation_lock.locked()

            rejected = await api.post("/api/chat", json={"message": "A competing message"})
            assert rejected.status_code == 409
            # There is no stop control: the cancel endpoint must stay gone.
            assert "/api/chat/cancel" not in app.openapi()["paths"]
            missing = await api.post("/api/chat/cancel")
            assert missing.status_code in {404, 405}

            response = await asyncio.wait_for(generation, timeout=180)
            assert response.status_code == 200
            assert "event: message_end" in response.text
            assert not app.state.generation_lock.locked()
            async with app.state.session_factory() as session:
                roles = list(
                    (await session.scalars(select(Message.role).order_by(Message.id.asc()))).all()
                )
                assert roles == ["user", "assistant"]
