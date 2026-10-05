# 隔離restore drill記録

2026-10-05 06:23 UTC（15:23 JST）に実施。両方とも本番DBへは書き戻さず、ランダムな一時ディレクトリのコピーだけを対象にした。ソースSHA-256とコピーの一致を確認した後、productionと同じ`SqliteDatabase.open(..., { requireExisting: true })`でpreflight/migrationを実行し、必須table、SQLite integrity、Account/Watch/Notification/Healthcheck service初期化を検証した。Gateway接続・DM送信は行っていない。

| Source | Backup timestamp | Integrity / application open | Count-only validation | Measured isolated validation |
| --- | --- | --- | --- | ---: |
| Oracle VM | 2026-10-05 06:21:59 UTC | OK | mains 1 / links 1 / pending 0 / processing 0 / failed 0 | 59 ms |
| Windows offsite | 2026-10-04 23:35:09 UTC | OK | mains 1 / links 1 / pending 0 / processing 0 / failed 0 | 56 ms |

計測値は同一端末上でのバックアップコピー、hash確認、DB open、service初期化の所要時間で、VM構築やDNS/Gateway復旧を含む全面復旧時間ではない。RTO 60分は別途の運用目標であり、SLAではない。source path、hash値、ID、username、本文は記録しない。

運用目標：Oracle日次backupが成功している場合のRPOは最大24時間。Windows offsite backupは毎日06:00 JSTを目標とし、36時間更新されない場合はHealthchecks異常とする。RTOは復旧作業開始からサービス確認まで60分以内を目標とする。
