# Changelog

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
