# Discord複数アカウント通知集約Bot MVP

Discord公式Bot APIだけを使い、連携したサブアカウントへのメンションをメインアカウントのDMへ通知するMVPです。Self-Bot、ユーザートークン、OAuth2、メッセージ本文の保存・転送は使いません。

## 技術構成

- Node.js 24 / TypeScript / discord.js v14
- SQLite（`sql.js` の純WASM実装。ネイティブアドオン不要）
- Vitest
- Docker Compose（Node公式イメージのLinux ARM64マルチアーキテクチャを利用）

SQLiteはサービス起動時にファイルを読み込み、変更のたびに同じファイルへ保存します。単一BotプロセスのMVP向けで、将来は `src/db.ts` のアダプタをD1等へ差し替えられます。

## ローカル起動

```powershell
npm install
Copy-Item .env.example .env
# .env にBotトークン等を設定
npm run deploy:commands
npm run dev
```

本番相当の起動は次のとおりです。

```powershell
npm run build
npm start
```

`npm run check` はTypeScript型チェック、`npm test` はDiscord接続なしのテストです。

## Discord Developer Portal設定

1. Developer PortalでApplicationを作成し、Botを追加します。
2. Bot Tokenを発行して`.env`の`DISCORD_TOKEN`へ設定します。トークンはGitへコミットしません。
3. Gateway Intentsは `Guilds`、`Guild Messages`、`Direct Messages` 相当だけを使います。`Message Content`、`Guild Members`、`Guild Presences` は有効化不要です。
4. OAuth2 URL GeneratorでScopesに `bot` と `applications.commands` を指定します。
5. Bot権限は、監視対象チャンネルで `View Channel` と `Read Message History`、コマンド利用に `Use Application Commands` を付与します。管理対象サーバーだけへ招待してください。
6. `DISCORD_CLIENT_ID`へApplication ID、開発時は`DISCORD_DEV_GUILD_ID`へテストサーバーIDを設定します。開発サーバー指定時は即時反映されます。未指定ならグローバル登録です。

## 環境変数

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `DISCORD_TOKEN` | 必須 | Botトークン |
| `DISCORD_CLIENT_ID` | 必須 | Application ID |
| `DISCORD_DEV_GUILD_ID` | 任意 | 開発用サーバーID |
| `OWNER_DISCORD_ID` | 任意 | `/admin-stats`を使える管理者ID |
| `DATABASE_PATH` | 任意 | SQLiteファイル。既定は`./data/discord-alt-notify.sqlite` |
| `LOG_LEVEL` | 任意 | `debug` / `info` / `warn` / `error` |
| `DEVELOPER_TEST_DISCORD_ID` | 任意 | 5アカウント枠を持つ開発者テストID |
| `LINK_CODE_PEPPER` | 任意 | 連携コードハッシュ用の秘密値。設定後は保持 |

## 利用方法

1. 通知先のメインアカウントで`/main set`を実行します。BotのテストDMに成功した場合だけ登録されます。
2. メインアカウントで`/link issue`を実行し、表示されたコードをサブアカウント本人へ安全に渡します。コードは10分・1回限りで、DBにはハッシュだけ保存します。
3. サブアカウントで`/link approve code:<コード>`を実行し、表示された承認ボタンを本人が押します。
4. 連携承認後は、Botが導入されサブアカウント自身も参加しているサーバーを自動監視します。通常は`/watch on`不要です。
5. 特定サーバーで停止する場合は`/watch off`、再開する場合は`/watch on`、状態確認は`/watch status`です。明示的なOFFは再起動後も維持されます。
6. 対象サーバーで、サブアカウントへの直接メンションまたは全体メンションが発生すると、メインアカウントへ本文なしのDMが送られます。サブアカウントがそのサーバーのメンバーでない場合は送信しません。
7. `/status`で連携・監視設定を確認し、メイン側は`/unlink account:<サブアカウント>`、サブ側は`/unlink`で解除します。

DMでSlash Commandを使えない場合は、Botとユーザーが共通で参加しているサーバー内で同じコマンドを実行してください。返信はephemeralです。

## 通知と安全性

- 直接メンションは即時キュー、全体メンションは同一メインアカウント宛てに60秒遅延キューへ入ります。
- 同じ`messageId + mainAccountId`は1回だけキュー化します。
- 同一メッセージで複数サブアカウントが対象なら1通にまとめます。
- Bot自身の投稿、DM、明示的な監視OFF、サーバー脱退、対象ユーザーがメンバーでない場合、チャンネル閲覧権限を確認できない場合は転送しません。
- 監視設定が未作成のサーバーは自動監視ONとして扱い、`enabled=0`の行だけを明示的OFFとして扱います。メンバー確認は個別取得と短時間キャッシュを使い、全メンバー一括取得は行いません。
- DM送信は最大3回（Discordの`retryAfter`がある429相当だけ待機）で、失敗はDBに記録して無限再試行しません。
- `allowedMentions: { parse: [] }`を指定し、通知先や第三者を再メンションしません。
- 本文、添付、ロールメンションは扱いません。`@everyone`と`@here`は、本文を読まずGatewayの全体メンションフラグを「全体メンション」として扱います。

## Docker / Oracle Cloud Ampere A1

Dockerが使える環境で次を実行します。

```bash
npm ci
npm run build
docker compose up -d --build
docker compose logs -f
```

`.env`はサーバー上で作成し、イメージへコピーしません。SQLiteはComposeボリュームに保存され、コンテナ停止時はSIGTERMを受けてGatewayを切断し、DBを書き出してから終了します。本リポジトリではSSH接続情報が提供されていないため、Oracleへの実デプロイは行っていません。

## バックアップ・復元

Bot停止後にSQLiteファイルをコピーしてください。

```bash
docker compose stop
docker cp "$(docker compose ps -q discord-alt-notify):/app/data/discord-alt-notify.sqlite" ./discord-alt-notify.sqlite.backup
docker compose start
```

復元時は停止後に同じファイルをデータボリュームへ戻し、`docker compose up -d`します。変更直後のプロセスクラッシュでは、DM送信直後にDB状態を書き込めない短い窓があるため、完全なexactly-once送信は保証しません。未送信キューは再起動時に復旧します。

## MVPの制限と今後

- Freeはサブアカウント1個、開発者テストIDだけ5個です。Proの決済は未実装です。
- ロールメンション、OAuth2、Web管理画面、課金、過去メッセージ取得は未実装です。
- Gateway切断中のイベントを完全回収できない場合があります。
- 本番公開前に、監査ログの運用、DBバックアップの自動化、送信状態の監視、正式な課金・プラン変更処理、スケール時のDB移行を追加してください。
