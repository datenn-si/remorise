#!/bin/sh
set -eu
cd "$(dirname "$0")"

missing=0
command -v uv >/dev/null 2>&1 || { echo "[setup] uv が見つかりません。https://docs.astral.sh/uv/ からインストールしてください。"; missing=1; }
command -v node >/dev/null 2>&1 || { echo "[setup] Node.js が見つかりません。https://nodejs.org/ からインストールしてください。"; missing=1; }
command -v pnpm >/dev/null 2>&1 || { echo "[setup] pnpm が見つかりません。https://pnpm.io/ からインストールしてください。"; missing=1; }
if [ "$missing" -ne 0 ]; then
  exit 1
fi

echo "[setup] バックエンドの依存関係をインストールします。"
(cd backend && uv sync)
if [ ! -f backend/.env ]; then
  cp backend/.env.example backend/.env
fi

echo "[setup] フロントエンドの依存関係をインストールします。"
(cd frontend && pnpm install)
if [ ! -f frontend/.env ]; then
  cp frontend/.env.example frontend/.env
fi

echo "[setup] セットアップが完了しました。"
echo "[setup] llama.cpp の OpenAI 互換サーバーを別途起動してから、開発は python dev.py、本番は python prod.py --build で起動します。"
