import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.api.character import router as character_router
from app.api.chat import router as chat_router
from app.api.debug import router as debug_router
from app.api.memory import router as memory_router
from app.api.settings import router as settings_router
from app.config import DEFAULT_CHARACTER_ID, Settings
from app.database.models import CharacterState
from app.database.session import create_engine, initialize_database
from app.llm.client import create_llm_client
from app.services import job_service, settings_service
from app.services.character_service import (
    load_character_layers,
    resolve_character,
    resolve_character_asset_directory,
)
from app.services.inference_status import InferenceActivity

logger = logging.getLogger("uvicorn.error")


def default_frontend_dist() -> Path:
    return Path(__file__).resolve().parents[2] / "frontend" / "dist"


def create_app(settings: Settings | None = None, frontend_dist: Path | None = None) -> FastAPI:
    app_settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        data_directory = app_settings.remorise_data_dir
        if app.state.frontend_dist is not None:
            logger.info("Serving the frontend build from %s", app.state.frontend_dist)
        else:
            logger.warning(
                "No frontend build found at %s; running API only. "
                "Build it with `pnpm build` in frontend/ (or start prod.py "
                "with --build) to serve the UI from this process.",
                default_frontend_dist(),
            )
        bundled_directory = (
            Path(__file__).resolve().parents[2] / "characters" / DEFAULT_CHARACTER_ID
        )
        logger.info("Backend environment file: %s", app_settings.env_file)
        logger.info("Remorise data directory: %s", data_directory)
        character, character_directory, character_id = resolve_character(
            data_directory, bundled_directory, app_settings.remorise_character_id
        )
        logger.info("Character: %s (%s)", character_id, character_directory)
        if not app_settings.database_url:
            logger.info(
                "Character database: %s",
                app_settings.database_path(character_id, app_settings.remorise_profile),
            )
        layers = load_character_layers(character_directory)
        engine = create_engine(
            app_settings.effective_database_url(character_id, app_settings.remorise_profile)
        )
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        app.state.engine = engine
        app.state.session_factory = session_factory
        app.state.settings = app_settings
        app.state.base_settings = app_settings.model_copy(deep=True)
        app.state.character = character
        app.state.character_id = character_id
        app.state.character_directory = character_directory
        app.state.character_layers = layers
        app.state.character_asset_directory = resolve_character_asset_directory(character_directory)
        app.state.llm_client = create_llm_client(app_settings)
        app.state.generation_lock = asyncio.Lock()
        app.state.turn_task = None
        app.state.inference_lock = asyncio.Lock()
        app.state.inference_activity = InferenceActivity()
        app.state.job_notify = asyncio.Event()
        app.state.job_worker = None
        try:
            await initialize_database(engine, session_factory)
            await settings_service.refresh_from_database(app)
            async with session_factory() as session:
                if await session.get(CharacterState, 1) is None:
                    initial = character.initial_state
                    session.add(
                        CharacterState(
                            id=1,
                            emotion=initial.emotion,
                            intensity=initial.intensity,
                            mood=initial.mood,
                            affinity=initial.affinity,
                        )
                    )
                    await session.commit()
            worker = asyncio.create_task(job_service.worker_loop(app))
            app.state.job_worker = worker
            yield
        finally:
            # A detached chat turn does not outlive the process: on
            # shutdown it is cancelled, which leaves its user message
            # dangling for a later resend.
            turn = app.state.turn_task
            if turn is not None:
                turn.cancel()
                await asyncio.gather(turn, return_exceptions=True)
            worker = app.state.job_worker
            if worker is not None:
                worker.cancel()
                await asyncio.gather(worker, return_exceptions=True)
            await app.state.llm_client.close()
            await engine.dispose()

    application = FastAPI(title="Remorise API", version="0.1.0", lifespan=lifespan)
    application.include_router(chat_router)
    application.include_router(character_router)
    application.include_router(memory_router)
    application.include_router(debug_router)
    application.include_router(settings_router)

    @application.get("/health", tags=["health"])
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    application.state.frontend_dist = _mount_frontend(
        application, frontend_dist or default_frontend_dist()
    )

    return application


def _mount_frontend(application: FastAPI, dist: Path) -> Path | None:
    """Serve the built frontend from `dist` when it exists.

    Registered last, so every API route wins over the catch-all. Paths
    under /api/ that no route claimed keep their JSON 404 instead of
    falling back to the SPA; any other unknown path serves index.html
    so client-side routes survive a reload. Without a build the app is
    API-only and this returns None.
    """
    index = dist / "index.html"
    if not index.is_file():
        return None
    dist_root = dist.resolve()

    @application.get("/{full_path:path}", include_in_schema=False)
    async def serve_frontend(full_path: str) -> FileResponse:
        if full_path == "api" or full_path.startswith("api/"):
            raise HTTPException(status_code=404)
        candidate = (dist_root / full_path).resolve()
        if candidate.is_relative_to(dist_root) and candidate.is_file():
            # Vite's hashed build output never changes under its
            # name, so it can be cached for good; everything else
            # (index.html above all) must revalidate, or a deploy
            # leaves clients asking for chunks that no longer exist.
            if candidate.parent == dist_root / "assets":
                return FileResponse(
                    candidate,
                    headers={"Cache-Control": "public, max-age=31536000, immutable"},
                )
            return FileResponse(candidate, headers={"Cache-Control": "no-cache"})
        return FileResponse(index, headers={"Cache-Control": "no-cache"})

    return dist


app = create_app()
