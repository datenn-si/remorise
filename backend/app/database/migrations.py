import logging
from collections.abc import Awaitable, Callable

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

logger = logging.getLogger(__name__)

# The schema version of the current model definitions. Version 1 is
# the first schema managed by this migration chain: databases created
# by earlier builds carry no stamp, and their tables were built by the
# same create_all from the same definitions, so they are version 1 by
# definition and are stamped as such on first boot.
SCHEMA_VERSION = 1

Migration = Callable[[AsyncConnection], Awaitable[None]]

# Steps keyed by the version they upgrade FROM: MIGRATIONS[v] takes a
# database at version v to version v + 1. A schema change that must
# rewrite existing data ships as one step here in the same change, and
# SCHEMA_VERSION is bumped to match. Steps run one transaction each,
# and the stamp is written inside the step's transaction, so a failed
# step leaves the database at its previous version.
MIGRATIONS: dict[int, Migration] = {}


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
