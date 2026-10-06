# Windows offsite backup format

Current format version is `ALTNENC1` / version 1. A backup filename is the UTC Oracle snapshot name followed by `.enc`; staging uses `.enc.partial` and is never treated as a restorable final.

The binary layout is:

1. 8-byte magic `ALTNENC1`
2. 4-byte big-endian header length
3. UTF-8 JSON header, authenticated as AES-GCM additional data. It contains only format version, UTC creation time in Unix milliseconds, privacy generation, and a random 96-bit nonce.
4. AES-256-GCM ciphertext: SQLite bytes followed by an encrypted trailer containing `ALTNEND1`, original byte length, and SHA-256 of the plaintext SQLite bytes
5. 16-byte GCM authentication tag

The encryption key is 32 random bytes. Only a DPAPI CurrentUser-protected blob is written to `%LOCALAPPDATA%\AltNotify\keys\offsite-backup-key.dpapi`; ACL checks require the current Windows user and SYSTEM only. The key file is separate from the backup directory. Losing the Windows profile/DPAPI key makes that profile's encrypted copies unreadable; Oracle copies remain an independent recovery source. No Oracle-hosted secondary decryption key is used: letting the VM decrypt offsite copies would defeat the separation. If the Windows profile is lost but Oracle survives, restore from the current-generation Oracle backup and establish a new Windows key for future offsite copies. If both profile/key and Oracle copies are lost, existing Windows ciphertext is not recoverable. A separately protected recovery path for that simultaneous-loss case remains a v1.0 decision, not a claimed beta capability.

The pull process streams SSH binary stdout into the AES-GCM encryptor and writes only ciphertext to `.enc.partial`. It compares the streamed plaintext SHA-256 with Oracle's manifest before completing the GCM tag, then authenticates/decrypts in memory and runs SQLite integrity, production schema preflight/migration, and application-service initialization without creating a plaintext DB file. Only after that drill succeeds is the encrypted file renamed to final. Existing plaintext `.sqlite` copies are removed after the new encrypted final is verified. On any earlier failure, they remain; partial ciphertext is removed.

Before encrypted final is pruned, the process confirms at least one authenticated, integrity-checked current privacy-generation copy remains. It then retains up to 14 generations within 30 days, while keeping the newest safe copy even if older than 30 days. Old privacy generations are never accepted by the restore helper and are removed on the next successful online cleanup. An offline Windows PC cannot physically delete its local files until it next runs.

This is a private operational format, not a general-purpose archival format. Do not edit headers, move the DPAPI key into the backup directory, or import a backup unless `deploy/verify-offsite-backup.mjs` succeeds against the current privacy state.
