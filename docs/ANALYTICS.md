# アクセス解析の実装メモ

現在、GA4は無効です。`site/analytics-config.js` の `measurementId` が空文字のため、公開LPからGoogleへの通信は発生しません。

将来GA4を有効化する場合は、次の順で行います。

1. `site/analytics-config.js` の空文字を、発行済みのGA4 Measurement IDへ変更する
2. Privacy PolicyへGA4の利用目的・取得項目・外部送信先・無効化方法を追記する
3. 内容確認後にPagesへデプロイする

有効化後に送信する予定のイベントは次のとおりです。

- `page_view`（gtagの標準設定による1回のみのページビュー）
- `bot_invite_click`
- `github_click`
- `privacy_click`
- `terms_click`

イベントパラメータは固定の`location`だけを使用します。Discord User ID、Guild ID、Channel ID、Message ID、username、アカウント情報、OAuth URL全体、URL queryの秘密値、本文は送信しません。

GA4有効化時は、CSPやセキュリティヘッダーを追加する場合に`www.googletagmanager.com`とGoogle Analyticsの送信先を許可対象として検討します。無効状態の現在はCSPを緩和しません。
