import hashlib
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.models import CharacterState, StateHistory
from app.database.session import get_db
from app.schemas.character import CharacterConfig
from app.schemas.state import CharacterStateResponse, CharacterStateUpdate
from app.services.character_service import load_character_terms, sprite_available
from app.services.emotion_service import get_state_with_decay

router = APIRouter(prefix="/api/character", tags=["character"])


@router.get("", response_model=CharacterConfig)
async def get_character(request: Request) -> CharacterConfig:
    return request.app.state.character


@router.get("/terms")
async def get_character_terms(request: Request) -> dict[str, object]:
    markdown = load_character_terms(Path(request.app.state.character_directory))
    return {"available": markdown is not None, "markdown": markdown or ""}


@router.get("/layers")
async def get_character_layers(request: Request) -> dict[str, object]:
    layers = dict(request.app.state.character_layers)
    layers["root"] = "/api/character/assets"
    # The backend is authoritative for whether a sprite exists at all:
    # the frontend hides the sprite area (and closes the sprite debug
    # page) when no referenced image file is present.
    layers["available"] = sprite_available(
        layers, Path(request.app.state.character_asset_directory)
    )
    return layers


@router.get("/assets/{asset_path:path}")
async def get_character_asset(asset_path: str, request: Request) -> Response:
    asset_directory = Path(request.app.state.character_asset_directory).resolve()
    path = (asset_directory / asset_path).resolve()
    if not path.is_relative_to(asset_directory) or not path.is_file():
        raise HTTPException(status_code=404, detail={"code": "character_asset_not_found"})
    # Layer images are large and numerous; on a slow link a repeat
    # visit must revalidate (a cheap 304) instead of re-downloading
    # them, while never serving a stale image after the file on disk
    # changes. FileResponse sends an etag but never answers the
    # conditional request, so the 304 is produced here; the etag
    # mirrors the one FileResponse computes from the same stat.
    stat = path.stat()
    etag_base = str(stat.st_mtime) + "-" + str(stat.st_size)
    etag = f'"{hashlib.md5(etag_base.encode(), usedforsecurity=False).hexdigest()}"'
    headers = {"Cache-Control": "no-cache", "ETag": etag}
    if_none_match = request.headers.get("if-none-match")
    if if_none_match is not None and etag in if_none_match:
        return Response(status_code=304, headers=headers)
    return FileResponse(path, headers=headers)


@router.get("/state", response_model=CharacterStateResponse)
async def get_character_state(
    request: Request, session: AsyncSession = Depends(get_db)
) -> CharacterState:
    return await get_state_with_decay(session, request.app.state.settings)


@router.patch("/state", response_model=CharacterStateResponse)
async def update_character_state(
    payload: CharacterStateUpdate, session: AsyncSession = Depends(get_db)
) -> CharacterState:
    state = await session.get(CharacterState, 1)
    if state is None:
        raise HTTPException(status_code=404, detail={"code": "character_state_not_found"})
    changes = payload.model_dump(exclude_unset=True)
    before_emotion, before_affinity = state.emotion, state.affinity
    for key, value in changes.items():
        setattr(state, key, value)
    state.updated_at = datetime.now(UTC)
    if {
        "emotion",
        "intensity",
        "secondary_emotion",
        "secondary_intensity",
    } & payload.model_fields_set:
        state.last_emotion_update = state.updated_at
    if changes:
        session.add(
            StateHistory(
                emotion_before=before_emotion,
                emotion_after=state.emotion,
                affinity_before=before_affinity,
                affinity_after=state.affinity,
                reason="manual update",
            )
        )
    await session.commit()
    await session.refresh(state)
    return state
