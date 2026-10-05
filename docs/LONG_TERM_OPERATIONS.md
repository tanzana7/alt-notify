# Alt Notify 長期運用リスク

調査日：2026-09-30

## 現在の観測

- Oracle VM：1GB、使用496MB、available約457MB、swapなし
- Bot RSS：約118MB（`ps`の瞬間値）、systemd cgroup current約66MiB、peak約90MiB
- CPU：確認時0.1%前後
- Root disk：45GB中3.3GB使用、使用率8%
- SQLite：約76KB、バックアップ約536KB
- systemd：active、enabled、NRestarts 0
- 本番DB：integrity check OK、pending/processing 0、failed 0
- 24時間ログ：複数のGateway reconnectingと、その後のGateway readyを確認。再接続後は復帰しているが、頻度は継続監視する

上記は単一時点・現行利用量の観測であり、将来負荷の保証ではありません。NodeのVSZは仮想アドレス空間であり、RAM消費の判断にはRSS/cgroup値を使います。

## リスクと対応

| リスク | 影響 | 検知 | 現在の対策 | 将来の対策 |
| --- | --- | --- | --- | --- |
| Oracle VM停止 | Gateway受信・DM送信が停止 | systemd外のHealthchecks期限切れ | systemd自動再起動、Healthchecks本番稼働 | VM外バックアップの復元訓練を継続 |
| Gateway disconnect | 一時的な通知遅延/欠落 | `gateway reconnecting`、ready時刻、Healthchecks | discord.jsの再接続、Gateway readyログ | reconnect回数、継続時間、resume/identify結果をメトリクス化 |
| Discord outage | API確認/DMが失敗 | 429/5xx、retry、failed queue、Healthchecks | 有限retry、failed記録、送信前認可、failed 15分閾値とqueue age 5分監視 | error分類別の傾向を定期確認 |
| Rate limit | REST/DM遅延、再試行増加 | 429、retry_after、処理時間 | discord.jsのREST制御、送信間隔、有限retry | REST status/scope/retry_afterの集計、事前レート制御 |
| Queue overflow | 通知がfailed記録される | queue件数、capacity exceeded、Healthchecks pending/failed/queue age | 上限200、直接優先、超過はfailed記録。pending 200、failed 5件/15分、due queue age 5分でheartbeatをfail | queue増加が継続したら招待拡大停止と処理時間計測 |
| SQLite破損 | 設定・未送信通知の読み込み不能 | 起動失敗、integrity_check | 一時ファイルからrename、Oracle日次最新7世代かつ14日以内、Windows VM外日次最新14世代かつ30日以内 | 隔離restore drillを継続し、実測時間とRPO/RTOを記録 |
| Disk枯渇 | DB保存、ログ、バックアップ失敗 | `df`, backup失敗、systemdログ | Oracle/Windows backupの世代数+暦日cleanup、journald 30日 | disk使用率を定期確認し容量増加を判断 |
| メモリ不足 | OOM kill、Gateway切断、DB保存失敗 | RSS/cgroup、dmesg、systemd状態 | 1GB VM、Node/systemd制限 | VM増強、全量exportをやめるDB方式、負荷分離 |
| VM外バックアップ遅延 | 障害時の復旧点が古くなる | Windows Task Scheduler、status file、36時間Healthchecks stale判定 | Windows PCで毎日06:00 JST、SHA-256とSQLite整合性確認、成功/失敗をOracle statusへ反映 | PC停止中は次回実行まで取得・削除が遅延する前提で運用 |
| Token漏洩 | Bot乗っ取り | 不審Gateway、権限/サーバー変化 | Token非表示入力・ログ/ Git除外 | 定期rotation、権限最小化、監査手順 |
| Discord API仕様変更 | 受信フィールド/権限判定の変化 | Gateway close、テスト失敗、通知率低下 | Message Content非依存、公式仕様確認 | 依存更新前のモック/実機回帰、変更ログ監視 |
| npm依存更新 | 起動/API挙動の変化 | check/test/build/audit、再起動失敗 | lockfile固定、CI相当のローカル検証 | 定期更新、段階的デプロイ、rollback手順 |
| Node.js更新 | 実行不能、メモリ/暗号挙動の変化 | build、systemd、Gateway ready | Node 24固定運用 | LTS移行計画、同一DBの復元検証 |

## 運用上の境界

既存DBの起動前検証は、SQLite整合性とAlt Notifyの基本テーブルを確認するが、正しいschemaを持つ別の空DBへの差し替えまでは検出しない。将来はDB内にランダムなinstance UUIDを保存し、root管理の期待UUIDと照合する方法を検討する。検証済みバックアップは同じUUIDを保持できる。現時点では復元時の運用を複雑にしないため導入せず、main/link件数や変化するDBサイズ・全体hashを起動条件に使わない。

次のいずれかが発生したら、新規導入拡大を止めて対策を優先します。

- Gateway切断が復帰せず、外部監視のfailが継続する
- pending/processingが200へ繰り返し到達する、またはfailed率が増加する
- SQLite save latencyがworker周期を超える
- RSSがavailableメモリを圧迫し、swapなしでOOMリスクが出る
- 日次Oracle/Windows backupの作成、SHA-256、integrity checkまたはrestore drillが失敗する
- 75 Guildで始めたVerification準備が完了しないまま拡大が必要になる、または90 Guildに達する

## 現行監視・保持の運用境界

- Healthchecksは全Shard Gateway Ready、pending/processing数、failed数（15分）、最古due queue age（5分）を見てheartbeatまたはfailを送る。Windows VM外backupは状態ファイルの明示失敗または最終成功36時間超をfailとする。
- Oracle backupは最新7世代かつ14日以内、Windows VM外backupは最新14世代かつ30日以内。日次処理が走ったときに期限超過分を削除し、Windows PC停止中は削除が次回実行まで遅れる。
- `notification_queue`のsent/failed/cancelledと`notification_dedup`は7日後にcleanup。link codeは平文保存せず、使用済み/期限切れ行を定期cleanup。
- systemd journalは専用VM全体で30日保持。メッセージ本文、Bot Token、平文link codeはログしない。
- 復旧目標はSLAではなく運用目標：Oracle backupによるRPO最大24時間、Windows offsiteは毎日06:00 JST・36時間超で異常、RTO 60分。実際の隔離restore drill時間は`docs/RESTORE_DRILL.md`に記録する。
- Guild gateは75でVerification準備警告、90で新規導入停止。起動時すでに90超でも既存Guildは退出させない。約500 linked subsの性能soft capとrole Member REST負荷P2は維持し、最適化は別途計測・判断する。

## Oracle移行候補

Oracle公式のAlways FreeにはAMD ComputeとArm-based Ampere A1 Computeが含まれます。A1は柔軟なshapeで、公式資料上はAlways Free枠として合計1,500 OCPU時間/月・9,000 GB時間/月、Always Free tenancyでは2 OCPU・12GB相当と説明されています。ただしリージョンの容量、既存リソース、アーキテクチャ互換性、移行時の停止時間を確認してから判断します。今回VM変更は行いません。

参照：[Oracle Cloud Free Tier](https://www.oracle.com/cloud/free/)、[Oracle Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
