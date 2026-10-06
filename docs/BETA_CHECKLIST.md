# 身内β運用チェックリスト

## 公開前

- [x] beta.13: Oracle管理外DB artifactの安全な整理、現行世代backup・隔離restore、Windows暗号化backup、Healthchecksを再確認
- [x] v1.0判断: Windows DPAPI profileとOracleの同時喪失は、現規模では既知の災害時データ損失リスクとして受容する（独立復旧鍵は作らない）

- [x] `FREE_LINK_LIMIT=1` を確認
- [x] Bot招待URLと必要権限を確認（本番Applicationと一致、`bot` + `applications.commands`、`View Channel`のみ）
- [x] `/help`、`/status`、`/watch status` の表示を確認（Discord実機: main/sub、auto/OFF/ON。noneはautomated integration test）
- [x] Oracle backupのcurrent-generation検証と隔離restore drillを確認（[記録](RESTORE_DRILL.md)）
- [x] 75 GuildでVerification準備、90 Guildで新規導入停止するゲートと既存Guild保持を確認
- [x] Privacy/Termsに`/account delete`、`/unlink`、`/account refresh`、backup削除・暗号化方針を明記し、Cloudflare Pagesへ同期（Privacy専用メール窓口は設置しない）
- [x] GitHub ActionsのUbuntu/Windows CIがbeta.13 release commitで成功
- [x] Windows版Botが停止し、Oracle版だけが稼働していることを確認
- [x] `/account delete`相当の隔離synthetic E2Eでprivacy generation更新、削除前backup復元拒否、削除後backup復元成功を確認（本番アカウントは削除していない）
- [x] Windows offsite backupのDPAPI鍵/ACL、暗号化・restore drill成功後に平文世代が0件
- [x] `/account refresh`がコマンド登録済みで、本人の変更可能表示情報だけを更新
- [x] CI成功、公開Privacy/Termsが原稿と一致

## 利用状況（本文を収集しない）

- メイン登録数
- 連携済みサブアカウント数
- 導入サーバー数
- 通知送信数、失敗数、送信待ち数
- キュー上限到達と直接メンション優先による置換記録
- DM拒否件数
- `/unlink` と `/account delete` の実行件数
- 保存世代と保持期限
- メインごとの連携数分布（将来の料金設計検討用。課金は行わない）

## β確認シナリオ

- [x] 本垢への直接メンションが追加転送されない（Discord実機）
- [x] サブ垢への直接メンションが本垢へ届く（Discord実機、送信件数でも確認）
- [x] 複数サブ垢の対象が1通に集約される（automated integration test。複数実アカウントでの試験は未実施）
- [x] `/watch off` 後はそのサーバーだけ止まる（Discord実機で当該Guildの停止、別Guildへの影響はGuild別keyのコード確認。別Guild実機は未実施）
- [x] `/watch on` で再開する（Discord実機、DBのON行と送信件数でも確認）
- [x] 再起動後も明示的OFFが維持される（Discord実機＋DB、systemd再起動1回）
- [x] サブ垢が未参加のサーバーから通知されない（automated integration test。別Guildでの実機試験は未実施）
- [x] DM拒否が失敗記録になり、無限再試行しない（automated integration test。実DM拒否試験は未実施）
- [x] Freeは1件目が成功し、2件目が拒否される（automated integration test。追加実アカウント試験は未実施）
- [x] 開発者・テスト用権限は1〜5件目が成功し、6件目が拒否される（automated integration test。追加実アカウント試験は未実施）
- [x] 上限超過の既存連携が削除されない（automated integration test。既存本番連携は変更していない）
