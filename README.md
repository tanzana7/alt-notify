# Alt Notify

別垢の通知も、いつもの垢へ。

Alt Notifyは、複数のDiscordアカウントを使う人向けの公開β版通知集約Botです。連携したサブアカウントへのメンションを、普段使うメインアカウントへDMで知らせます。

## 対応通知

- 直接メンション
- サブアカウントが所属するロールへのメンション
- `@everyone` / `@here`

同じ投稿で複数のサブアカウントが対象になった場合は、メインアカウントへのDM 1通にまとめます。優先順位は、直接メンション > ロールメンション > 全体メンションです。

## 対応しないもの

- 通常メッセージの監視
- キーワード監視
- DM監視
- メッセージ本文の転送・保存
- 添付ファイルの転送・保存

本文解析やMessage Content Intentは使用せず、Discordのメンション情報を利用します。ロールメンションはDiscord本体のミュート・通知抑制設定とは独立して判定します。

## Free Beta

公開βでは、通常のFreeユーザーはサブアカウント1個まで無料で連携できます。メインアカウント自身は上限に含みません。開発者・テスト枠は5個までです。Proの課金機能は未提供です。

## 基本的な使い方

1. [Bot招待URL](docs/INVITE.md)から、通知したいサーバーへBotを追加します。
2. メインアカウントで `/main set` を実行します。
3. メインアカウントで `/link issue` を実行します。
4. サブアカウントで `/link approve code:<コード>` を実行し、本人承認します。
5. 以後、Botが導入されサブアカウント自身も参加しているサーバーを自動監視します。

通常は `/watch on` 不要です。特定サーバーで停止する場合は `/watch off`、再開は `/watch on`、状態確認は `/watch status` です。連携解除は `/unlink`、保存済みの登録データ全体の削除は `/account delete` です。

## プライバシー

通知判定と連携管理に必要なDiscord ID、表示名、サーバー・チャンネル情報、キュー状態などを扱います。ユーザー向けDMには内部のSnowflake IDを表示しません。メッセージ本文、添付ファイル、Discordパスワード、User Token、DM本文は保存・転送しません。

- [Privacy Policy](docs/PRIVACY.md)
- [Terms of Service](docs/TERMS.md)
- [公開βLP](https://alt-notify.pages.dev/)
- [公開Terms](https://alt-notify.pages.dev/terms.html) / [公開Privacy](https://alt-notify.pages.dev/privacy.html)

## β版について

公開βのため、Discord障害、権限変更、DM拒否、ネットワーク障害、VM障害などにより通知の到達・即時性・完全性を保証できない場合があります。Alt NotifyはDiscordとは独立したサービスです。

## 開発者向け

### 技術構成

- Node.js 24 / TypeScript / discord.js v14
- SQLite（`sql.js` の純WASM実装）
- Vitest
- Oracle Cloud VM + systemd（本番）

### ローカル起動

```powershell
npm ci
Copy-Item .env.example .env
# .env にBot Token、Application IDなどを設定
npm run deploy:commands
npm run dev
```

検証コマンド：

```powershell
npm run check
npm test
npm run build
npm audit --omit=dev --audit-level=high
git diff --check
```

`.env`、Token、SSH鍵、SQLite本番DB、バックアップ、`node_modules`、`dist`、ログはGit管理しません。環境変数の詳細は [.env.example](.env.example) を参照してください。

### Discord権限

招待時のScopeは `bot` と `applications.commands`、権限は監視対象チャンネルの `View Channel`、`Read Message History`、および必要なアプリケーションコマンド利用に限定します。Administrator権限は要求しません。GatewayではMessage Content Intentを使用しません。

本番運用、バックアップ、障害対応は [docs/OPERATIONS.md](docs/OPERATIONS.md) と [docs/INCIDENT_RESPONSE.md](docs/INCIDENT_RESPONSE.md) を参照してください。
