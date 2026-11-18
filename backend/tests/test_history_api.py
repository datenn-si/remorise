from pathlib import Path

import httpx
import pytest
from sqlalchemy import select

from app.config import Settings
from app.database.models import Message, Summary, utc_now
from app.main import create_app


async def seed_messages(app, count: int, *, archived_up_to: int = 0) -> list[int]:
    archived_at = utc_now()
    async with app.state.session_factory() as session:
        rows = [
            Message(
                role="user" if index % 2 == 0 else "assistant",
                content=f"message {index + 1}",
                archived_at=archived_at if index < archived_up_to else None,
            )
            for index in range(count)
        ]
        session.add_all(rows)
        await session.commit()
        return [row.id for row in rows]


@pytest.mark.asyncio
async def test_history_returns_latest_page_and_walks_back(tmp_path: Path) -> None:
    app = create_app(Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'page.db'}"))
    async with app.router.lifespan_context(app):
        app.state.job_worker.cancel()
        ids = await seed_messages(app, 7)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            latest = (await client.get("/api/chat/history", params={"limit": 3})).json()
            assert [message["id"] for message in latest["messages"]] == ids[4:]
            assert latest["has_more"] is True
            assert all(message["archived"] is False for message in latest["messages"])

            middle = (
                await client.get(
                    "/api/chat/history",
                    params={"limit": 3, "before_id": ids[4]},
                )
            ).json()
            assert [message["id"] for message in middle["messages"]] == ids[1:4]
            assert middle["has_more"] is True

            first = (
                await client.get(
                    "/api/chat/history",
                    params={"limit": 3, "before_id": ids[1]},
                )
            ).json()
            assert [message["id"] for message in first["messages"]] == ids[:1]
            assert first["has_more"] is False


@pytest.mark.asyncio
async def test_history_excludes_archived_unless_asked(tmp_path: Path) -> None:
    app = create_app(Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'archived-page.db'}"))
    async with app.router.lifespan_context(app):
        app.state.job_worker.cancel()
        ids = await seed_messages(app, 5, archived_up_to=2)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            active = (await client.get("/api/chat/history")).json()
            assert [message["id"] for message in active["messages"]] == ids[2:]
            assert active["has_more"] is False

            everything = (
                await client.get("/api/chat/history", params={"include_archived": True})
            ).json()
            assert [message["id"] for message in everything["messages"]] == ids
            assert [message["archived"] for message in everything["messages"]] == [
                True,
                True,
                False,
                False,
                False,
            ]


@pytest.mark.asyncio
async def test_history_walks_back_through_archived_rows_when_asked(tmp_path: Path) -> None:
    app = create_app(Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'walk.db'}"))
    async with app.router.lifespan_context(app):
        app.state.job_worker.cancel()
        ids = await seed_messages(app, 6)
        async with app.state.session_factory() as session:
            rows = list((await session.scalars(select(Message).order_by(Message.id))).all())
            rows[1].archived_at = utc_now()
            rows[4].archived_at = utc_now()
            await session.commit()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            latest = (
                await client.get("/api/chat/history", params={"limit": 2, "include_archived": True})
            ).json()
            assert [message["id"] for message in latest["messages"]] == ids[4:]
            assert latest["has_more"] is True

            middle = (
                await client.get(
                    "/api/chat/history",
                    params={"limit": 2, "before_id": ids[4], "include_archived": True},
                )
            ).json()
            assert [message["id"] for message in middle["messages"]] == ids[2:4]
            assert middle["has_more"] is True

            first = (
                await client.get(
                    "/api/chat/history",
                    params={"limit": 2, "before_id": ids[2], "include_archived": True},
                )
            ).json()
            assert [message["id"] for message in first["messages"]] == ids[:2]
            assert [message["archived"] for message in first["messages"]] == [False, True]
            assert first["has_more"] is False


@pytest.mark.asyncio
async def test_purge_requires_a_cutoff(tmp_path: Path) -> None:
    app = create_app(Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'cut.db'}"))
    async with app.router.lifespan_context(app):
        app.state.job_worker.cancel()
        await seed_messages(app, 3, archived_up_to=3)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            # The old delete-everything form must stay gone: no cutoff, no purge.
            response = await client.delete("/api/debug/history/purge")
            assert response.status_code == 422
        async with app.state.session_factory() as session:
            remaining = list((await session.scalars(select(Message))).all())
            assert len(remaining) == 3


@pytest.mark.asyncio
async def test_purge_deletes_only_the_archived_prefix(tmp_path: Path) -> None:
    app = create_app(Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'prefix.db'}"))
    async with app.router.lifespan_context(app):
        app.state.job_worker.cancel()
        ids = await seed_messages(app, 6, archived_up_to=4)
        archived_at = utc_now()
        async with app.state.session_factory() as session:
            session.add_all(
                [
                    # Archived, range ends inside the cut: deleted.
                    Summary(
                        content="old",
                        start_message_id=ids[0],
                        end_message_id=ids[1],
                        active=False,
                        archived_at=archived_at,
                    ),
                    # Archived, but its range ends past the cut: kept.
                    Summary(
                        content="spanning",
                        start_message_id=ids[0],
                        end_message_id=ids[4],
                        active=False,
                        archived_at=archived_at,
                    ),
                    # Range ends inside the cut but not archived: kept.
                    Summary(
                        content="current",
                        start_message_id=ids[0],
                        end_message_id=ids[1],
                        active=True,
                    ),
                ]
            )
            await session.commit()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            purge = await client.delete(
                "/api/debug/history/purge", params={"through_message_id": ids[2]}
            )
            assert purge.status_code == 200
            assert purge.json() == {"purged_messages": 3, "purged_summaries": 1}
        async with app.state.session_factory() as session:
            messages = list((await session.scalars(select(Message).order_by(Message.id))).all())
            assert [message.id for message in messages] == ids[3:]
            summaries = list((await session.scalars(select(Summary).order_by(Summary.id))).all())
            assert [summary.content for summary in summaries] == ["spanning", "current"]
