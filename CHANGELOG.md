# Changelog

## 0.1.0-beta.11 - 2026-10-05

公開βの長期運用に向けて、保持期間・復旧手順・拡大ゲートを明確化。

- Privacy/Termsのアカウントデータ、通知履歴、連携コード、backup保持方針を具体化
- Oracle backupを最新7世代かつ14日以内、Windows offsite backupを最新14世代かつ30日以内に整理
- production `requireExisting`経路を再利用する隔離restore drillとRPO/RTO運用目標を追加
- LONG_TERM_OPERATIONSをHealthchecks、queue age/failure、VM外backupの稼働実態へ同期
- Oracle管理SSH鍵をOneDrive外のWindows OpenSSH領域へ移行し、旧鍵を失効
- Node 24のLinux/Windows GitHub Actions CIを追加
- 75 GuildでVerification準備、90 Guildで新規導入を停止する運用ゲートを追加

## 0.1.0-beta.10 - 2026-10-05

通知キューの停滞とVM外バックアップの未更新を既存のHealthchecksで検知。

- 送信可能時刻を過ぎたpending/processing通知の滞留時間を監視し、everyoneの意図的な遅延や未来時刻のretryを異常扱いしない
- Windows VM外バックアップの成功・失敗状態と最終成功時刻をOracleへ記録
- バックアップ失敗または36時間以上の未更新を既存Healthchecks heartbeatへ統合し、次回成功時に自動復旧
- Windows PC停止時もOracle側のstale監視でバックアップ未更新を検知

## 0.1.0-beta.9 - 2026-10-04

通知・削除操作の競合とバックアップ情報の公開を改善。

- Discord User取得後、DM送信要求の直前に連携・watch・キュー状態を再確認し、無効化された対象への送信を防止
- `/account delete` のConfirm/Cancelで同じ一回限りのトークンを消費し、先に成立した操作だけを実行
- PrivacyにOracle VM内バックアップとWindows PCへのVM外バックアップ、保持世代・取得制約・削除後の残存可能性を明記
- Healthchecksの一時Downを調査。送信リクエストの一時失敗を確認し、Bot停止や継続的なGateway障害は見られなかったため監視設定は変更せず

## 0.1.0-beta.8 - 2026-10-04

公開拡大前の通知信頼性と運用準備を強化。

- 古いGuildMemberキャッシュによるロールメンションの見落としを修正
- アカウント削除ボタンのInteractionへDB処理前に応答するよう改善
- 日次バックアップの最新7世代保持をファイル名の日時順へ修正
- WindowsへのVM外バックアップを定期化し、ハッシュ・SQLite整合性を検証
- 外部Healthchecksのheartbeat受信と通知先を確認
- Bot Tokenを更新し、新しいGateway接続を確認
- Wider beta向けの利用規模ソフト上限と再評価条件を文書化

## 0.1.0-beta.7 - 2026-10-04

公開βの運用復旧・Gateway監視・Healthchecks安全性を強化。

- 継続的な起動失敗は有限回の再試行後に停止し、原因確認後に起動制限を解除して復旧する手順を整備
- Token・Healthchecks設定変更に失敗した場合は旧設定へ戻してGateway復旧を確認し、復旧自体に失敗した場合はroot専用の旧設定コピーを保持して次の変更を拒否
- 現在の起動と最新のGateway状態だけで復旧を確認し、古いreadyログを誤採用しないよう修正
- 全Shardの接続状態を確認し、再接続中のShardがある場合はGateway未接続として扱う
- Healthchecksの設定時確認と定期heartbeatはリダイレクトを追跡せず、3xxを失敗扱いに統一
- HTTP/HTTPS通信、Gateway再接続、設定変更の巻き戻しに関する回帰テストを通常のテストへ追加

## 0.1.0-beta.6 - 2026-10-03

公開βの起動安全性と通知キュー優先順位を修正。

- 本番DBが欠落・空・破損、またはAlt Notifyの基本テーブルを持たない場合、空DBを生成せず起動を中止
- migrationとGatewayログインの前に、既存DBの整合性とschemaを検証
- systemdの`ExecStartPre`でも本番DBが非空であることを確認
- role→everyoneへのフォールバック時にキューの`kind`と`mention_type`をeveryoneへ更新
- フォールバック済み通知の優先順位をキュー上限時の退避判定へ反映

## 0.1.0-beta.5 - 2026-10-03

公開βのアカウント削除・通知再試行の信頼性修正。

- 過去にメインとサブを兼任していたアカウントの`/account delete`で、両側の連携・設定と全状態の通知履歴から本人情報を削除
- 同じDiscordアカウントの新規main/sub兼任登録を禁止し、既存の兼任状態を`/status`に表示
- 一時的なDM送信失敗後、再送のたびにDiscord側の所属・ロール・チャンネル権限をfresh fetchで再確認
- ロールメンションと全体メンションが併記された投稿で、送信前にロールを失った場合は全体メンションへ切り替え、投稿から60秒の遅延を維持

## 0.1.0-beta.4 - 2026-10-02

公開βのプライバシー競合修正。

- `/unlink`後でも`/account delete`で保存済み通知履歴から本人のID・表示名を削除可能に
- 受信時のenqueue前、送信時の認可後、DM retry前にローカルの連携・watch状態を再確認
- `/unlink`・`/account delete`・`/watch off`が非同期確認中に行われても、無効な対象を通知しないよう修正
- 直接メンション対象が消えて全体メンションだけ残った場合も、60秒遅延を維持

## 0.1.0-beta.3 - 2026-10-02

公開βの信頼性・プライバシー修正。

- 非公開スレッドを通知対象外にし、送信直前にも除外
- 送信直前のauthorizationでGuildMemberとChannelをfresh fetch
- サブアカウントの`/account delete`時、全通知履歴からそのID・表示名を除去
- DM retryに同一キュー行で再利用するnonceを設定し、短時間の重複送信を抑止

## 0.1.0-beta.2 - 2026-10-02

公開βメンテナンスリリース。

- Discord API一時障害時のロールメンション誤分類を修正し、送信直前のロール確認を維持
- 通知ワーカーの多重実行を防止し、DM送信完了時刻から送信間隔を計測
- `/watch off`をDiscord API障害中も受け付けるよう修正
- 承認・失敗試行・Memberキャッシュに件数上限と期限削除を追加
- 終了時の通知処理待機、失敗時刻に基づくHealthcheck集計を追加
- 予期しない内部エラーの表示を修正し、Alt Notify表記とPrivacy文書を整理

## 0.1.0-beta.1 - 2026-10-02

初回の公開βリリース。

- 直接メンション、ロールメンション、`@everyone` / `@here`相当の通知集約
- 直接 > ロール > 全体メンションの優先順位
- Freeの新規連携上限1、開発者/テスト枠とPro設計5
- Discord API一時障害の有限retryと送信直前の権限再確認
- SQLite日次バックアップ、systemd運用、外部Healthchecks任意対応
- アカウント削除、本文・添付非保存、Snowflake IDを表示しない通知DM
- 公開β向けREADME、利用条件、Privacy Policy、静的LP
