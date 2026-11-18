from types import SimpleNamespace
from typing import Any

import pytest

from app.api.chat import start_completion
from app.config import Settings


class CapturingCompletions:
    def __init__(self) -> None:
        self.kwargs: dict[str, Any] = {}

    async def create(self, **kwargs: Any) -> SimpleNamespace:
        self.kwargs = kwargs
        return SimpleNamespace()


def make_client() -> tuple[SimpleNamespace, CapturingCompletions]:
    completions = CapturingCompletions()
    client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    return client, completions


@pytest.mark.asyncio
async def test_start_completion_omits_sampling_parameters_by_default() -> None:
    client, completions = make_client()

    await start_completion(client, Settings(), [{"role": "user", "content": "hi"}])

    kwargs = completions.kwargs
    assert "temperature" not in kwargs
    assert "frequency_penalty" not in kwargs
    assert "presence_penalty" not in kwargs
    assert "repeat_penalty" not in kwargs["extra_body"]
    assert kwargs["extra_body"]["chat_template_kwargs"] == {"enable_thinking": False}


@pytest.mark.asyncio
async def test_start_completion_sends_configured_sampling() -> None:
    client, completions = make_client()
    settings = Settings(
        llm_temperature=0.7,
        llm_frequency_penalty=0.5,
        llm_presence_penalty=-0.5,
        llm_repeat_penalty=1.2,
    )

    await start_completion(client, settings, [{"role": "user", "content": "hi"}])

    kwargs = completions.kwargs
    assert kwargs["temperature"] == 0.7
    assert kwargs["frequency_penalty"] == 0.5
    assert kwargs["presence_penalty"] == -0.5
    assert kwargs["extra_body"]["repeat_penalty"] == 1.2
    assert kwargs["extra_body"]["chat_template_kwargs"] == {"enable_thinking": False}
