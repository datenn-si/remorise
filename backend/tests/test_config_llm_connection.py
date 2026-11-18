"""The LLM connection values have no defaults.

The connection belongs to the user's LLM server, so leaving
LLM_BASE_URL, LLM_API_KEY or LLM_MODEL unset is a startup error
instead of a silent guess. The suite-wide conftest provides them
for the tests that do not care; these tests remove them again to
see the error.
"""

import pytest
from pydantic import ValidationError

from app.config import Settings


def test_settings_without_a_base_url_is_an_error(monkeypatch):
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    with pytest.raises(ValidationError):
        Settings()


def test_settings_without_an_api_key_is_an_error(monkeypatch):
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    with pytest.raises(ValidationError):
        Settings()


def test_settings_without_a_model_is_an_error(monkeypatch):
    monkeypatch.delenv("LLM_MODEL", raising=False)
    with pytest.raises(ValidationError):
        Settings()


def test_settings_trims_the_model_name(monkeypatch):
    monkeypatch.setenv("LLM_MODEL", "  demo-model  ")
    assert Settings().llm_model == "demo-model"
