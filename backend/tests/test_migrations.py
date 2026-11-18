import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.database import migrations
from app.database.migrations import apply_migrations
from app.database.models import Base
from app.database.session import create_engine, initialize_database


async def _version(engine) -> int | None:
    async with engine.connect() as connection:
        return await connection.scalar(text("SELECT version FROM schema_version"))


async def _stamp(engine, version: int) -> None:
    async with engine.begin() as connection:
        await connection.execute(
            text("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
        )
        await connection.execute(text("DELETE FROM schema_version"))
        await connection.execute(
            text("INSERT INTO schema_version (version) VALUES (:version)"),
            {"version": version},
        )


async def test_initialize_database_stamps_schema_version(tmp_path) -> None:
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / 'fresh.db'}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)
    assert await _version(engine) == migrations.SCHEMA_VERSION
    await engine.dispose()


async def test_unstamped_database_is_stamped_without_losing_data(tmp_path) -> None:
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / 'legacy.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.execute(
            text("INSERT INTO conversations (id, created_at) VALUES (1, '2026-01-01 00:00:00')")
        )
    assert await apply_migrations(engine) == migrations.SCHEMA_VERSION
    assert await _version(engine) == migrations.SCHEMA_VERSION
    async with engine.connect() as connection:
        assert await connection.scalar(text("SELECT COUNT(*) FROM conversations")) == 1
    await engine.dispose()


async def test_migration_steps_run_in_order_and_stamp_each(tmp_path, monkeypatch) -> None:
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / 'steps.db'}")
    await _stamp(engine, 1)

    async def to_two(connection) -> None:
        await connection.execute(text("CREATE TABLE marker_two (id INTEGER)"))

    async def to_three(connection) -> None:
        await connection.execute(text("CREATE TABLE marker_three (id INTEGER)"))

    monkeypatch.setattr(migrations, "SCHEMA_VERSION", 3)
    monkeypatch.setattr(migrations, "MIGRATIONS", {1: to_two, 2: to_three})
    assert await apply_migrations(engine) == 3
    assert await _version(engine) == 3
    async with engine.connect() as connection:
        names = set(
            await connection.scalars(text("SELECT name FROM sqlite_master WHERE type = 'table'"))
        )
    assert {"marker_two", "marker_three"} <= names
    await engine.dispose()


async def test_missing_step_stops_at_the_last_applied_version(tmp_path, monkeypatch) -> None:
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / 'gap.db'}")
    await _stamp(engine, 1)

    async def to_two(connection) -> None:
        await connection.execute(text("CREATE TABLE marker_two (id INTEGER)"))

    monkeypatch.setattr(migrations, "SCHEMA_VERSION", 3)
    monkeypatch.setattr(migrations, "MIGRATIONS", {1: to_two})
    with pytest.raises(RuntimeError, match="No migration step"):
        await apply_migrations(engine)
    assert await _version(engine) == 2
    await engine.dispose()


async def test_newer_database_is_refused(tmp_path) -> None:
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / 'newer.db'}")
    await _stamp(engine, migrations.SCHEMA_VERSION + 1)
    with pytest.raises(RuntimeError, match="newer than this build"):
        await apply_migrations(engine)
    await engine.dispose()
