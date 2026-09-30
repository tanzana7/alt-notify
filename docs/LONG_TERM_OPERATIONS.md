# AltNoti 長期運用リスク

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
| Oracle VM停止 | Gateway受信・DM送信が停止 | systemd外部監視が届かない、Healthchecks期限切れ | systemd自動再起動、Healthchecksは任意 | VM外の死活監視とオフホスト復旧手順 |
| Gateway disconnect | 一時的な通知遅延/欠落 | `gateway reconnecting`、ready時刻、Healthchecks | discord.jsの再接続、Gateway readyログ | reconnect回数、継続時間、resume/identify結果をメトリクス化 |
| Discord outage | API確認/DMが失敗 | 429/5xx、retry、failed queue | 有限retry、failed記録、送信前認可 | APIエラー率とqueue ageのアラート |
| Rate limit | REST/DM遅延、再試行増加 | 429、retry_after、処理時間 | discord.jsのREST制御、送信間隔、有限retry | REST status/scope/retry_afterの集計、事前レート制御 |
| Queue overflow | 通知がfailed記録される | queue件数、capacity exceededログ | 上限200、直接優先、超過はfailed記録 | queue age/failed率のアラート、必要なら永続queue分離 |
| SQLite破損 | 設定・未送信通知の読み込み不能 | 起動失敗、integrity_check | 一時ファイルからrename、日次7世代バックアップ | オフホスト暗号化バックアップ、定期restore drill |
| Disk枯渇 | DB保存、ログ、バックアップ失敗 | `df`, backup失敗、systemdログ | 7世代保持、journald設定 | disk使用率閾値通知、ログrotate検証、オフホスト保存 |
| メモリ不足 | OOM kill、Gateway切断、DB保存失敗 | RSS/cgroup、dmesg、systemd状態 | 1GB VM、Node/systemd制限 | VM増強、全量exportをやめるDB方式、負荷分離 |
| バックアップ同一VM | VM障害と同時に復元不能 | バックアップ成功だけでは検知不能 | 日次ローカル7世代、integrity確認 | 承認済みのオフホスト暗号化保存と復元試験 |
| Token漏洩 | Bot乗っ取り | 不審Gateway、権限/サーバー変化 | Token非表示入力・ログ/ Git除外 | 定期rotation、権限最小化、監査手順 |
| Discord API仕様変更 | 受信フィールド/権限判定の変化 | Gateway close、テスト失敗、通知率低下 | Message Content非依存、公式仕様確認 | 依存更新前のモック/実機回帰、変更ログ監視 |
| npm依存更新 | 起動/API挙動の変化 | check/test/build/audit、再起動失敗 | lockfile固定、CI相当のローカル検証 | 定期更新、段階的デプロイ、rollback手順 |
| Node.js更新 | 実行不能、メモリ/暗号挙動の変化 | build、systemd、Gateway ready | Node 24固定運用 | LTS移行計画、同一DBの復元検証 |

## 運用上の境界

次のいずれかが発生したら、公開範囲を増やす前に対策を優先します。

- Gateway切断が復帰せず、外部監視のfailが継続する
- pending/processingが200へ繰り返し到達する、またはfailed率が増加する
- SQLite save latencyがworker周期を超える
- RSSがavailableメモリを圧迫し、swapなしでOOMリスクが出る
- 日次バックアップの作成またはintegrity checkが失敗する
- 本番と同一VM上のバックアップしかなく、VM障害時の復旧目標を満たせない

## Oracle移行候補

Oracle公式のAlways FreeにはAMD ComputeとArm-based Ampere A1 Computeが含まれます。A1は柔軟なshapeで、公式資料上はAlways Free枠として合計1,500 OCPU時間/月・9,000 GB時間/月、Always Free tenancyでは2 OCPU・12GB相当と説明されています。ただしリージョンの容量、既存リソース、アーキテクチャ互換性、移行時の停止時間を確認してから判断します。今回VM変更は行いません。

参照：[Oracle Cloud Free Tier](https://www.oracle.com/cloud/free/)、[Oracle Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
