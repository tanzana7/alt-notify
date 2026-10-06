# 隔離restore drill記録

beta.13では本番データを書き戻さず、current-generation Oracle backupの整合性・schema・metadataと隔離restore verifierを再確認する。WindowsのCurrentUser DPAPI鍵を喪失した場合は暗号化コピーを復号できず、Oracleが残っている場合はその現行世代backupから復旧する。双方喪失時の独立した復旧経路は未整備で、v1.0判断項目とする。

2026-10-05 06:23 UTC（15:23 JST）に実施した履歴。Oracleおよび当時のWindowsコピーを本番DBへ書き戻さず、一時コピーだけで確認した。当時のWindowsコピーは暗号化移行前の形式であり、この記録はbeta.12で導入したDPAPI/AES-GCM形式の検証証拠ではない。

2026-10-06のbeta.12準備で、Oracleの新しいcurrent-generation backupとWindowsのAES-256-GCM暗号化backupを、復号後もファイル化せずに検証した。production DB preflight/migration・必須table・SQLite integrity・service初期化・privacy generation一致を確認し、restore drillは成功した。Gateway接続・DM送信は行っていない。本番DBへの書き戻しや破壊的なaccount delete実機試験は行っていない。

| Source | Backup timestamp | Integrity / application open | Count-only validation | Measured isolated validation |
| --- | --- | --- | --- | ---: |
| Oracle VM | 2026-10-05 06:21:59 UTC | OK | mains 1 / links 1 / pending 0 / processing 0 / failed 0 | 59 ms |
| Windows offsite | 2026-10-04 23:35:09 UTC | OK | mains 1 / links 1 / pending 0 / processing 0 / failed 0 | 56 ms |

計測値は同一端末上でのバックアップコピー、hash確認、DB open、service初期化の所要時間で、VM構築やDNS/Gateway復旧を含む全面復旧時間ではない。RTO 60分は別途の運用目標であり、SLAではない。source path、hash値、ID、username、本文は記録しない。

運用目標：Oracle日次backupが成功している場合のRPOは最大24時間。Windows offsite backupは毎日06:00 JSTを目標とし、36時間更新されない場合はHealthchecks異常とする。RTOは復旧作業開始からサービス確認まで60分以内を目標とする。
