import logging
from collections.abc import Awaitable, Callable

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

logger = logging.getLogger(__name__)

# The schema version of the current model definitions. An unstamped
# database was just built by create_all from these definitions, so it
# is stamped at SCHEMA_VERSION without running steps. A database
# stamped by an older build runs the steps from that version.
SCHEMA_VERSION = 2

Migration = Callable[[AsyncConnection], Awaitable[None]]

# Steps keyed by the version they upgrade FROM: MIGRATIONS[v] takes a
# database at version v to version v + 1. A schema change that must
# rewrite existing data ships as one step here in the same change, and
# SCHEMA_VERSION is bumped to match. Steps run one transaction each,
# and the stamp is written inside the step's transaction, so a failed
# step leaves the database at its previous version.


async def _migrate_v1_to_v2(connection: AsyncConnection) -> None:
    """Add per-model token counts. Values are filled when used, not here."""
    await connection.execute(text("ALTER TABLE messages ADD COLUMN token JSON"))
    await connection.execute(text("ALTER TABLE summaries ADD COLUMN token JSON"))
    await connection.execute(
        text(
            "CREATE TABLE IF NOT EXISTS system_prompt_tokens ("
            "model_id VARCHAR(200) NOT NULL, "
            "content_hash VARCHAR(64) NOT NULL, "
            "token_count INTEGER NOT NULL, "
            "PRIMARY KEY (model_id, content_hash))"
        )
    )


MIGRATIONS: dict[int, Migration] = {1: _migrate_v1_to_v2}


async def _read_version(connection: AsyncConnection) -> int | None:
    await connection.execute(
        text("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
    )
    return await connection.scalar(text("SELECT version FROM schema_version"))


async def _write_version(connection: AsyncConnection, version: int) -> None:
    await connection.execute(text("DELETE FROM schema_version"))
    await connection.execute(
        text("INSERT INTO schema_version (version) VALUES (:version)"),
        {"version": version},
    )


async def apply_migrations(engine: AsyncEngine) -> int:
    """Bring the database schema to SCHEMA_VERSION and return it.

    An unstamped database is stamped at SCHEMA_VERSION without running
    steps (see the note at SCHEMA_VERSION). A database stamped newer
    than this build is refused: running older code against a newer
    schema could corrupt data the newer build relies on.
    """
    async with engine.begin() as connection:
        current = await _read_version(connection)
        if current is None:
            await _write_version(connection, SCHEMA_VERSION)
            logger.info("Stamped unstamped database at schema version %d", SCHEMA_VERSION)
            return SCHEMA_VERSION
    if current > SCHEMA_VERSION:
        raise RuntimeError(
            f"Database schema version {current} is newer than this build "
            f"supports ({SCHEMA_VERSION}); refusing to start"
        )
    while current < SCHEMA_VERSION:
        step = MIGRATIONS.get(current)
        if step is None:
            raise RuntimeError(f"No migration step from schema version {current}")
        async with engine.begin() as connection:
            await step(connection)
            await _write_version(connection, current + 1)
        logger.info("Migrated database schema %d -> %d", current, current + 1)
        current += 1
    return current
