# Remorise フロントエンド

Remorise の画面です。`../backend` の FastAPI と話し、会話・立ち絵・長期記憶を扱います。キャラクター設定と立ち絵資産はバックエンド API から実行時に取得します。

## 必要環境

- Node.js 22+
- pnpm 12
- 起動済みの Remorise API（既定 `http://127.0.0.1:8000`）

## 開発

```powershell
Copy-Item .env.example .env
pnpm install
pnpm dev
```

API への接続先は、画面と同じオリジンです。開発時は Vite が `/api` と `/health` をバックエンド（この PC の `127.0.0.1:8000`、dev.py の `--host` 指定時はそのアドレス）へプロキシするので、別端末から開いた場合も API がそのまま届きます。

立ち絵のレイヤー設定と画像はバックエンドの `/api/character/layers` と `/api/character/assets/` から取得します。Vite の静的配信資産にはユーザーキャラクターを含めません。

アイコンの `icon-[mdi--*]` クラスは、`../iconify-dynamic-plugin.mjs` が生成します。これは公式の `@iconify/tailwind4` の dynamic 部分だけを使う薄いラッパーです。パッケージ本体のプラグイン（`lib/plugin.js`）は、使わない機能（@iconify/tools や SVGO）の読み込みで CSS のビルドが遅くなるため、経由しません。生成される CSS は本体プラグインと同じです。

## 確認

```powershell
pnpm test
pnpm lint
pnpm fmt:check
pnpm typecheck
pnpm build
```

ブラウザ側の表示設定は [../docs/settings.md](../docs/settings.md) の「表示設定（ブラウザ側）」を参照してください。
