# Alt Notify プライバシー情報

最終更新：2026-10-13

## DBへ保存する情報

- メインアカウントのDiscordユーザーID、表示名、登録日時
- 連携したサブアカウントのDiscordユーザーID、表示名、メインとの対応、登録日時
- プラン情報と更新日時（課金処理は未実装）
- 連携コードのハッシュ、発行・有効期限・使用日時。平文コードは保存しません
- サーバーごとの監視状態、Guild ID、作成日時
- 通知キューの状態、メインID、Message ID、Guild ID、Channel ID、対象アカウントID・表示名、対象ロールID、試行回数、時刻、失敗理由
- 重複排除用のメインID、メッセージID、作成日時

Guild名とChannel名は通知表示のためDiscordのキャッシュから参照しますが、DBには保存しません。メンバー情報も通知判定のためメモリ上のキャッシュで扱います。内部IDはユーザー向け通知DMには表示しません。

メッセージ本文、添付ファイル、DM本文、キーワード、全メンバー一覧は保存・転送しません。
非公開スレッドの投稿は通知対象外です。

## 利用目的

本人承認済みの連携を管理し、対象イベントの通知、重複排除、送信再試行、障害調査、バックアップと復元確認に利用します。運営統計は件数と状態のみを扱い、メッセージ本文は含みません。

## 公開サイトのアクセス解析

公開LPではGoogle Analytics 4を利用し、ページ閲覧と主要リンク（Bot招待、GitHub、Privacy、Terms）の利用状況を統計的に把握します。目的は利用状況の把握とサービス改善です。GoogleのタグがCookie等の識別子や接続情報を処理する場合があります。当サイトの計測イベントにはDiscord User ID、Guild ID、Channel ID、Message ID、username、連携コード、メッセージ本文、DM本文、添付情報、Bot招待URL全体、URL queryの値を含めません。Googleによる情報の取り扱いは[Googleのプライバシーポリシー](https://policies.google.com/privacy)等に従います。Botの通知処理にGA4は使用しません。

## 保存場所と委託先

本番データは運営者が管理するOracle Cloud VM上のSQLiteに保存します。日次Oracleバックアップは最新7世代・14日以内を保持します。Oracle VMから非公開のCloudflare R2バケットへ、AES-256-GCMで暗号化したバックアップを最新14世代・30日以内の方針で保存します。R2への保存前にサイズ・ハッシュ・metadataを確認し、R2からのdownload、復号、別DBへのrestore drill、SQLite integrity、privacy generation一致が成功した場合だけ成功状態を記録します。暗号鍵はOracle上のroot-onlyファイルに置き、Oracleとは独立したWindows DPAPI保護の復旧用コピーを保持します。`/account delete`後はactive dataを削除し、削除後の世代でバックアップを更新します。削除前世代は通常の復元候補から除外し、R2上の旧暗号化世代は保持期限・世代整理に従って削除されます。バックアップに本文、Bot Token、平文連携コードは含みません。Discord公式API、Oracle Cloud、Cloudflare R2、Healthchecks.ioを利用します。HealthchecksにはGateway・キュー・通知判定の予期しない失敗・R2バックアップの鮮度を示すheartbeat/failのみを送り、Discordアカウント情報やメッセージ情報は送信しません。

## 削除

`/account refresh` は実行者本人の保存済みusernameと通知履歴上の表示名を、現在のDiscordアカウント情報へ更新します。`/unlink` は個別連携を解除します。`/account delete` は連携の有無にかかわらず、実行した本人のactive dataを削除します。削除をディスクで確認し、削除後のprivacy generationに一致する安全なバックアップを作成します。削除前バックアップは通常の復元候補から除外されます。R2上の旧世代は保持・世代整理の範囲で残る場合があります。すべての媒体からの即時物理削除を保証するものではありません。

## ログ、バックアップと保持

送信済み・失敗・取消済み通知履歴と重複排除情報は作成から7日後の定期cleanupで削除します。連携コードはハッシュのみを保存し、使用済みまたは期限切れのコード情報は定期cleanupで削除します。メイン登録は`/account delete`まで、サブ連携は`/unlink`または`/account delete`まで、Guild監視設定は対象連携またはアカウントの削除まで、entitlementは`/account delete`まで保持します。

運用ログはOracle VMのsystemd journalに記録し、保持上限を30日に設定します。ログには時刻、レベル、処理ID、アカウント内部ID、状態、エラー概要を記録する場合がありますが、メッセージ本文、Bot Token、平文連携コード、R2資格情報は記録しません。バックアップはR2上でも暗号化され、暗号鍵はバックアップファイルに含めません。

## 問い合わせ

一般的な問い合わせ・不具合報告は [GitHub Issues](https://github.com/tanzana7/alt-notify/issues) を利用できます。公開Issueに個人情報・認証情報を投稿しないでください。保存済みデータの削除は`/account delete`、個別のサブアカウント連携解除は`/unlink`で行えます。
