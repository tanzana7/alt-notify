# Cloudflare R2 offsite backup format

現行のオフサイトバックアップは、Oracle VM上で作成したSQLiteバックアップを暗号化し、非公開のCloudflare R2バケットへ保存する。Windows PCはruntime経路に含まれない。

## 暗号化形式

形式バージョンは`ALTNENC1` / version 1。ファイル名はUTCのOracle snapshot名に`.enc`を付けたもの。アップロード中の`.uploading`は最終世代として扱わない。

バイナリ構成は次のとおり。

1. 8-byte magic `ALTNENC1`
2. 4-byte big-endian header length
3. AES-GCM additional dataとして認証するUTF-8 JSON header。形式、UTC作成時刻（Unix milliseconds）、privacy generation、ランダムな96-bit nonceだけを含む
4. AES-256-GCM ciphertext。SQLite bytesと、`ALTNEND1`、元サイズ、平文SQLiteのSHA-256を含む暗号化trailerを含む
5. 16-byte GCM authentication tag

暗号鍵は32-byteのランダム値で、Oracle VMの`/etc/altnoti-offsite/backup.key`にroot-onlyで保存する。VMとは独立した復旧用コピーはWindows DPAPI保護下の`C:\Users\user\CodexRecovery\altnoti-offsite-key.dpapi`へ保管し、backupと同じ場所には置かない。R2 credentialも`/etc/altnoti-offsite/r2.env`のroot-onlyファイルにのみ置く。

## 検証と保持

Oracle側の処理は、整合性確認済みartifactを暗号化して一時objectへuploadし、サイズ・metadata・SHA-256を確認する。その後R2からdownload、復号、別DBへのrestore drill、SQLite integrity、schema、privacy generation一致を確認し、全て成功した場合だけ正式objectとstatus `ok`を確定する。

正式objectは最新14世代かつ30日以内を基本に整理する。削除前世代はprivacy generationが一致しないためrestore候補にしない。最新の安全なcurrent-generation世代を1件も残せない場合、cleanupと成功記録を失敗させる。

## 復旧時の注意

この形式は一般用途のアーカイブではない。headerや暗号化形式を編集せず、現行の復元検証手順を通してからimportする。restoreは必ず本番DBとは別の一時DBで行い、active DBへ上書きしない。R2 bucketはprivateのままにし、object keyにDiscord ID、username、Guild名、hostname、tokenを含めない。
