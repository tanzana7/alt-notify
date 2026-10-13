# Oracle主導のR2オフサイトバックアップ

この文書は、Windows PCを通常運用から外し、Oracle VMからCloudflare R2へ暗号化バックアップを送る構成の導入手順です。feature branchで準備された状態では、旧Windows Task Schedulerを停止してはいけません。R2の自動timer、remote検証、download、隔離restore drill、Healthchecks更新を確認した後だけ切り替えます。

## 構成

1. `altnoti-backup.service` がactive SQLiteを直接読まず、整合性確認済みのOracleローカルbackupを作成する。
2. `altnoti-offsite-backup.service` がそのartifactをAES-256-GCMで暗号化し、R2の一時objectへuploadする。
3. objectのサイズ・SHA-256・privacy generation metadataを確認する。
4. R2から同じobjectをdownloadし、復号・SQLite integrity・必須table・サービス初期化を本番DBとは別のメモリDBで確認する。
5. 検証後に正式objectを確定し、成功時だけ`offsite-backup-status.json`を更新する。
6. 正式objectを確認した後、30日超または14世代を超える正式objectを整理する。一時objectの整理失敗はwarningとして残し、成功済みbackupを失敗扱いにしない。

object keyにはDiscord ID、username、Guild名、hostname、tokenを含めません。bucketはprivateのままにし、public domainを追加しません。

## Oracle秘密設定

Cloudflare Dashboardで専用のR2 bucketと対象bucketだけに限定したS3 API credentialを作成します。Pages用Tokenやaccount-wide管理Tokenは流用しません。R2 credentialは以下のroot専用ファイルへ配置します。

`/etc/altnoti-offsite/r2.env`:

```text
ALTN_R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
ALTN_R2_BUCKET=alt-notify-backups
ALTN_R2_ACCESS_KEY_ID=<r2-access-key>
ALTN_R2_SECRET_ACCESS_KEY=<r2-secret-key>
ALTN_R2_REGION=auto
ALTN_R2_PREFIX=backups
ALTN_OFFSITE_KEY_FILE=/etc/altnoti-offsite/backup.key
```

ファイルは`root:root`、mode `600`または`400`にします。値はGit、journal、shell history、チャットへ置きません。

`/etc/altnoti-offsite/backup.key`は32バイトのOracle側暗号化鍵です。Oracle VM全損時にR2のciphertextを復号できるよう、鍵のrecovery copyをOracleとは独立したoffline保管先へ、運営者が一回だけ安全にescrowします。recovery copyが準備できない状態では本番切替を行いません。Windows DPAPI鍵は流用しません。

## インストールと切替ゲート

アプリケーションを`/opt/altnoti`へ配置し、build済み`dist`を確認した後、rootで次を実行します。スクリプトはcredentialまたは鍵が欠けている場合に停止し、timerを有効化するだけで本番backupを自動実行しません。

```bash
sudo /opt/altnoti/deploy/install-server-side-offsite.sh /opt/altnoti
sudo systemctl start altnoti-offsite-backup.service
```

手動実行で、R2 object、head検証、download、restore drill、privacy generation一致、status `ok`、Healthchecks successを確認します。その後、次の日次timerの自動実行で以下を確認します。

```bash
systemctl list-timers altnoti-offsite-backup.timer
systemctl show altnoti-offsite-backup.service --property=ExecMainStatus,Result
journalctl -u altnoti-offsite-backup.service --since '24 hours ago' --no-pager
```

自動実行成功前にWindows Task Schedulerをdisableしません。自動実行成功後にだけ、`AltNotifyOffsiteBackup`をdisableし、deleteは別判断にします。既存のWindows encrypted backup、DPAPI key、bundleは移行直後に削除しません。

## 失敗時の扱い

- credential不足、鍵不足、bucket非公開確認不能：起動失敗。statusをsuccessにしない。
- upload、head、download、復号、integrity、privacy generation不一致：statusをfailedにし、一時objectの削除を試みる。
- retention cleanupだけの失敗：検証済み最新backupとstatus `ok`を維持し、journalへ秘密を含まない固定警告を残す。
- 本番DBへのrestore、DB初期化、active DBの直接編集は禁止。
- Bot serviceはbackup migrationのために再起動しない。

Cloudflare credentialと独立recovery keyの準備・escrowは外部サービスと物理保管を伴うため、機械的に推測・自動作成しません。
