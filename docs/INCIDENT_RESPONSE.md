# Alt Notify インシデント対応

## 共通原則

秘密情報をチャット、Issue、Git、ログへ貼らない。操作前に時刻、サービス状態、直近ログ、DBバックアップのファイル名とハッシュを記録する。DBの初期化、`git reset --hard`、一括削除を行わない。

## Botが停止または再起動を繰り返す

```bash
sudo systemctl status alt-notify.service --no-pager
sudo journalctl -u alt-notify.service -n 200 --no-pager
```

環境変数不足、Node実行時エラー、メモリ上限超過など原因を特定して修正する。DB関連ならDBの存在・非空・`integrity_check=ok`を確認し、必要な設定・所有者・権限も検証する。原因が残った状態で起動を繰り返したり、DBを自動復元したりしない。

検証後、start-limit counterを解除して起動する。`reset-failed`は原因調査前に実行しない。

```bash
sudo systemctl reset-failed alt-notify.service
sudo systemctl start alt-notify.service
systemctl is-active alt-notify.service
sudo journalctl -u alt-notify.service --no-pager | grep '"message":"gateway ready"' | tail -1
```

Gateway readyが今回の起動に対応することを時刻で確認し、DBのmain/linkとpending/processing/failed件数を確認する。起動時に処理中キューはpendingへ戻るため、サービスが安定した後に重複送信の有無も確認する。

## Gateway切断・通知が届かない

1. `journalctl`で`gateway disconnected`、`gateway reconnecting`、`gateway ready`を時系列で確認する。
2. Oracleから外向きHTTPS疎通とDNSを確認する。
3. Discord Developer PortalでBotのトークン状態とIntent設定を確認する。
4. `/admin-stats`でGateway、pending、failedを確認する。

Gateway切断中に発生したDiscordイベントは回収できない場合がある。既存キューの再送を目的にDBを直接編集しない。

## SQLite整合性エラー

1. 直ちに`systemctl stop alt-notify.service`。
2. 元DBを別名へ退避し、先にバックアップを取得する。
3. `PRAGMA integrity_check`を停止中のコピーに対して実行する。
4. 最新の整合性確認済みバックアップを復元し、DBの存在・非空・整合性と所有者・権限を再確認する。
5. `sudo systemctl reset-failed alt-notify.service`の後に`sudo systemctl start alt-notify.service`。
6. active、今回の起動のGateway ready、main/link、pending/processing/failed、通知テストを確認する。

復元判断がつかない場合はサービスを停止したままにし、DBを上書きしない。

## Botトークン漏えい

これはP0として扱う。Discord Developer PortalでBot TokenをResetし、旧トークンを無効化する。新トークンを`/etc/altnoti.env`へ安全に反映し、権限を`root:altnoti 640`へ戻してsystemdを再起動する。Git、ログ、バックアップ、チャットにトークンが残っていないか確認し、外部へ流出した可能性があれば関係者へ通知する。値そのものを確認表示しない。

更新は`deploy/rotate-token.ps1`を使う。Tokenを引数、環境変数、チャットに置かない。設定更新失敗時は旧環境の復元だけでなく、サービス再起動とGateway readyまで検証する。旧TokenがReset済みなら復元後も接続できない可能性があるため、`rollback failed; manual intervention required`を復旧済みと扱わない。

## 外部heartbeat停止

Healthchecksの期限切れは、VM停止、Gateway切断、またはBotプロセス停止の候補である。OracleへSSH接続できる場合はsystemd、Gatewayログ、pending/processing/failed件数を確認する。Gatewayがreadyでもキュー閾値超過や失敗増加時は`/fail`通知を送るため、Discord側の通知障害と区別して調査する。heartbeat URLは秘密情報として扱い、ログに出さない。

## 誤通知・通知停止

- 連携解除または`/watch off`が送信直前の認可で反映されるか確認する。
- サブアカウントが対象サーバーのメンバーか、Botが対象チャンネルを閲覧できるか確認する。
- `notification_queue`の`pending`、`processing`、`failed`件数だけを確認する。
- 重複が疑われる場合は送信時刻とqueue IDを記録し、DBを直接削除せずサービスを停止して調査する。

## ロールバック

コードのみのロールバックは、現行DBをバックアップしてから実施する。スキーマ変更を含むため、旧ビルドへ戻す前に旧版が`channel_id`列を扱えるか確認する。TokenやDBを削除・初期化せず、systemdの停止→バックアップ→配置→起動→確認の順を守る。
