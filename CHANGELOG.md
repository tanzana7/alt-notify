# Changelog

## 0.1.0-beta.1 (candidate)

初回の身内・公開β候補。タグとGitHub Releaseは未作成です。

- 直接メンション、ロールメンション、`@everyone` / `@here`相当の通知集約
- 直接 > ロール > 全体メンションの優先順位
- Freeの新規連携上限1、開発者/テスト枠とPro設計5
- Discord API一時障害の有限retryと送信直前の権限再確認
- SQLite日次バックアップ、systemd運用、外部Healthchecks任意対応
- 公開前の性能・長期運用調査を `docs/SCALING.md` と `docs/LONG_TERM_OPERATIONS.md` に記録

### 公開前に確認すること

- `npm run check && npm test && npm run build`
- `npm audit --omit=dev --audit-level=high`
- 本番DBバックアップと `integrity_check`
- Gateway ready、キュー滞留、systemd状態、外部監視設定
