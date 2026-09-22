# AltNoti 公開前セキュリティ監査

監査日: 2026-09-22  
対象: TypeScript/discord.js Bot、sql.js SQLite、Oracle Cloud VM、systemd

## 判定

P0は1件オープンです。過去の作業会話にBotトークンが平文で投稿されているため、Discord Developer Portalでトークンを再発行し、Oracleの環境ファイルへ新しい値を反映するまで公開状態にしないでください。監査ログ、Git、最終報告にはトークンを出力しません。再発行後は旧トークンを無効化し、Gateway接続とSlash Command登録を確認します。

コード上のP0/P1は、今回の修正後に残っていません。P2は運用上の残課題です。

## 指摘一覧

| ID | 重大度 | 状態 | 内容と根拠 |
| --- | --- | --- | --- |
| SEC-001 | P0 | 要ユーザー対応 | Botトークンが会話へ平文投稿された。Portalで再発行するまで資格情報漏えいリスクが残る。 |
| SEC-002 | P1 | 修正済み | 送信直前の連携解除、`/watch off`、サーバー脱退、チャンネル閲覧権限を再確認していなかった。`NotificationAuthorization` と `channel_id` 保存を追加した。 |
| REL-001 | P1 | 修正済み | `processing` 取得の更新結果を無視しており、ワーカー重複時に同一通知を送る可能性があった。条件付き更新の変更件数を確認するようにした。 |
| REL-002 | P1 | 修正済み | 再起動時に`processing`が復旧されるのは明示的cleanup時だけだった。起動時復旧と定期cleanupを追加した。 |
| DATA-001 | P1 | 修正済み | SQLite全体の直接上書きでプロセス停止時に破損窓があった。同一ディレクトリの一時ファイルからリネームする保存に変更した。 |
| DATA-002 | P1 | 修正済み | 複数サブアカウントを1キューへまとめた通知で、1件の連携解除が他の有効サブアカウント通知まで破棄していた。対象IDだけをキューから除外するようにした。 |
| DOS-001 | P1 | 修正済み | メインごとの未送信キュー上限とDM間隔がなかった。`MAX_PENDING_PER_MAIN` と `DM_MIN_INTERVAL_MS` を追加した。上限到達時も失敗レコードを残し、pending中の全体メンションがある場合は直接メンションを優先して置換する。 |
| NET-001 | P1 | 修正済み | 429以外の一時的なDiscord 5xxを即時失敗にしていた。429/500/502/503/504を最大3回再試行するようにした。 |
| OPS-001 | P2 | 準備済み | 任意のHealthchecks heartbeatを追加。Gateway未接続時は成功pingを送らず、キュー滞留・失敗増加時は`/fail`を送る。URL未設定時は外部通信なし。 |
| OPS-002 | P2 | 軽減済み | 同一VM内の世代バックアップは導入するが、オフホスト暗号化バックアップは外部保存先の承認が必要。7世代のローカルバックアップを保持する。 |
| SCALE-001 | P2 | 既知の制約 | sql.jsは変更ごとにDB全体をメモリ上から書き出す単一プロセス構成。利用者増加時はサーバーSQLiteドライバまたは外部DBへ移行する。 |
| PRIV-001 | P2 | 設計維持 | メッセージ本文を保存・転送せず、Message Content Intent、Guild Members Intent、Presences Intentを要求しない。対象チャンネルの個別取得だけを行う。 |

## キュー超過時の通知ポリシー

- 同一メインアカウント・同一メッセージに複数サブアカウントが対象の場合は1行へ集約する。
- 全体メンションは60秒遅延し、同一メッセージ内の対象サブアカウントを1通へまとめる。
- pending/processingの合計が上限に達した場合、全体メンションは`failed`と`notification queue capacity exceeded`を記録する。
- 直接メンションが上限に達した場合、pending中の全体メンションを最大1件だけ`failed`へ移し、`evicted by direct mention priority`を記録して直接メンション用の枠を確保する。
- processing中の通知は置換しない。送信中の処理を壊さないためである。
- 全体メンションは別メッセージ間では統合しない。メッセージ単位のdedupと遅延で扱い、将来さらに集約する場合は利用者が通知を失う範囲を別途決める。

## アクセス制御レビュー

- `/admin-stats` は設定された所有者IDとの完全一致で制限する。
- 連携はコードのハッシュ、期限、1回限り、本人の承認ボタンで成立する。
- Bot権限は対象チャンネルの閲覧とコマンド利用に限定し、メンバー全件取得を行わない。
- `allowedMentions.parse=[]` により通知DMから再メンションを発生させない。
- `.env`、SQLite、秘密鍵はGit管理対象外とし、systemd環境ファイルはroot所有・グループ読み取りに限定する。

## 本番前の受入条件

1. P0のBotトークンをPortalで再発行し、旧トークンを無効化する。
2. `npm run check`、`npm test`、`npm run build` が成功する。
3. OracleでSQLite整合性、Gateway接続、既存連携、通知キューを確認する。
4. `/watch off` 後の既存キューが送信されず、`/watch on` 後の新規通知だけが送信されることを確認する。
5. サブアカウントのサーバー脱退または連携解除後に通知されないことを確認する。

参照: [Discord Message Content Intent FAQ](https://support-dev.discord.com/hc/en-us/articles/4404772028055-Message-Content-Intent-FAQ-Redirecting)、[Discord Developer Terms](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service)、[Discord OAuth2](https://discord.com/developers/docs/topics/oauth2)、[Discord Rate Limits](https://discord.com/developers/docs/topics/rate-limits)
