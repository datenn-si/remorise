# Tailscale で tailnet 内を HTTPS 化する

対象読者：tailnet 内で Remorise を HTTPS 化したい人。  
前提：Tailscale を導入済みであること。

## 目的

tailnet 内のサービス（Remorise など）を HTTPS で公開し、ブラウザのセキュアコンテキストで動く API（全画面表示、crypto.randomUUID など）を使えるようにします。

公開範囲は tailnet 内のみで、インターネットには出しません。

## 前提

- MagicDNS が有効である必要があります。
- tailnet 名は自動生成のままを推奨します。覚えやすいからと言ってハンドルネーム等に変更することは推奨されません。（理由は注意点参照）。

## 手順

1. Tailscale の管理コンソールで、DNS の設定から HTTPS 証明書を有効化します。
2. Remorise を localhost で待ち受けます。`python prod.py` や `python dev.py` を `--host` 引数なしで起動すればよいです。
3. そのマシンで `tailscale serve --bg <ポート番号>` を実行します。  
   コマンド書式はバージョンで変わるため、実行前に `tailscale serve --help` で確認してください。また、ポート番号は下記の表を参照してください。
4. `https://<ホスト名>.<tailnet名>.ts.net` でアクセスします。

> [!IMPORTANT]
> ACL（Access Control List）と呼ばれるアクセス制御を設定している際は、Remorise をホストしている端末の該当するポート（デフォルトでは https の 443 番ポート）へのアクセス元端末からのアクセスを許可しておく必要があります。

### `tailscale serve --bg <ポート番号>` に指定するポート番号

| 起動スクリプト | 既定ポート |
| -------------- | ---------- |
| `dev.py`       | 5173       |
| `prod.py`      | 8000       |

## 状態確認と解除

- 状態確認：`tailscale serve status`
- 解除：`tailscale serve reset`、または対象ポートを off にします。

## 注意点

- 証明書を発行すると、ホスト名と tailnet 名の組が証明書の透明性ログ（CT ログ）に公開記録として残り、CT ログを検索できる公開サービスなどで誰でもそれを検索できます。
- そのため tailnet 名は自動生成のランダムなままにし、ホスト名も本名やハンドルに結びつかない普遍的な単語にしておくことを推奨します。
- HTTPS 化してもアプリ側に認証が付くわけではありません。tailnet に入っている端末からは無認証で使える状態は変わらないため、念のため到達範囲は ACL の Grants で制限しておくとよいです。
- Serve を使う場合、アプリは tailnet の IP に直接バインドせず localhost 待受にする方が安全です。Serve が localhost から中継して Remorise をホストします。

> [!CAUTION]
> Funnel という tailnet の外（インターネット）へ公開する機能を利用して全世界へ**公開しないでください!!!** Remorise には認証機能がないため、セキュリティ上のリスクが発生します。
