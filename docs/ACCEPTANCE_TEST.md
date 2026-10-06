# v1.0 最終受入試験（Public Beta）

実施日: 2026-10-06。対象: `0.1.0-beta.13`。本番アカウント削除、User Token、Self-Bot、Botによる人間投稿の代替は行わない。以下は本文・Discord ID・usernameを記録しない結果表である。

## 自動確認

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| beta.13整合 | PASS | beta.13 tagの指すcommit、Prerelease targetとrelease commitのCIが一致。masterは受入検証の追補commitで、tagは移動していない |
| 公開招待 | PASS | 本番Applicationと一致、`bot` + `applications.commands`、`View Channel`のみ。Administratorとprivileged intent不要 |
| Slash Command | PASS | Discord global登録8件とコード定義の名称・説明・サブコマンドが一致 |
| `/help`・`/status`・`/watch status` のコード | PASS | 表示分岐を確認し、既存の状態別回帰テストを実行。Discord UI表示は下表で別途確認 |
| `/account delete`相当の隔離E2E | PASS | synthetic DBでdisk再確認、privacy世代更新、旧backup復元拒否、新backup隔離復元、無関係データ保持、旧artifact整理を確認。本番アカウントは削除していない |
| Oracle/Windows/Healthchecks | PASS | Gateway ready、DB整合性、検証済み両backup、平文0、Windows Bot停止、監視失敗ログ0 |

## 実Discord操作

| シナリオ | 結果 | 備考 |
| --- | --- | --- |
| A1 本垢への直接メンションで追加DMなし | NOT RUN | 人間投稿が必要 |
| A2 サブ垢への直接メンションでDM 1通 | NOT RUN | 人間投稿が必要 |
| A3 `/watch off`で新規通知なし | NOT RUN | サブ垢操作と人間投稿が必要 |
| A4 Bot再起動後もOFF維持 | NOT RUN | A3後にCodexが1回再起動して確認 |
| A5 `/watch on`で通知再開 | NOT RUN | サブ垢操作と人間投稿が必要 |
| A6 サブ垢不参加のGuildから通知なし | NOT RUN | 該当Guildがあれば実施 |
| A7 `/help`・`/status`・`/watch status`のUI表示 | NOT RUN | Discord画面の人間確認が必要 |
| B1 複数サブ垢の1通集約 | NOT RUN | 追加の実アカウントがある場合のみ。コード回帰テスト済み |
| B2 DM拒否後の有限retry/failed | NOT RUN | DM設定変更に同意がある場合のみ。コード回帰テスト済み |
| B3 Free 1件目成功・2件目拒否 | NOT RUN | 追加の実アカウントがある場合のみ。コード回帰テスト済み |
| B4 開発者/テスト枠1〜5件・6件目拒否 | NOT RUN | 追加の実アカウントがある場合のみ。コード回帰テスト済み |
| B5 既存上限超過link保持 | NOT RUN | 該当する既存状態がある場合のみ。コード回帰テスト済み |

現在のv1 readiness: **RED**（Aの実Discord操作が未完了）。既知P2のロールMember REST負荷、sql.js全量保存、`/account refresh`履歴走査、systemd `NoNewPrivileges`再有効化余地は、今回新たな実害が確認されなければYELLOWとして維持する。DPAPI profileとOracleの同時喪失は、現規模で受容する災害時データ損失リスクであり、独立復旧鍵は作らない。v1.0 Releaseは未作成。
