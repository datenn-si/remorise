import logging
from pathlib import Path

import pytest

from app.config import Settings
from app.main import create_app


def test_create_app_does_not_mirror_debug_logs_to_stderr() -> None:
    create_app()
    for name in (
        "app.services.memory_search",
        "app.services.memory_service",
        "app.services.context_manager",
    ):
        logger = logging.getLogger(name)
        assert not any(
            getattr(handler, "_remorise_console_handler", False) for handler in logger.handlers
        )


@pytest.mark.asyncio
async def test_startup_logs_absolute_data_directory(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    data_directory = tmp_path / "remorise-data"
    caplog.set_level(logging.INFO, logger="uvicorn.error")
    app = create_app(Settings(remorise_data_dir=data_directory))

    async with app.router.lifespan_context(app):
        assert data_directory.is_dir()

    assert str(data_directory.resolve()) in caplog.text
