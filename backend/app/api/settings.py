from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.session import get_db
from app.schemas.settings import (
    OperationalSettingsResponse,
    OperationalSettingsUpdate,
    OperationalValues,
    ReadonlySettingsInfo,
)
from app.services import settings_service

router = APIRouter(prefix="/api/settings", tags=["settings"])


def _response(request: Request, overrides: dict) -> OperationalSettingsResponse:
    settings = request.app.state.settings
    base = request.app.state.base_settings
    return OperationalSettingsResponse(
        **{field: getattr(settings, field) for field in settings_service.OPERATIONAL_FIELDS},
        overridden=sorted(
            field for field in settings_service.OPERATIONAL_FIELDS if field in overrides
        ),
        base_values=OperationalValues(
            **{field: getattr(base, field) for field in settings_service.OPERATIONAL_FIELDS}
        ),
        readonly=ReadonlySettingsInfo(
            llm_base_url=settings.llm_base_url,
            llm_model=settings.llm_model,
            llm_api_key_configured=bool(settings.llm_api_key.strip()),
            remorise_data_dir=str(settings.remorise_data_dir),
        ),
    )


@router.get("", response_model=OperationalSettingsResponse)
async def get_settings(
    request: Request, session: AsyncSession = Depends(get_db)
) -> OperationalSettingsResponse:
    """Effective operational settings and which fields the DB overrides.

    The response also carries the ``.env`` / default value of every
    field (``base_values``) and the base-layer configuration
    (``readonly``: LLM connection, model, data directory) for
    display only. Base-layer values themselves stay in
    ``.env`` and are never changed through this API; the LLM API key
    is reported only as configured-or-not.
    """
    overrides = await settings_service.load_overrides(session)
    return _response(request, overrides)


@router.patch("", response_model=OperationalSettingsResponse)
async def update_settings(
    payload: OperationalSettingsUpdate,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> OperationalSettingsResponse:
    """Update operational settings; takes effect without a restart.

    Values are stored in the database and override ``.env`` from then
    on (including across restarts). An explicit ``null`` resets a
    field to its ``.env`` / default value. The merged result must pass
    the same validation as ``.env`` settings, otherwise nothing is
    stored.
    """
    try:
        overrides = await settings_service.apply_patch(session, request.app, payload)
    except ValidationError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_settings", "message": str(exc)},
        ) from exc
    return _response(request, overrides)
