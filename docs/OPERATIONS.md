# Alt Notify 運用手順

## 本番構成

- Oracle Ubuntu 24.04 / 1GB VM
- 実行ユーザー: `altnoti`
- 配置: `/opt/altnoti`
- DB: `/var/lib/altnoti/discord-alt-notify.sqlite`
- 環境ファイル: `/etc/altnoti.env`（root所有、`640`）
- systemd: `alt-notify.service`
- ログ: `journalctl -u alt-notify.service`
- バックアップ: `altnoti-backup.timer`（毎日、最新7世代）
- 外部監視: Healthchecks heartbeat（本番設定済み。成功pingと通知先を外部ダッシュボードで確認）

BotはNode.js＋systemdで動作させる。1GB VMではDocker常駐のオーバーヘッドを避け、Nodeプロセスのメモリ上限をsystemdの`MemoryMax`で制御する。Windows版Botは本番稼働中に起動しない。

本番起動ではDBの存在、通常ファイル、非空、SQLite整合性、必須の既存テーブルをGatewayログイン前に検証する。失敗した場合は**起動を中止**し、空DBを自動生成しない。systemdの`ExecStartPre`も非空ファイルを確認する。ローカルのテスト用DB作成は`SqliteDatabase.open`の通常モードで引き続き可能。

継続的な起動失敗は`StartLimitIntervalSec=60s`・`StartLimitBurst=5`と5秒間隔の再試行後に、安定した`failed`へ移行する。再試行中は`systemctl is-failed alt-notify.service`がまだ`failed`を返さない場合がある。最終状態と`journalctl -u alt-notify.service`を併せて確認する。このVMでは起動制限到達後も`Result=exit-code`となり、journalに`Start request repeated too quickly`が記録された。本番DBを使った故障注入は行わず、レート制限の検証には`deploy/alt-notify-startup-failure-test.service`を一時unitとして使う。

起動制限到達後は[インシデント対応](INCIDENT_RESPONSE.md)に従う。原因修正とDB・設定・権限の検証後に限り`sudo systemctl reset-failed alt-notify.service`、`sudo systemctl start alt-notify.service`の順で実行し、active、今回のGateway ready、main/link/queueを確認する。

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
```

`ok`を確認し、DBの存在・非空・所有者・権限と停止原因を検証した後に限り、`sudo systemctl reset-failed alt-notify.service`、`sudo systemctl start alt-notify.service`を実行する。異常時は停止したまま調査する。

復元は、サービス停止、対象DBを別名へ退避、検証済みバックアップを所定パスへ配置、存在・非空・整合性・所有者・権限確認、`reset-failed`、サービス起動、Gatewayと連携・queue確認の順で行う。削除や初期化はしない。

VM外バックアップにはWindows側の`deploy/pull-offsite-backup.ps1`を使う。SSH経由でOracle本番DBの整合性を確認し、日次backup serviceを実行、バックアップ整合性とSHA-256を確認してからWindowsへ取得する。Windows上でもハッシュとSQLite整合性を確認して成功扱いとし、ファイル名の日時で最新14世代を保持する。既定保存先は`%LOCALAPPDATA%\AltNotify\offsite-backups`で、OneDriveやGitの外に置く。保存先へのアクセスは現在ユーザーとSYSTEMに制限する。Oracle側の一時ステージは転送後に削除する。Windows PCが停止・未ログオンの間は実行されず、VM外の最新世代は更新されない。より強い災害復旧が必要なら別の保管先を検討する。

定期実行は運営者が指定した日本時間の時刻に、Task Schedulerでdaily・ログオン環境・StartWhenAvailable相当を設定する。作成後、実際の1回の取得・ハッシュ一致・別DBとしての読み取りを確認するまではVM外バックアップを「有効」と判定しない。

現在は毎日06:00 JSTに`AltNotifyOffsiteBackup`タスクを登録済み。Windows上で新規登録する場合は`deploy/install-offsite-task.ps1 -At "HH:mm"`を実行する。現在ユーザーのログオン中だけ走り、PC停止中の実行は次回利用可能時に開始する。バッテリー駆動中も実行可能に設定する。タスクの最終実行結果が失敗した場合は、VM外コピーが更新されていないものとして調査する。Windows PowerShell 5.1でも文字列を正しく読めるよう、実行するスクリプトはUTF-8 BOMで保存する。

DBが欠落・空・破損した場合は、まずサービスを停止して原因と日次バックアップの整合性を調べる。**本番パスで新規DBを作らない。** 復元が必要なら上記の手順で検証済みバックアップから復元し、復元前後のmain/link件数とキュー状態を確認する。既存DBが見つかった場合も上書きせず、別名で保全してから判断する。

## デプロイ

1. ローカルで`npm run check && npm test && npm run build`。
2. Oracleで日付付きSQLiteバックアップ。
3. Windows版Botが停止していることを確認。
4. `/opt/altnoti`へソース、`dist`、`package-lock.json`を転送。`.env`とDBは上書きしない。
5. Oracleで`npm ci --omit=dev`、systemd reload、`systemctl restart alt-notify.service`。
6. `status`、現在Invocationの最新Gateway状態、DB整合性、既存連携、pendingキューを確認。

環境変数の変更時は `/etc/altnoti.env`を直接ログ出力せず、必要なキー名だけをレビューする。公開βの通常Free上限は`FREE_LINK_LIMIT=1`です。開発者・テスト用権限とPro枠はアプリ側で5件を維持します。既存の超過連携は削除せず、新規連携だけを拒否します。

## Token更新

Discord Developer PortalでTokenを再発行した後、Token自体をチャットへ送らず、Windows上で次を実行する。

```powershell
.\deploy\rotate-token.ps1
```

入力は非表示。スクリプトはOracleでバックアップ、環境ファイルの原子更新、systemd再起動を行い、現在の`InvocationID`の最後のGateway状態がready/connectedであることを確認する。disconnected/reconnectingが最後なら、過去のreadyを成功判定に使わない。失敗時は更新前の環境ファイルへ戻してサービスを再起動する。

更新前の環境ファイルは、サービス停止前にroot専用の`/var/backups/altnoti-config-recovery/altnoti.env`へ保存・照合・同期する。ディレクトリは`root:root 700`、ファイルは`root:root 600`。正常更新か検証済みrollbackの後だけ消去する。rollback失敗・強制終了後は残るため、次のToken/Healthchecks設定変更は拒否される。運営者は原因と現在のサービス状態を調査し、復旧コピーを安全な場所へ退避してから手動復旧する。内容や秘密値をログ・チャットへ貼らない。`/var/lib/altnoti`はBotユーザーが書き込めるため復旧コピーに使わない。

既定でWindowsのDesktopからSSH鍵を探し、次にDownloadsを確認する。特殊な配置では`-KeyPath "..."`で上書きする。失敗時は旧env復元だけでなくrollback後のGateway readyを確認する。Portalで旧TokenをReset済みなら旧envへ戻しても復旧しない場合があり、`manual intervention required`を見落とさない。

## Healthchecks設定

1. Healthchecks.ioでheartbeat checkを作成する。通知先、失敗猶予、通知頻度はHealthchecks側で設定する。
2. URLをチャットへ貼らず、Windows上で次を実行する。

```powershell
.\deploy\configure-healthcheck.ps1
```

SSH鍵の探索順と`-KeyPath "..."`による上書きはToken更新と同じ。設定成功には現在の起動の最新Gateway状態がready/connectedであることと、新しい秘密URLへのHTTPS GET 2xx heartbeatの両方を要する。probeは`/usr/local/lib/altnoti/probe-heartbeat.mjs`（root管理、Node.js 24以上）で実行し、5秒でタイムアウトする。リダイレクトは追跡せず、3xxは失敗とする。スクリプトと同時にこのファイルを配置する。外部probe失敗時は旧envへ戻し、旧設定でのサービス起動と最新Gateway状態を確認する。URLはコマンドラインやログへ出さない。

配置時はリポジトリの`deploy/probe-heartbeat.mjs`をOracleの一時ステージへ転送し、`sudo install -d -o root -g root -m 755 /usr/local/lib/altnoti`、`sudo install -o root -g root -m 644 <stage>/probe-heartbeat.mjs /usr/local/lib/altnoti/probe-heartbeat.mjs`を実行する。両設定スクリプトは`/usr/local/sbin/`へ`root:root 755`で配置する。設定実行前に`stat`とローカル/OracleのSHA-256一致で3ファイルを確認する。設定スクリプトは秘密入力を受け取るため、配置確認のために本番値で実行しない。

現在の全ShardがReadyで、pending/processingが200未満、直近15分のfailedが5未満の場合だけ成功heartbeatを送る。1つでもShardが再接続中なら送信せず、Healthchecks側の期限切れで検知する。閾値を超えた場合は`/fail`を送る。設定時probeと定期heartbeatはどちらもリダイレクトを追跡せず、3xxを失敗扱いにする。URL未設定時は外部通信しない。

## Discord実機確認

- `/status` と `/watch status` が連携・自動監視・個別OFFを示す。
- サブアカウントが参加しBotも導入済みのサーバーで、サブアカウントへの直接メンションを作る。
- メインアカウント自身へのメンションは追加DMされない。
- `/watch off` 後は新規通知が来ず、再起動後もOFFが維持される。
- `/watch on` 後は通知が再開する。
- サブアカウントが不参加のサーバー、連携解除後、閲覧権限のないチャンネルから通知されない。
