from pathlib import Path

import httpx

from app.config import Settings
from app.main import create_app

INDEX = "<!doctype html><html><body>remorise spa</body></html>"


def make_dist(tmp_path: Path) -> Path:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(INDEX, encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log('app')", encoding="utf-8")
    return dist


def make_app(tmp_path: Path, dist: Path):
    return create_app(
        Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'prod.db'}"),
        frontend_dist=dist,
    )


async def get(app, path: str) -> httpx.Response:
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            return await client.get(path)


async def test_root_serves_the_spa_index(tmp_path) -> None:
    app = make_app(tmp_path, make_dist(tmp_path))
    response = await get(app, "/")
    assert response.status_code == 200
    assert response.text == INDEX
    assert response.headers["cache-control"] == "no-cache"
    assert app.state.frontend_dist is not None


async def test_unknown_frontend_path_falls_back_to_index(tmp_path) -> None:
    app = make_app(tmp_path, make_dist(tmp_path))
    response = await get(app, "/pipeline")
    assert response.status_code == 200
    assert response.text == INDEX


async def test_build_assets_are_served_as_files(tmp_path) -> None:
    app = make_app(tmp_path, make_dist(tmp_path))
    response = await get(app, "/assets/app.js")
    assert response.status_code == 200
    assert response.text == "console.log('app')"
    assert "javascript" in response.headers["content-type"]
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"


async def test_api_routes_win_over_the_catch_all(tmp_path) -> None:
    app = make_app(tmp_path, make_dist(tmp_path))
    response = await get(app, "/api/settings")
    assert response.status_code == 200
    assert "llm_max_tokens" in response.json()


async def test_unknown_api_path_stays_a_json_404(tmp_path) -> None:
    app = make_app(tmp_path, make_dist(tmp_path))
    response = await get(app, "/api/does-not-exist")
    assert response.status_code == 404
    assert response.text != INDEX


async def test_health_wins_over_the_catch_all(tmp_path) -> None:
    app = make_app(tmp_path, make_dist(tmp_path))
    response = await get(app, "/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_paths_cannot_escape_the_dist_directory(tmp_path) -> None:
    dist = make_dist(tmp_path)
    (tmp_path / "secret.txt").write_text("secret", encoding="utf-8")
    app = make_app(tmp_path, dist)
    response = await get(app, "/..%2fsecret.txt")
    assert response.status_code == 200
    assert response.text == INDEX


async def test_missing_dist_runs_api_only(tmp_path) -> None:
    app = make_app(tmp_path, tmp_path / "no-such-dist")
    assert app.state.frontend_dist is None
    response = await get(app, "/")
    assert response.status_code == 404
    health = await get(app, "/health")
    assert health.status_code == 200


async def test_dist_without_index_runs_api_only(tmp_path) -> None:
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "app.js").write_text("console.log('app')", encoding="utf-8")
    app = make_app(tmp_path, dist)
    assert app.state.frontend_dist is None
    response = await get(app, "/app.js")
    assert response.status_code == 404
