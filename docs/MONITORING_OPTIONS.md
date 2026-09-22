# 外部監視・外部バックアップの比較

調査日: 2026-09-22

今回は外部サービスのアカウント作成、課金、APIキー発行、DNS公開を行っていない。

## Oracle VM停止時の監視

| 案 | VM停止の検知 | Bot/Gateway検知 | 費用・制約 | 評価 |
| --- | --- | --- | --- | --- |
| OCI Monitoring + Notifications | OCIの制御プレーンからComputeメトリクス・アラームを評価 | Agentメトリクスまたは別途heartbeatが必要 | Always FreeにMonitoringの取り込み・取得枠、NotificationsのHTTPS通知と月1,000件のメール枠がある。IAM、Topic、メール購読の設定が必要 | 第一候補。Oracle内で完結するが、メトリクス欠損時のアラーム条件を実機で確認する |
| UptimeRobot Free | 公開HTTP/port/pingを5分間隔で外部から確認 | `/healthz`等の公開エンドポイントが必要 | Freeは50監視、5分間隔、追加費用なし。公開ポートと外部アカウントが必要 | 導入は容易だが、Botに小さなHTTP health endpointを追加する必要がある |
| Healthchecks.io Hobbyist | VM内timerのheartbeat停止を外部で検知 | systemd timerからのpingでBot/Gateway状態を検知 | Freeは20ジョブ。秘密URLの管理と外部アカウントが必要 | 公開ポート不要で最小構成。ただし外部サービス追加の承認が必要 |
| 同一VM内の監視 | VM停止時は検知不能 | process/systemdのみ | 追加費用なし | VM障害対策には不十分 |

### 推奨

第一段階はOCI Monitoring + Notificationsを手動設定する。既存のOracle契約内で完結し、Computeメトリクスとメール通知を使えるため、外部SaaSを増やさずにVMレベルを監視できる。Compute Instance Monitoring pluginの有効化、Alarm、Notifications Topic、メール購読確認が必要で、メール購読は確認リンクの承認が必要。

Botレベルまで確実に監視する場合の第二段階はHealthchecks.ioで、`alt-notify.service`のsystemd timerがGateway readyを確認してheartbeat URLを叩く構成とする。URL自体が秘密情報になるため、`/etc/altnoti.env`へ保存しログへ出さない。外部サービスの利用承認後に実装する。

UptimeRobotは公開HTTP endpointを必要とするため、Gateway Botだけの現在構成にはHealthchecksより変更量が大きい。

## 外部バックアップ案

### Cloudflare R2

実装案は、Oracleのバックアップtimerが一時ファイルを作成し、整合性確認後にR2へS3互換APIで暗号化転送する方式。R2の無料枠は10GB-month、Class A 100万リクエスト/月、Class B 1,000万リクエスト/月、インターネット向けegress無料。無料枠を超える場合は保存量、操作数、Infrequent Accessの取得などが課金対象になるため、SQLite世代数・保持期間を固定する。

必要なもの:

- Cloudflareアカウント、R2バケット、専用API Token
- Oracle側の秘密ファイルまたはsystemd credential
- バックアップ暗号化、SHA-256、保持世代、復元テスト
- R2到達失敗時の再試行とアラート

今回はアカウント、バケット、API Token、外部転送を追加していない。R2は同一VM障害から復旧できる利点がある一方、秘密情報と外部費用管理が増えるため、承認後に別変更として実装する。

### Cloudflare Workers経由

Worker Cron TriggerからOracleへ取りに行く方式は、Oracle側に認証付きダウンロードAPIを公開する必要があり、SQLiteのロック・転送途中・認証鍵管理が複雑になる。Workers Freeの100,000 requests/dayは監視や小規模スケジュールには十分だが、バックアップ本体の保管はR2が必要で、Worker単体ではバックアップ保管にならない。今回の第一候補にはしない。

## 公式情報

- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- https://docs.oracle.com/en-us/iaas/Content/Compute/References/computemetricsoverview.htm
- https://docs.oracle.com/en-us/iaas/Content/Monitoring/Tasks/create-alarm-basic.htm
- https://healthchecks.io/pricing/
- https://uptimerobot.com/pricing/
- https://developers.cloudflare.com/workers/platform/pricing/
