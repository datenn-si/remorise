import httpx
import pytest

from app.config import Settings
from app.services import context_manager


@pytest.mark.asyncio
async def test_token_count_uses_llama_tokenize_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[tuple[str, dict[str, str]]] = []

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, list[int]]:
            return {"tokens": [1, 2, 3]}

    class FakeClient:
        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        async def post(self, url: str, json: dict[str, str]) -> FakeResponse:
            seen.append((url, json))
            return FakeResponse()

    monkeypatch.setattr(context_manager.httpx, "AsyncClient", lambda **kwargs: FakeClient())
    settings = Settings(llm_base_url="http://llama.local/v1", llm_model="demo")
    assert await context_manager.count_tokens("hello", settings) == 3
    assert seen == [("http://llama.local/tokenize", {"content": "hello", "model": "demo"})]


@pytest.mark.asyncio
async def test_token_count_falls_back_when_llama_tokenize_is_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FailingClient:
        async def __aenter__(self) -> "FailingClient":
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        async def post(self, *args: object, **kwargs: object) -> None:
            request = httpx.Request("POST", "http://llama.local/tokenize")
            raise httpx.ConnectError("unavailable", request=request)

    monkeypatch.setattr(context_manager.httpx, "AsyncClient", lambda **kwargs: FailingClient())
    text = "fallback count"
    assert await context_manager.count_tokens(text, Settings()) == len(text)
