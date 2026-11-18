from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import Request
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.database.migrations import apply_migrations
from app.database.models import Base, Conversation, ConversationMeta


def create_engine(database_url: str) -> AsyncEngine:
    url = make_url(database_url)
    if url.drivername.startswith("sqlite") and url.database not in (None, ":memory:"):
        Path(url.database).parent.mkdir(parents=True, exist_ok=True)
    return create_async_engine(database_url)


# The FTS index columns: content, the concept keywords,
# the specific terms, and the category are separate columns so a
# search can tell which side of a fact a term hit (the match
# provenance the forgetting-border rule and the classified backfill
# run on). ``_FTS_COLUMNS`` is the single source for the definition;
# an existing index whose definition differs is rebuilt from the
# memories table (the source rows are never touched).
_FTS_COLUMNS = ("content", "keywords", "specific_terms", "category")


def _fts_definition_is_current(sql: str | None) -> bool:
    if not sql:
        return False
    normalized = sql.replace(" ", "").lower()
    if "tokenize='trigram'" not in normalized:
        return False
    # The abolished content-history column must be gone, and every
    # current column must be present.
    if "history" in normalized:
        return False
    return all(column in normalized for column in _FTS_COLUMNS)


async def initialize_database(
    engine: AsyncEngine, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    # create_all builds whatever is missing on a fresh file; schema
    # changes to existing databases go through the migration chain
    # (app/database/migrations.py), which runs right after and stamps
    # the schema version.
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    await apply_migrations(engine)
    async with engine.begin() as connection:
        await connection.execute(text("DROP TRIGGER IF EXISTS memories_fts_insert"))
        await connection.execute(text("DROP TRIGGER IF EXISTS memories_fts_delete"))
        await connection.execute(text("DROP TRIGGER IF EXISTS memories_fts_update"))
        fts_sql = await connection.scalar(
            text("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memories_fts'")
        )
        if fts_sql and not _fts_definition_is_current(fts_sql):
            # The definition predates the current columns or still
            # carries the abolished content-history column (past
            # values are ordinary version rows now and are indexed
            # through their own content).
            await connection.execute(text("DROP TABLE memories_fts"))
        column_list = ", ".join(_FTS_COLUMNS)
        await connection.execute(
            text(
                "CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts "
                f"USING fts5({column_list}, tokenize='trigram')"
            )
        )
        await connection.execute(
            text(
                f"""
                CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
                    INSERT INTO memories_fts(rowid, {column_list})
                    VALUES (new.id, new.content, COALESCE(new.keywords, ''),
                            COALESCE(new.specific_terms, ''), new.category);
                END
                """
            )
        )
        await connection.execute(
            text(
                """
                CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
                    DELETE FROM memories_fts WHERE rowid = old.id;
                END
                """
            )
        )
        await connection.execute(
            text(
                f"""
                CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
                    DELETE FROM memories_fts WHERE rowid = old.id;
                    INSERT INTO memories_fts(rowid, {column_list})
                    VALUES (new.id, new.content, COALESCE(new.keywords, ''),
                            COALESCE(new.specific_terms, ''), new.category);
                END
                """
            )
        )
        await connection.execute(text("DELETE FROM memories_fts"))
        await connection.execute(
            text(
                f"""
                INSERT INTO memories_fts(rowid, {column_list})
                SELECT id, content, COALESCE(keywords, ''),
                       COALESCE(specific_terms, ''), category
                FROM memories
                """
            )
        )
    async with session_factory() as session:
        if await session.get(Conversation, 1) is None:
            session.add(Conversation(id=1))
            await session.commit()
        if await session.get(ConversationMeta, 1) is None:
            session.add(ConversationMeta(id=1))
            await session.commit()


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    async with request.app.state.session_factory() as session:
        yield session
