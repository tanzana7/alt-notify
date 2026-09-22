# AltNoti 運用手順

## 本番構成

- Oracle Ubuntu 24.04 / 1GB VM
- 実行ユーザー: `altnoti`
- 配置: `/opt/altnoti`
- DB: `/var/lib/altnoti/discord-alt-notify.sqlite`
- 環境ファイル: `/etc/altnoti.env`（root所有、`640`）
- systemd: `alt-notify.service`
- ログ: `journalctl -u alt-notify.service`
- バックアップ: `altnoti-backup.timer`（毎日、最新7世代）
- 外部監視: 任意のHealthchecks heartbeat（URL設定後のみ有効）

BotはNode.js＋systemdで動作させる。1GB VMではDocker常駐のオーバーヘッドを避け、Nodeプロセスのメモリ上限をsystemdの`MemoryMax`で制御する。Windows版Botは本番稼働中に起動しない。

## 状態確認

```bash
sudo systemctl status alt-notify.service --no-pager
sudo journalctl -u alt-notify.service -n 100 --no-pager
sudo systemctl is-enabled alt-notify.service
sudo systemctl status altnoti-backup.timer --no-pager
```

ログへトークン、環境ファイル内容、秘密鍵、SQLiteのダンプを出さない。障害調査では時刻、サービス状態、Gatewayの接続ログ、キュー件数だけを採取する。

## SQLite確認とバックアップ

Bot停止を伴わない日次バックアップはtimerが実行する。手動バックアップが必要な場合は、サービス状態を確認してから次を実行する。

```bash
sudo systemctl start altnoti-backup.service
sudo ls -l /var/lib/altnoti/backups
sudo sha256sum /var/lib/altnoti/backups/discord-alt-notify-*.sqlite
```

整合性確認は、サービス停止後に一時作業領域へコピーして行う。元DBを直接操作しない。

```bash
sudo systemctl stop alt-notify.service
cd /opt/altnoti
sudo -u altnoti /usr/bin/node --input-type=module -e 'import initSqlJs from "sql.js"; import fs from "node:fs/promises"; const SQL=await initSqlJs({locateFile:f=>`/opt/altnoti/node_modules/sql.js/dist/${f}`}); const db=new SQL.Database(new Uint8Array(await fs.readFile("/var/lib/altnoti/discord-alt-notify.sqlite"))); console.log(db.exec("PRAGMA integrity_check")[0].values[0][0]); db.close()'
sudo systemctl start alt-notify.service
```

復元は、サービス停止、対象DBを別名へ退避、検証済みバックアップを所定パスへ配置、所有者・権限確認、サービス起動、Gatewayと連携情報確認の順で行う。削除や初期化はしない。オフホストバックアップは別途暗号化保存先を承認してから追加する。

## デプロイ

1. ローカルで`npm run check && npm test && npm run build`。
2. Oracleで日付付きSQLiteバックアップ。
3. Windows版Botが停止していることを確認。
4. `/opt/altnoti`へソース、`dist`、`package-lock.json`を転送。`.env`とDBは上書きしない。
5. Oracleで`npm ci --omit=dev`、systemd reload、`systemctl restart alt-notify.service`。
6. `status`、Gateway ready、DB整合性、既存連携、pendingキューを確認。

環境変数の変更時は `/etc/altnoti.env`を直接ログ出力せず、必要なキー名だけをレビューする。Freeのテスト上限は`FREE_LINK_LIMIT=5`で、将来戻す場合は値だけを`1`へ変更してサービスを再起動する。

## Token更新

Discord Developer PortalでTokenを再発行した後、Token自体をチャットへ送らず、Windows上で次を実行する。

```powershell
.\deploy\rotate-token.ps1
```

入力は非表示。スクリプトはOracleでバックアップ、環境ファイルの原子更新、systemd再起動、Gateway ready確認を行う。失敗時は更新前の環境ファイルへ戻してサービスを再起動する。

## Healthchecks設定

1. Healthchecks.ioでheartbeat checkを作成する。通知先、失敗猶予、通知頻度はHealthchecks側で設定する。
2. URLをチャットへ貼らず、Windows上で次を実行する。

```powershell
.\deploy\configure-healthcheck.ps1
```

Gatewayがreadyで、pending/processingが200未満、直近15分のfailedが5未満の場合だけ成功heartbeatを送る。Gateway未接続時は送信せず、Healthchecks側の期限切れで検知する。閾値を超えた場合は`/fail`を送る。URL未設定時は外部通信しない。

## Discord実機確認

- `/status` と `/watch status` が連携・自動監視・個別OFFを示す。
- サブアカウントが参加しBotも導入済みのサーバーで、サブアカウントへの直接メンションを作る。
- メインアカウント自身へのメンションは追加DMされない。
- `/watch off` 後は新規通知が来ず、再起動後もOFFが維持される。
- `/watch on` 後は通知が再開する。
- サブアカウントが不参加のサーバー、連携解除後、閲覧権限のないチャンネルから通知されない。
