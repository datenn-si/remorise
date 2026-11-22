# Remorise に貢献する

Remorise へのコントリビューションを歓迎します。

この文書は、開発環境の構築と、変更を提案する際の手順をまとめたものです。

## 構成

- `backend/`：FastAPI によるバックエンド
- `frontend/`：React + TypeScript + Vite によるフロントエンド
- `characters/remora/`：同梱の公式キャラクター（フォールバック用）

## 開発環境

### 必要環境

ソフトウェア面での必要環境です。

- Node.js 22+
- pnpm 12
- Python 3.11+
- [uv](https://docs.astral.sh/uv/)
- OpenAI 互換 API を持つ LLM サーバー

### リポジトリのクローンと依存関係のセットアップ

まず、リポジトリをクローンします。

```bash
git clone https://github.com/datenn-si/remorise.git
cd remorise
```

リポジトリ直下のセットアップスクリプト（Windows は `setup.bat`、macOS / Linux は `setup.sh`）を実行すると、前提ツールの確認と、以下の依存関係の準備を一括で行えます。

手作業で進める場合は、バックエンドとフロントエンドそれぞれで次の準備をしてください。

### バックエンド

- Python と [uv](https://docs.astral.sh/uv/) を使用します。
- 依存関係のインストールとテストは `backend/` で行います。
- lint とフォーマットには Ruff を使用します。
- 初回は `.env.example` を `.env` にコピーしてください。

```bash
cd backend
uv sync
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

フォーマットを適用する場合は `uv run ruff format .` を実行してください。

バックエンドの操作詳細は [backend/README.md](backend/README.md) を参照してください。

### フロントエンド

- Node.js と pnpm を使用します。
- lint は oxlint、フォーマットは oxfmt を使用します。
- 初回は `.env.example` を `.env` にコピーしてください。

```bash
cd frontend
pnpm install
pnpm test
pnpm lint
pnpm fmt:check
pnpm typecheck
```

フォーマットを適用する場合は `pnpm fmt`、lint の自動修正は `pnpm lint:fix` を実行してください。`pnpm fmt` はコードとあわせて、リポジトリの Markdown ドキュメントも整形します。

フロントエンドの操作詳細は [frontend/README.md](frontend/README.md) を参照してください。

### 推論バックエンド

- 会話の生成には、OpenAI 互換 API を持つ LLM サーバーの別プロセスが必要です（検証は llama.cpp で行っています）。
  接続先、API キー、モデルは `.env` での指定が必須です（`backend/.env.example` に例があります）。
- 推論なしでも、バックエンドとフロントエンドのテストは実行できます。

## 起動

### 開発サーバー

リポジトリのルートから、バックエンドとフロントエンドを同時に起動します。

```powershell
python dev.py
```

ログには `[backend]` と `[frontend]` のラベルが付いて、このターミナルにまとめて表示されます。

バックエンドは `uv sync` 済みの仮想環境 Python（無ければ `uv run`）で `uvicorn --reload` を起動します。

フロントエンドは、Windows では `node` から `frontend/node_modules/vite/bin/vite.js` を直接起動し、それ以外では `pnpm dev` を起動します。Windows だけ処理を分けているのは、Windows で pnpm のコマンドシムを経由すると、別のコンソール窓（黒窓）が開くためです。

どちらか一方が終了しても、もう一方は動き続けます。両方を止めるときは `Ctrl+C` を押してください。

接続先の LLM サーバーは別途起動してください。

他の端末から開発 UI を開く場合は、`python dev.py --host <この PC のアドレス>`（または環境変数 `REMORISE_DEV_HOST`）で待ち受けアドレスを指定します。方法の違いと注意点は [他の端末から開く](docs/remote-access.md) を参照してください。

### 本番構成

ビルド済みのフロントエンドをバックエンドが配信する単一プロセス構成も、開発中に確認できます。

```powershell
cd frontend
pnpm build
cd ..
python prod.py
```

`http://127.0.0.1:8000` で画面と API の両方が同じオリジンで開けます。

ビルドは `python prod.py --build` でも実行できます（起動前にフロントエンドのビルドを回します）。

Windows では、`pnpm` を経由せず、`node` から `frontend/node_modules/typescript/bin/tsc` の `-b` と `frontend/node_modules/vite/bin/vite.js` の `build` を順に実行します。それ以外は `pnpm build` です。こちらも Windows だけ処理を分けているのは、Windows で pnpm のコマンドシムを経由すると、別のコンソール窓（黒窓）が開くためです。

リロードは効かないので、コードを変えたら再起動してください。

環境変数は開発と共通で、`backend/.env` を読みます（本番専用の env ファイルはありません）。

待ち受けアドレスは `--host`（または環境変数 `REMORISE_PROD_HOST`）で変更できます。

## ユーザーデータの置き場所

- 会話 DB、利用者のキャラクター設定、立ち絵画像などのユーザーデータは、リポジトリの外のデータディレクトリに置かれます。
- データディレクトリは環境変数 `REMORISE_DATA_DIR` で指定でき、未指定の場合はドキュメントフォルダの `Remorise` フォルダが使われます。
- リポジトリ内にユーザーデータをコミットしないでください。
  キャラクターの動作確認には `characters/remora/` の公式キャラクターがそのまま使えます。

## 窓口の使い分け

- 質問、相談、新機能の提案は [Discussions](https://github.com/datenn-si/remorise/discussions) へお願いします。
- 脆弱性の報告は公開の Issue には書かず、[SECURITY.md](SECURITY.md) の手順で報告してください。
- Issue は、再現手順のあるバグ報告だけを受け付けます。
- バグ修正や新機能のコードは、Pull Request で送ってください。

既存の Issue に取り組む場合は、作業の重複を避けるため、着手前にコメントで一言お知らせください。

大きな変更は、実装前に Discussions か Issue で相談してもらえると助かります。

## 変更の提案

変更は `main` から切ったブランチで作業してください。
ブランチ名は、機能の追加や変更は `feature/<名前>`、バグ修正は `fix/<名前>` とします。

Pull Request は、基本として1つにつき1つの変更に絞ってください。
マージはスカッシュマージで行います。
スカッシュコミットのメッセージは、Pull Request のタイトルを件名にして、変更の内容が分かるように書いてください。

手順は次のとおりです。

1. 変更内容を Discussions か Issue で相談するか、小さい変更であれば直接 Pull Request を送ってください。
2. バックエンドを変更した場合は `uv run pytest` と Ruff のチェック（`uv run ruff check .`、`uv run ruff format --check .`）、フロントエンドを変更した場合は `pnpm test`、`pnpm lint`、`pnpm fmt:check`、`pnpm typecheck` を実行し、すべて通ることを確認してください。
3. API や SSE の契約を変更する場合は、`backend/docs/api.md` と、相手側（フロントエンドの型・パーサ、またはバックエンドのルートとテスト）を同じ変更の中で更新してください。
4. 感情・好感度・記憶などの永続化される状態はバックエンドが正です。
   フロントエンドで状態を独自に決定する変更は行わないでください。

## コーディング時の注意

- ドキュメントと既存コードで食い違いを見つけた場合は、Pull Request の説明で指摘してください。

なお、AI コーディングエージェント向けの実装規約は、リポジトリ直下の [`AGENTS.md`](AGENTS.md) にまとめてあります。

## AI の利用について

AI を使って書いたコードも受け入れます。
ただし、次の2点を満たす場合に限ります。

- 使っている言語について最低限の知識があり、AI の出力を自分で確認できること
- AI に対して明確な指示を与えられること

Issue や Pull Request の文章を AI で生成することも可能ですが、必ず人間が内容を精査し、投稿者が責任を持ってください。

## アセットの追加

画像などのコードでないアセットを追加する場合は、コードとは別の次の条件に同意したうえで投稿してください。

- 追加したアセットの著作権は、制作者であるあなたに帰属します。プロジェクトへの譲渡は求めません
- その代わり、Remorise の一部としてそのアセットを使用、複製、改変（サイズ変更、切り抜き、形式変換、レイヤーの調整など）、再配布することを、無償、無期限、かつ取り消しできない形でプロジェクトに許諾してください
- 一度取り込まれたアセットを、制作者側の都合だけで削除させることはできません
- 著作者人格権は行使しないでください
- アセットは、あなた自身の権利物か、使用する権利を持っているものに限ります。AI 生成物を含む場合は、その旨を明記してください

取り込まれたアセットは、[`CREDIT.md`](CREDIT.md) に制作者として記録されます。

## 更新の方針

配布は、リポジトリの clone、または zip のダウンロードで行います。
フロントエンドのビルド済み成果物や、Python 本体の同梱は行いません。

キャラクターの人格に影響を及ぼす更新については、選択制の仕組みを含め、実際にそうした更新を作者かコントリビューターが行うことになった際に検討します。

## ライセンス

ソースコードは [AGPL-3.0 only](LICENSE) です。
コントリビューション（ソースコード）は、同じライセンスのもとで提供されるものとします。

ただし、コードでないアセットは AGPL-3.0 only の対象外であり、著作権はそのアセットの制作者に帰属します。
対象のアセットと取り扱いの詳細は、[`CREDIT.md`](CREDIT.md) を参照してください。
