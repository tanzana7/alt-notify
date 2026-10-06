# v1.0 最終受入試験（Public Beta）

実施日: 2026-10-06〜07 JST。対象: `0.1.0-beta.13`。本番アカウント削除、User Token、Self-Bot、Botによる人間投稿の代替は行わない。以下は本文・Discord ID・usernameを記録しない結果表である。

## 自動確認

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| beta.13整合 | PASS | beta.13 tagの指すcommit、Prerelease targetとrelease commitのCIが一致。masterは受入検証の追補commitで、tagは移動していない |
| 公開招待 | PASS | 本番Applicationと一致、`bot` + `applications.commands`、`View Channel`のみ。Administratorとprivileged intent不要 |
| Slash Command | PASS | Discord global登録8件とコード定義の名称・説明・サブコマンドが一致 |
| `/help`・`/status`・`/watch status` のコード | PASS | 表示分岐を確認し、既存の状態別回帰テストを実行。Discord UI表示は下表で別途確認 |
| `/account delete`相当の隔離E2E | PASS | synthetic DBでdisk再確認、privacy世代更新、旧backup復元拒否、新backup隔離復元、無関係データ保持、旧artifact整理を確認。本番アカウントは削除していない |
| Oracle/Windows/Healthchecks | PASS | Gateway全shard ready、DB integrity ok、現行Oracle backupとWindows暗号化backupの隔離復元成功、平文0、Windows Bot停止、監視失敗ログ0。外部checkのUp・通知先は運営者が確認済み |

## 実Discord操作

| シナリオ | 結果 | 備考 |
| --- | --- | --- |
| A1 本垢への直接メンションで追加DMなし | PASS（Discord実機） | 人間投稿で追加DMなし |
| A2 サブ垢への直接メンションでDM 1通 | PASS（Discord実機） | 運営者確認、送信済み件数が1件増加 |
| A3 `/watch off`で新規通知なし | PASS（Discord実機） | OFF表示と新規DMなし。DBのOFF行を確認 |
| A4 Bot再起動後もOFF維持 | PASS（Discord実機＋DB） | systemd restart 1回、InvocationID更新、Gateway全shard ready、DBのOFF行維持、再起動後のOFF表示を運営者確認 |
| A5 `/watch on`で通知再開 | PASS（Discord実機＋DB） | ON表示と新規DM 1通を運営者確認。DBのON行、送信済み件数の追加1件、重複行0を確認 |
| A6 サブ垢不参加のGuildから通知なし | PASS（automated integration test） | role/everyoneの非所属判定と送信直前のfresh所属確認。実Discordでは別Guildがないため未実施 |
| A7 `/help`・`/status`・`/watch status`のUI表示 | PASS（Discord実機） | main/sub、auto/OFF/ON表示を運営者確認。none分岐はautomated test |
| B1 複数サブ垢の1通集約 | PASS（automated integration test） | 同一messageの複数targetが1件に集約。実Discordは未実施 |
| B2 DM拒否後の有限retry/failed | PASS（automated integration test） | 拒否時failed、rate limitの有限retryを確認。実Discordは未実施 |
| B3 Free 1件目成功・2件目拒否 | PASS（automated integration test） | 上限1の連携判定。実Discordは未実施 |
| B4 開発者/テスト枠1〜5件・6件目拒否 | PASS（automated integration test） | 上限5の連携判定。実Discordは未実施 |
| B5 既存上限超過link保持 | PASS（automated integration test） | 上限を下げても既存2件を維持し新規追加を拒否。実Discordは未実施 |

受入後の本番状態: main/link各1、pending/processing/failed各0、inspection failure 0、Gateway全shard ready、Healthchecksの内部健全条件に異常なし。watchはONに戻した。systemd再起動はA4の検証で1回のみ行い、既存連携と通知履歴は維持した。

現在のv1 readiness: **GREEN / V1 READY**。A6とB群は実Discord未実施だが、追加アカウントや危険な設定変更を求めず、上記のautomated integration testを受入証拠として採用する。既知P2のロールMember REST負荷、sql.js全量保存、`/account refresh`履歴走査、systemd `NoNewPrivileges`再有効化余地は、今回新たな実害が確認されなかったためYELLOWとして維持する。DPAPI profileとOracleの同時喪失は、現規模で受容する災害時データ損失リスクであり、独立復旧鍵は作らない。v1.0 Releaseは未作成で、Public Beta表記を維持する。
