# AltNoti — 別垢の通知に、本垢で気づけるDiscord Bot

複数のDiscordアカウントを本人承認で連携し、サブアカウントへの直接メンション、所属ロールへのメンション、全体メンションをメインアカウントのDMへ知らせます。Botが導入され、サブアカウント自身も参加しているサーバーを自動監視します。Self-Bot、ユーザートークン、メッセージ本文の保存・転送は使いません。

## 利用者向けクイックスタート

1. [Bot招待URL](docs/INVITE.md)から、通知したいサーバーへBotを招待します。
2. 本垢で `/main set` → `/link issue` を実行します。
3. サブ垢で `/link approve`、コード入力、承認ボタンの順に操作します。
4. `/status` で確認します。通常は `/watch on` 不要です。

特定サーバーを止めるときは、そのサーバーで `/watch off`、再開は `/watch on`。個別解除は `/unlink`、保存済みの自分の登録データ全体を消すときは `/account delete` です。詳しくは [身内βガイド](docs/BETA_GUIDE.md) を参照してください。

## 技術構成

- Node.js 24 / TypeScript / discord.js v14
- SQLite（`sql.js` の純WASM実装。ネイティブアドオン不要）
- Vitest
- Docker Compose（Node公式イメージのLinux ARM64マルチアーキテクチャを利用）

SQLiteはサービス起動時にファイルを読み込み、変更のたびに同一ディレクトリ内の一時ファイルから原子的に保存します。単一BotプロセスのMVP向けで、将来は `src/db.ts` のアダプタをD1等へ差し替えられます。

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
| `FREE_LINK_LIMIT` | 任意 | Freeプランのサブアカウント連携上限。β版の既定値は`1` |
| `MAX_PENDING_PER_MAIN` | 任意 | メインアカウントごとの未送信キュー上限。既定値は`200` |
| `DM_MIN_INTERVAL_MS` | 任意 | 同一メインアカウントへのDM最小間隔。既定値は`1000`ミリ秒 |
| `HEALTHCHECKS_HEARTBEAT_URL` | 任意 | HealthchecksのHTTPS heartbeat URL。未設定時は外部送信なし |
| `HEALTHCHECKS_HEARTBEAT_INTERVAL_MS` | 任意 | heartbeat間隔。既定値は`60000`ミリ秒 |
| `HEALTHCHECKS_MAX_PENDING_QUEUE` | 任意 | heartbeatをfailにするpending/processing件数。既定値は`200` |
| `HEALTHCHECKS_MAX_FAILURES_15M` | 任意 | 直近15分でheartbeatをfailにする失敗件数。既定値は`5` |
| `LOG_LEVEL` | 任意 | `debug` / `info` / `warn` / `error` |
| `DEVELOPER_TEST_DISCORD_ID` | 任意 | 5アカウント枠を持つ開発者テストID |
| `LINK_CODE_PEPPER` | 任意 | 連携コードハッシュ用の秘密値。設定後は保持 |

## 利用方法

1. 通知先のメインアカウントで`/main set`を実行します。BotのテストDMに成功した場合だけ登録されます。
2. メインアカウントで`/link issue`を実行し、表示されたコードをサブアカウント本人へ安全に渡します。コードは10分・1回限りで、DBにはハッシュだけ保存します。
3. サブアカウントで`/link approve code:<コード>`を実行し、表示された承認ボタンを本人が押します。
4. 連携承認後は、Botが導入されサブアカウント自身も参加しているサーバーを自動監視します。通常は`/watch on`不要です。
5. 特定サーバーで停止する場合は`/watch off`、再開する場合は`/watch on`、状態確認は`/watch status`です。明示的なOFFは再起動後も維持されます。
6. 対象サーバーで、サブアカウントへの直接メンション、所属ロールへのメンション、または全体メンションが発生すると、メインアカウントへ本文なしのDMが送られます。サブアカウントがそのサーバーのメンバーでない場合は送信しません。
7. `/status`で連携・監視設定を確認し、メイン側は`/unlink account:<サブアカウント>`、サブ側は`/unlink`で解除します。

DMでSlash Commandを使えない場合は、Botとユーザーが共通で参加しているサーバー内で同じコマンドを実行してください。返信はephemeralです。

## 通知と安全性

- 直接メンションは高優先度の即時キュー、ロールメンションは通常優先度の即時キュー、全体メンションは同一メインアカウント宛てに60秒遅延キューへ入ります。
- 同じ`messageId + mainAccountId`は1回だけキュー化します。
- 同一メッセージで複数サブアカウントが対象なら1通にまとめます。
- Bot自身の投稿、DM、明示的な監視OFF、サーバー脱退、対象ユーザーがメンバーでない場合、チャンネル閲覧権限を確認できない場合は転送しません。
- 監視設定が未作成のサーバーは自動監視ONとして扱い、`enabled=0`の行だけを明示的OFFとして扱います。メンバー確認は個別取得と短時間キャッシュを使い、全メンバー一括取得は行いません。
- DM送信は最大3回（429と一時的な5xxを指数バックオフ）で、失敗はDBに記録して無限再試行しません。
- キュー取得は条件付き更新で1件だけを所有し、送信直前に連携・監視OFF・サーバー所属・チャンネル閲覧権限を再確認します。
- `allowedMentions: { parse: [] }`を指定し、通知先や第三者を再メンションしません。
- 本文、添付は扱いません。ロールメンションはDiscordメッセージオブジェクトのRole IDとサブアカウントの所属Role IDを照合します。Discord本体のロール通知設定やミュートは再現せず、所属事実だけで判定します。`@everyone`と`@here`は、本文を読まずGatewayの全体メンションフラグを「全体メンション」として扱います。

## Docker / Oracle Cloud

Dockerが使える環境で次を実行します。

```bash
npm ci
npm run build
docker compose up -d --build
docker compose logs -f
```

`.env`はサーバー上で作成し、イメージへコピーしません。SQLiteはComposeボリュームに保存され、コンテナ停止時はSIGTERMを受けてGatewayを切断し、DBを書き出してから終了します。Oracle Cloudの本番運用手順は `docs/OPERATIONS.md` を参照してください。

## バックアップ・復元

Bot停止後にSQLiteファイルをコピーしてください。

```bash
docker compose stop
docker cp "$(docker compose ps -q discord-alt-notify):/app/data/discord-alt-notify.sqlite" ./discord-alt-notify.sqlite.backup
docker compose start
```

復元時は停止後に同じファイルをデータボリュームへ戻し、`docker compose up -d`します。変更直後のプロセスクラッシュでは、DM送信直後にDB状態を書き込めない短い窓があるため、完全なexactly-once送信は保証しません。未送信キューは再起動時に復旧します。

## 本番の秘密情報更新・外部監視

Bot Tokenはチャットへ貼り付けず、Windows PowerShellで`deploy/rotate-token.ps1`を実行して非表示入力します。Healthchecksの秘密URLは`deploy/configure-healthcheck.ps1`へ非表示入力します。両スクリプトともSSHの標準入力でOracleへ渡し、環境ファイルを原子的に更新してGateway readyを確認します。入力値はログ、Git、画面出力へ出しません。

## MVPの制限と今後

- β版の通常Freeユーザーはサブアカウント1個まで無料で連携できます。開発者・テスト用権限とPro枠は従来どおり5個です。Proの決済は未実装です。
- OAuth2、Web管理画面、課金、過去メッセージ取得は未実装です。
- Gateway切断中のイベントを完全回収できない場合があります。
- 公開前の監査結果、バックアップ、障害対応は `docs/SECURITY_AUDIT.md`、`docs/OPERATIONS.md`、`docs/INCIDENT_RESPONSE.md` に記録しています。
