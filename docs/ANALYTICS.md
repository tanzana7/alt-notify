# アクセス解析の実装メモ

公開LP `https://alt-notify.pages.dev/` でGoogle Analytics 4を利用します。Measurement IDは`site/analytics-config.js`だけで管理します。空文字に戻すとGA4のscriptとイベント送信を停止できます。

計測対象は次のとおりです。

- `page_view`（ページ閲覧）
- `bot_invite_click`
- `github_click`
- `privacy_click`
- `terms_click`

`site/analytics.js`はHTTPSのproduction hostでのみGoogleタグを読み込みます。localhostやpreviewでは読み込みません。イベントの独自パラメータは固定の`location`だけです。Discord User ID、Guild ID、Channel ID、Message ID、username、連携コード、メッセージ本文、DM本文、添付情報、OAuth URL全体は渡しません。ページURLはLPの固定URL、referrerは空に指定し、query値をGoogleタグへ渡さない設計です。広告用途のGoogle signalsと広告パーソナライズも無効にします。

Google Analyticsのデータストリームで、拡張計測の「外部リンクのクリック」と「サイト内検索」を無効にしておきます。これらは独自イベントとは別にリンク先URLや検索queryを自動送信し得るため、公開前の必須確認です。将来CSPを追加する場合は、GoogleタグとAnalytics送信先を許可対象に含めるかを確認します。
