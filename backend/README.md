# Remorise バックエンド

Remorise は、永続化されるチャット、長期記憶、キャラクターの状態を持ち、OpenAI 互換 API 経由で SSE ストリーミングを行う、ローカル LLM 向けキャラクター会話バックエンドです。

## 必要環境

- Python 3.11+
- [uv](https://docs.astral.sh/uv/)
- OpenAI 互換 API を提供する LLM API（動作を検証しているのは llama.cpp のみです）

## 開発サーバー

```powershell
uv sync
Copy-Item .env.example .env
uv run uvicorn app.main:app --reload
```

## プロダクションサーバー

本番では、バックエンドはビルド済みフロントエンドも配信します。

リポジトリのルートから `python prod.py` を実行すると、`../frontend/dist` が存在する場合はそのファイルが同一オリジンで配信され、この単一プロセス・リロードなしの構成がポート 8000 で起動します。

API でない未知のパスはクライアント側ルーティングのために `index.html` へフォールバックします。

ビルドが無い場合は API のみで動作し、起動時に警告をログへ出します。

## 開発/プロダクションサーバー共通

### .env による設定

モデルの接続先、モデル名、API キー、`REMORISE_DATA_DIR` は `.env` で変更します。接続先（`LLM_BASE_URL`）、API キー、モデル名に既定はなく、`.env` での指定が必須です。

### DB への設定保存

挙動の設定（サンプリング、要約のしきい値、忘却など）は、後からアプリの設定画面でも変更できます。

それらの値はデータベースに保存され、`.env` より優先されます（[`docs/api.md`](docs/api.md) の「設定」を参照）。

### ユーザーデータフォルダ

データディレクトリの既定値はドキュメントフォルダ内の `Remorise` フォルダで、ユーザーのキャラクターが `characters/<id>/` に入り、各キャラクターのデータベースはそのフォルダ内の `remorise.db` です。

### キャラクターの選択

動かすキャラクターは `REMORISE_CHARACTER_ID`（または起動引数 `--character`）で選び、既定は `remora` で、同梱のフォールバックは `../characters/remora/` です。

### LLM サーバーの起動

ローカル LLM を利用する場合は、チャットリクエストを送る前に接続先の LLM サーバーを別途起動してください。

### API ドキュメント

API ドキュメントは `http://127.0.0.1:8000/docs` で利用でき、エンドポイントの詳細は [`docs/api.md`](docs/api.md) にあります。

### デバッグ

記憶検索の内容やトークン数は、ターミナルには出力されません。
記憶検索の詳細は、フロントエンドのデバッグ表示とデバッグ API で確認できます（[`docs/api.md`](docs/api.md) の「デバッグ」を参照）。

トークン数は接続先の `/tokenize` エンドポイントで数え、使えない場合は文字数による概算に切り替わります。
その場合は、切り替えた旨が WARNING レベルでログに出力されます。

## データとスキーマ

フロントエンドは `../frontend` にあります。

キャラクターの設定とアセットは、選択されたキャラクター ID の `REMORISE_DATA_DIR/characters/<id>/` から読み、無ければ `../characters/remora/` にフォールバックします。

SQLite にはチャットメッセージ、要約、記憶、キャラクターの状態、状態履歴が保存されます。
スキーマは起動時に現在のモデル定義から作成され（`create_all`）、その後マイグレーションが走ります（スキーマ版数は `schema_version` テーブルで管理され、`v0.1.0` 時点での版数は `1` です）。

生ログは保持日数（既定 30 日）を過ぎると削除されます。

ジョブに属する行は、そのジョブが完了するまでは保持されます。

設定の全項目は [`../docs/settings.md`](../docs/settings.md)、記憶処理の流れは [`../docs/memory-flow.md`](../docs/memory-flow.md) を参照してください。

## 確認

チェックは次のコマンドで実行します。

```powershell
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

起動中の LLM サーバーに対する統合テストは、OpenAI 互換エンドポイントを設定して専用モジュールを実行します。

```powershell
$env:REMORISE_LLAMA_BASE_URL = "http://127.0.0.1:9931/v1"
uv run pytest tests/test_llama_integration.py -v
```

`REMORISE_LLAMA_BASE_URL` が未設定の場合、統合モジュールはスキップされます。
