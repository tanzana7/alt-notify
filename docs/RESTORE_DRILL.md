# 隔離restore drill記録

本番DBへ書き戻さず、Oracle backupまたはCloudflare R2のcurrent-generation backupを別DBへ復元して、SQLite integrity、schema、metadata、privacy generation、アプリケーション初期化を検証する。Gateway接続・DM送信は行わない。削除前generationのbackupはrestore候補として扱わない。

## R2移行時の検証

2026-10-13 07:18 JST、Oracle VMから非公開R2 bucketへ暗号化uploadした最新objectを対象に実施した。R2からのdownload、復号、別DBへのrestore、`PRAGMA integrity_check`、必須table、privacy generation一致を確認し、検証は成功した。本番DBへの書き戻しは行っていない。

| Source | Backup timestamp | Integrity / application open | Count-only validation | Result |
| --- | --- | --- | --- | --- |
| Cloudflare R2 | 2026-10-13 07:18 JST | OK | mains 1 / links 1 / pending 0 / processing 0 / failed 0 | OK |

R2 statusは`state=ok`、`remoteVerified=true`、`restoreVerified=true`、provider `cloudflare-r2`、privacy generation一致だった。source path、hash値、ID、username、本文は記録しない。

## 運用目標

Oracle日次backupが成功している場合のRPOは最大24時間。R2 offsite backupはsystemd timerで日次実行し、最後の成功から36時間以上更新されない場合はHealthchecks異常とする。RTOは復旧作業開始からサービス確認まで60分以内を目標とするが、SLAではない。

## 復旧時の原則

暗号化鍵はOracle上のroot-onlyファイルと、Oracleとは独立したWindows DPAPI保護の復旧用コピーで管理する。R2 bucketはprivateのままにする。active DBを直接編集・初期化せず、復元前後のintegrity、main/link、queue、privacy generationを確認する。Windowsの旧encrypted backup、鍵、bundleは移行直後に削除しない。
