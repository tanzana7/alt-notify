# Alt Notify 運用手順

## 本番構成

- Oracle Ubuntu 24.04 / 1GB VM
- 実行ユーザー: `altnoti`
- 配置: `/opt/altnoti`
- DB: `/var/lib/altnoti/discord-alt-notify.sqlite`
- 環境ファイル: `/etc/altnoti.env`（root所有、`640`）
- systemd: `alt-notify.service`
- ログ: `journalctl -u alt-notify.service`
- バックアップ: `altnoti-backup.timer`（毎日、最新7世代かつ14日以内）
- 外部監視: Healthchecks heartbeat（本番設定済み。成功pingと通知先を外部ダッシュボードで確認）
- Windows管理SSH鍵: `%USERPROFILE%\.ssh\alt-notify-oracle-ed25519`（Ed25519、現在ユーザーとSYSTEMのみ読み取り。旧OneDrive鍵はOracleで失効し、ローカル実体を削除）

HealthchecksはGateway全Shard Ready、pending/processing件数、直近15分のfailed件数に加え、送信可能時刻`available_at`を過ぎたキューの最古滞留時間（既定5分）を判定する。everyoneの60秒遅延や未来のretry予定は滞留に数えない。Windows VM外バックアップはroot管理の`/var/lib/altnoti-monitoring/offsite-backup-status.json`に成功・失敗と最終成功時刻のみを記録する。`alt-notify.service`は読み取り専用で、ユーザーID・Windowsパス・秘密値は記録しない。明示失敗または最終成功から既定36時間以上で既存Healthchecksへ`/fail`を送り、次の成功で自動復帰する。Windows PC停止・未ログオン中はTask Schedulerが走らないため、このstale判定で検知する。

Oracle backupは最新7世代かつ14日以内、Windows offsite backupは暗号化済み最新14世代かつ30日以内を保持する。個人IDを含まないprivacy deletion stateはroot管理・atomic write・symlink拒否で、世代、UTC時刻、cleanup状態、DB削除確定段階だけを保持する。削除前backupはstate世代が一致しないためrestore helperとoffsite取得で拒否される。アカウント削除後は整合性確認済みbackupを生成してからOracle旧世代を削除する。Windows端末がofflineの場合、VM外backupの物理削除は次回正常実行まで遅れるが、旧世代はrestore候補として使わない。systemd journalは`/etc/systemd/journald.conf.d/altnoti.conf`の`MaxRetentionSec=30day`でVM全体30日上限とする。

BotはNode.js＋systemdで動作させる。1GB VMではDocker常駐のオーバーヘッドを避け、Nodeプロセスのメモリ上限をsystemdの`MemoryMax`で制御する。Windows版Botは本番稼働中に起動しない。

本番起動ではDBの存在、通常ファイル、非空、SQLite整合性、必須の既存テーブルをGatewayログイン前に検証する。失敗した場合は**起動を中止**し、空DBを自動生成しない。systemdの`ExecStartPre`も非空ファイルを確認する。ローカルのテスト用DB作成は`SqliteDatabase.open`の通常モードで引き続き可能。

継続的な起動失敗は`StartLimitIntervalSec=60s`・`StartLimitBurst=5`と5秒間隔の再試行後に、安定した`failed`へ移行する。再試行中は`systemctl is-failed alt-notify.service`がまだ`failed`を返さない場合がある。最終状態と`journalctl -u alt-notify.service`を併せて確認する。このVMでは起動制限到達後も`Result=exit-code`となり、journalに`Start request repeated too quickly`が記録された。本番DBを使った故障注入は行わず、レート制限の検証には`deploy/alt-notify-startup-failure-test.service`を一時unitとして使う。

起動制限到達後は[インシデント対応](INCIDENT_RESPONSE.md)に従う。原因修正とDB・設定・権限の検証後に限り`sudo systemctl reset-failed alt-notify.service`、`sudo systemctl start alt-notify.service`の順で実行し、active、今回のGateway ready、main/link/queueを確認する。

## 状態確認

予期しない`MessageCreate`通知判定例外は、ユーザー・メッセージIDを含まない直近15分の時刻だけをDB横の状態ファイルへ記録する。1件以上でHealthchecksへ`/fail`、15分経過後は自動復帰する。ファイルが壊れた場合もhealthyとはしない。DBのpersist/export/fsync/renameが失敗した場合はメモリとディスクの一致を仮定せずGatewayを切断して非0終了し、systemd再起動後にディスクDBを再検証する。削除処理はfresh disk openで本人データ消去を検証した後、削除後の安全なbackupを作り、固定されたOracle旧コピー・stagingを削除してから完了する。不確実なpending privacy stateではBotは起動しない。

Oracle VMではNodeの自動アドレス選択でHealthchecksへの接続がタイムアウトした実績がある。heartbeat/probeは通常のHTTPS接続が通信失敗した場合だけIPv4で再試行し、証明書検証を維持しリダイレクトは追わない。応答が2xx以外なら再送せず失敗とする。秘密URLと通信例外全文はログに残さない。

`/account delete`のroot管理backup/state helperは固定された4コマンドだけをsudoersで許可する。Botのsystemd unitで`NoNewPrivileges=yes`にするとsudo自体が実行できず、削除・起動時privacy status確認が失敗するため、`deploy/alt-notify-privacy-sudo.conf`でこの項目のみ無効化する。Botは引き続き`altnoti`ユーザーで動かし、`ProtectSystem=strict`などの隔離とsudoersの引数制限を維持する。sudo許可コマンドや任意パス入力を広げない。

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

VM外バックアップにはWindows側の`deploy/pull-offsite-backup.ps1`を使う。ラッパーはNodeプロセスを起動し、SSH stdoutのbinary streamをWindows上のAES-256-GCM暗号化へ直結する。SQLite平文のWindows temp/final fileは作らない。フォーマットのbyte layoutと鍵/移行条件は[BACKUP_FORMAT.md](BACKUP_FORMAT.md)を参照。hash/restoreが成功した後にencrypted finalをatomic renameし、既存の平文`.sqlite`世代を削除、その後に古いgeneration・期限超過・14世代超の暗号化コピーをpruneし、最後にOracleへ成功を記録する。最新のcurrent-generation safe backupを残せない場合はprune/成功記録を失敗させる。既定保存先は`%LOCALAPPDATA%\AltNotify\offsite-backups`でOneDriveやGitの外。DPAPI鍵を失うと暗号化世代は復号できず、鍵とbackupを同じ場所へコピーしない。Windows PCがofflineの間は旧コピーの物理削除は次回正常実行まで遅れるが、privacy epoch不一致のものはrestore候補にしない。

Windows暗号化backupの鍵はCurrentUser DPAPIとそのWindows profileに依存する。Windows profileだけを失った場合はOracleの現行世代backup、Oracleだけを失った場合はWindows profileと暗号化backupから復旧する。両方を同時に失うと現在の保存データは復旧できない可能性があるが、サービス再構築と利用者の再登録・再連携は可能。現規模ではこの二重喪失を災害時データ損失リスクとして受容し、第三の鍵や保管先は作らない。データ無欠損SLAは提供しない。復旧時には必ずprivacy generationとrestore verifierを確認する。

## 復旧目標とrestore drill

- RPO運用目標：Oracle日次backupが成功している場合は最大24時間。Windows VM外backupは毎日06:00 JSTを目標とし、36時間更新されない場合はHealthchecks異常として扱う。
- RTO運用目標：復元作業開始からサービス確認まで60分以内。SLAではなく内部運用目標。
- Oracle backup確認は`node deploy/verify-restore.mjs <Oracle-backup-name>`を使う。Windows encrypted backup確認は`node deploy/verify-offsite-backup.mjs <encrypted-backup-name>`を使う。最新の`dist`をbuildし、Windows復号はメモリ内だけで行う。live DBへ書き戻さず、Gateway/DMは起動しない。両方ともprivacy state世代、作成時刻、SHA-256、SQLite integrity、production DB preflight/service初期化を検証し、出力は成功状態だけにする。
- 復元所要時間は`docs/RESTORE_DRILL.md`に個人データを含めず記録する。

定期実行は運営者が指定した日本時間の時刻に、Task Schedulerでdaily・ログオン環境・StartWhenAvailable相当を設定する。作成後、実際の1回の取得・ハッシュ一致・別DBとしての読み取りを確認するまではVM外バックアップを「有効」と判定しない。

SSH鍵の解決は`deploy/resolve-oracle-key.ps1`が上記OneDrive外の固定パスだけを使う。別鍵へrotationするときは新公開鍵登録、新鍵SSH/sudo確認、offsite backup成功、旧公開鍵の個別失効、旧鍵拒否、新鍵再確認の順に行う。鍵内容をログ・Issueへ貼らない。

現在は毎日06:00 JSTに`AltNotifyOffsiteBackup`タスクを登録済み。Windows上で新規登録する場合は`deploy/install-offsite-task.ps1 -At "HH:mm"`を実行する。現在ユーザーのログオン中だけ走り、PC停止中の実行は次回利用可能時に開始する。バッテリー駆動中も実行可能に設定する。タスクの最終実行結果が失敗した場合は、VM外コピーが更新されていないものとして調査する。Windows PowerShell 5.1でも文字列を正しく読めるよう、実行するスクリプトはUTF-8 BOMで保存する。

暗号化移行時は、新DPAPI鍵作成とACL検証、Oracle generation一致、GCM/hash確認、メモリ内restore drill、encrypted final保存の順に行う。これらすべてが成功してからだけ既存平文`.sqlite`を削除する。失敗時は既存平文copyを保持し、encrypted backup成功として報告しない。移行後にrecognizedな平文SQLite backupが残っていないこと、encrypted current-generation世代が少なくとも1つ残ることを確認する。Oracleの状態ファイルが`state=ok`かつgeneration一致になった後でのみ、外部backup監視を正常扱いする。状態ファイルの既定パスは`/var/lib/altnoti-monitoring/offsite-backup-status.json`で、秘密を含む環境ファイルの変更は不要。欠落・不正な状態ファイルはfail-closed。状態ファイルの親ディレクトリは`root:altnoti 750`、ファイルは`root:altnoti 640`で、Botに書込権限を与えない。失敗したbackupの詳細はWindowsタスク結果とローカル実行結果で調べ、状態ファイルには固定failure codeのみ記録する。秘密URLやTokenを状態ファイル・ログへ転記しない。

DBが欠落・空・破損した場合は、まずサービスを停止して原因と日次バックアップの整合性を調べる。**本番パスで新規DBを作らない。** 復元が必要なら上記の手順で検証済みバックアップから復元し、復元前後のmain/link件数とキュー状態を確認する。既存DBが見つかった場合も上書きせず、別名で保全してから判断する。

## デプロイ

1. ローカルで`npm run check && npm test && npm run build`。
2. Oracleで日付付きSQLiteバックアップ。
3. Windows版Botが停止していることを確認。
4. `/opt/altnoti`へソース、`dist`、`package-lock.json`を転送。`.env`とDBは上書きしない。
5. Oracleで`npm ci --omit=dev`、systemd reload、`systemctl restart alt-notify.service`。
6. `status`、現在Invocationの最新Gateway状態、DB整合性、既存連携、pendingキューを確認。

環境変数の変更時は `/etc/altnoti.env`を直接ログ出力せず、必要なキー名だけをレビューする。通常Free上限は`FREE_LINK_LIMIT=1`です。開発者・テスト用権限と未提供のPro枠はアプリ側で5件を維持します。既存の超過連携は削除せず、新規連携だけを拒否します。

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

現在の全ShardがReadyで、pending/processingが200未満、直近15分のfailedが5未満、最古の送信可能キューが5分未満、VM外バックアップ状態が正常かつ最終成功から36時間未満の場合だけ成功heartbeatを送る。1つでもShardが再接続中なら送信せず、Healthchecks側の期限切れで検知する。閾値を超えた場合は`/fail`を送る。設定時probeと定期heartbeatはどちらもリダイレクトを追跡せず、3xxを失敗扱いにする。URL未設定時は外部通信しない。

## Discord実機確認

- `/status` と `/watch status` が連携・自動監視・個別OFFを示す。
- サブアカウントが参加しBotも導入済みのサーバーで、サブアカウントへの直接メンションを作る。
- メインアカウント自身へのメンションは追加DMされない。
- `/watch off` 後は新規通知が来ず、再起動後もOFFが維持される。
- `/watch on` 後は通知が再開する。
- サブアカウントが不参加のサーバー、連携解除後、閲覧権限のないチャンネルから通知されない。
