from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import Settings
from app.database.models import Memory
from app.database.session import create_engine, initialize_database
from app.main import create_app


async def seed(tmp_path: Path, name: str, rows: list[Memory]) -> None:
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / name}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await initialize_database(engine, factory)
    async with factory() as session:
        session.add_all(rows)
        await session.commit()
    await engine.dispose()


def app_for(tmp_path: Path, name: str):
    return create_app(Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / name}"))


@pytest.mark.asyncio
async def test_memory_list_is_id_desc_keyset_with_a_status_filter(tmp_path: Path) -> None:
    base = datetime(2026, 1, 1, tzinfo=UTC)
    await seed(
        tmp_path,
        "list.db",
        [
            Memory(
                content="一",
                category="event",
                status="active",
                is_active=True,
                last_reinforced_at=base + timedelta(days=3),
            ),
            Memory(
                content="忘",
                category="event",
                status="forgotten",
                is_active=False,
                last_reinforced_at=base + timedelta(days=2),
            ),
            Memory(
                content="二",
                category="event",
                status="active",
                is_active=True,
                last_reinforced_at=base,
            ),
            Memory(
                content="三",
                category="event",
                status="active",
                is_active=True,
                last_reinforced_at=base + timedelta(days=1),
            ),
        ],
    )
    app = app_for(tmp_path, "list.db")
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            # The old flag must not pull forgotten rows back in front.
            active = (
                await client.get(
                    "/api/memories",
                    params={"limit": 2, "include_inactive": "true"},
                )
            ).json()
            assert [row["content"] for row in active["memories"]] == ["三", "二"]
            assert active["has_more"] is True

            older = (
                await client.get(
                    "/api/memories",
                    params={"limit": 2, "before_id": active["memories"][-1]["id"]},
                )
            ).json()
            assert [row["content"] for row in older["memories"]] == ["一"]
            assert older["has_more"] is False

            forgotten = (await client.get("/api/memories", params={"status": "forgotten"})).json()
            assert [row["content"] for row in forgotten["memories"]] == ["忘"]
            assert forgotten["has_more"] is False

            everything = (
                await client.get("/api/memories", params={"status": "all", "limit": 2})
            ).json()
            assert [row["content"] for row in everything["memories"]] == ["三", "二"]
            rest = (
                await client.get(
                    "/api/memories",
                    params={
                        "status": "all",
                        "limit": 2,
                        "before_id": everything["memories"][-1]["id"],
                    },
                )
            ).json()
            assert [row["content"] for row in rest["memories"]] == ["忘", "一"]
            rejected = await client.get("/api/memories", params={"status": "pinned"})
            assert rejected.status_code == 422


@pytest.mark.asyncio
async def test_memory_search_passes_the_limit_through_and_skips_lifecycle(
    tmp_path: Path,
) -> None:
    # Identical wording, so the rank tie breaks on reinforcement time.
    # The oldest id is the newest reinforcement: relevance order is the
    # reverse of id order. 56 matches is past the old engine clamp of 50.
    stamp = datetime(2026, 1, 1, tzinfo=UTC)
    rows = [
        Memory(
            content="京都タワー見学",
            category="event",
            importance=1,
            status="active",
            is_active=True,
            last_reinforced_at=stamp + timedelta(minutes=56 - index),
        )
        for index in range(56)
    ]
    rows.append(
        Memory(
            content="京都タワーの昔話",
            category="event",
            importance=5,
            status="forgotten",
            is_active=False,
            reactivation_count=0,
            restoration_count=0,
        )
    )
    await seed(tmp_path, "search.db", rows)
    app = app_for(tmp_path, "search.db")
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            ranked = (
                await client.get(
                    "/api/memories/search",
                    params={"query": "京都タワー", "limit": 100},
                )
            ).json()
            assert len(ranked) == 56
            assert ranked[0]["id"] < ranked[-1]["id"]
            assert all(row["status"] == "active" for row in ranked)
            assert all(row["last_accessed_at"] is None for row in ranked)
            page = (
                await client.get(
                    "/api/memories/search",
                    params={"query": "京都タワー", "limit": 55},
                )
            ).json()
            assert [row["id"] for row in page] == [row["id"] for row in ranked[:55]]

            forgotten = (
                await client.get(
                    "/api/memories/search",
                    params={"query": "京都タワー", "status": "forgotten", "limit": 100},
                )
            ).json()
            assert [row["content"] for row in forgotten] == ["京都タワーの昔話"]
            assert forgotten[0]["status"] == "forgotten"
            assert forgotten[0]["restoration_count"] == 0
            assert forgotten[0]["reactivation_count"] == 0
            assert forgotten[0]["last_accessed_at"] is None

            stored = (await client.get(f"/api/memories/{forgotten[0]['id']}")).json()
            assert stored["status"] == "forgotten"
            assert stored["last_accessed_at"] is None
            assert stored["restoration_count"] == 0

            missing = await client.get("/api/memories/search")
            assert missing.status_code == 422
