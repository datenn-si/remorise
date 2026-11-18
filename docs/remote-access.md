# 他の端末から開く

対象読者：スマートフォンなど、他の端末から Remorise を開きたい人。

既定では、Remorise はこの PC のローカルホスト（127.0.0.1）にだけ待ち受けるため、他の端末からは開けません。

スマートフォンなど他の端末から開く方法は2つあります。

|                    | [待ち受けアドレスを指定する](#待ち受けアドレスを指定する) | [Tailscale Serve で HTTPS 化する](#tailscale-serve-で-https-化する) |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------------------------- |
| 開く URL           | `http://<アドレス>:8000`（本番）／`:5173`（開発）         | `https://<ホスト名>.<tailnet名>.ts.net`                             |
| 通信の暗号化       | なし（平文 HTTP）                                         | あり                                                                |
| 安全なコンテキスト | 扱われない（下記の制約があります）                        | 扱われる（制約はありません）                                        |
| アプリ側の待ち受け | 指定したアドレスに bind します                            | ローカルホストのままです（Serve が中継します）                      |
| 到達できる範囲     | 指定したアドレス次第（LAN や tailnet）                    | tailnet 内のみ                                                      |

どちらの方法でも、このアプリに認証が付くわけではありません。

到達できる端末からは、会話や記憶を含む全機能が使えます。公開範囲は最小にしてください。

## 待ち受けアドレスを指定する

起動時に `--host` で待ち受けアドレスを指定します（環境変数でも指定でき、引数が優先されます）。

- 本番：`python prod.py --host <アドレス>`（環境変数は `REMORISE_PROD_HOST`）。開く URL は `http://<アドレス>:8000` で、待ち受けるポートは 8000 のみです
- 開発：`python dev.py --host <アドレス>`（環境変数は `REMORISE_DEV_HOST`）。フロントエンドは `http://<アドレス>:5173` で開けます

指定するのは、お使いの PC に割り当てられている IP アドレス（または `localhost`）にしてください。

ローカルホスト以外を指定すると、起動時に外部からアクセスが可能になっているという警告が表示されます。

Tailscale を使っている際の推奨はお使いの PC の **Tailscale アドレス**（100.x.x.x）に bind することです。

その場合、到達できるのは tailnet 内の自分の端末だけになり、LAN には公開されません。ファイアウォールの追加設定も通常は要りません。

単に LAN 側 IP アドレスなどを待ち受けにする場合、次項にあるファイアウォールを設定しておくことをおすすめします。

### LAN のアドレスや `0.0.0.0` に bind する場合

Windows ファイアウォールで許可するリモート範囲を絞ってください（管理者として開いた PowerShell で実行します）。
開発構成では 5173 と 8000、本番構成では 8000 のみが対象です。

```powershell
New-NetFirewallRule -DisplayName "Remorise dev frontend" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5173 -RemoteAddress 192.168.0.0/24 -Profile Private
New-NetFirewallRule -DisplayName "Remorise dev backend / prod server" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8000 -RemoteAddress 192.168.0.0/24 -Profile Private
```

`192.168.0.0/24` は自宅 LAN のサブネットに読み替えてください。

特定の端末だけに絞る場合は、その端末のアドレス（例：`192.168.0.50`）を `-RemoteAddress` に指定します。

使い終わったら以下のコマンドで規則を削除することができます。

```powershell
Remove-NetFirewallRule -DisplayName "Remorise dev frontend", "Remorise dev backend / prod server"
```

### 平文 HTTP の制約

平文 HTTP のアドレス（LAN や Tailscale の IP アドレス）で開くと、ブラウザーの仕様で一部機能に制約が出ます。

ブラウザーは、暗号化された HTTPS かローカルホストで開いたページだけを「安全なコンテキスト」として扱い、それ以外のページでは以下のような制約などが発生します。

- PWA としてのインストールができません（Service Worker が登録できないためです）。
- オフラインでは画面を開けません（Service Worker によるキャッシュが効かないためです。サーバーに届いている間の表示は問題ありません）。
- 全画面表示が使えません（Remorise では全画面ボタン自体が表示されません）。
- 通知、クリップボードへのコピー、位置情報、カメラやマイク、画面を眠らせない Wake Lock、Web Share、パスキー（WebAuthn）など、安全なコンテキスト専用のブラウザー API は軒並み使えません。  
  このアプリには現在これらを使う機能はありませんが、今後追加しても平文 HTTP では動作しません。
- 通信が暗号化されないため、経路の途中にある機器からは会話の内容が読める状態で流れます（前述のとおり、このアプリには認証もありません）。

チャット、設定、記憶などの本体機能は平文 HTTP でもそのまま使えます。

画面内でも、平文 HTTP で開いたときは初回にこの制約の案内が表示され、設定画面でも常時確認できます。

制約なく使いたい場合は、この PC のローカルホストで開くか、次節の方法で HTTPS 化してください。

## Tailscale Serve で HTTPS 化する

待ち受けアドレスを変えず、ローカルホストに bind したまま、[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) が HTTPS で tailnet 内へ中継する方法です。

通信が暗号化され、安全なコンテキストとして扱われるため、平文 HTTP の制約はありません。公開範囲は tailnet 内のみで、インターネットには出ません。

具体的な手順は [Tailscale で tailnet 内を HTTPS 化する](tailscale-https.md) を参照してください。
