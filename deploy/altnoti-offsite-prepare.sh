#!/usr/bin/env bash
set -euo pipefail

backup_dir=/var/lib/altnoti/backups
db_path=/var/lib/altnoti/discord-alt-notify.sqlite
staging_dir=/home/ubuntu/.altnoti-offsite-staging

if [[ ${1:-} == cleanup ]]; then
  backup_name=${2:-}
  [[ $backup_name =~ ^discord-alt-notify-[0-9]{8}-[0-9]{6}\.sqlite$ ]] || exit 2
  rm -f -- "$staging_dir/$backup_name"
  exit 0
fi
[[ $# -eq 0 ]] || exit 2

check_integrity() {
  python3 - "$1" <<'PY'
import sqlite3
import sys

connection = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
try:
    if connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
        raise SystemExit(1)
finally:
    connection.close()
PY
}

[[ -s $db_path ]] && check_integrity "$db_path" || { echo 'production database integrity failed' >&2; exit 1; }
systemctl start altnoti-backup.service
mapfile -t backup_names < <(find "$backup_dir" -maxdepth 1 -type f -regextype posix-extended -regex '.*/discord-alt-notify-[0-9]{8}-[0-9]{6}\.sqlite' -printf '%f\n' | LC_ALL=C sort -r)
((${#backup_names[@]} > 0)) || { echo 'no backup found' >&2; exit 1; }
backup_name=${backup_names[0]}
backup_path="$backup_dir/$backup_name"
check_integrity "$backup_path" || { echo 'backup integrity failed' >&2; exit 1; }
remote_hash=$(sha256sum "$backup_path")
remote_hash=${remote_hash%% *}

# scp cannot read the root-only backup directory. Expose one validated copy
# only to ubuntu in a 0700 staging directory; the caller cleans it up after
# checksum and SQLite verification on Windows.
install -d -o ubuntu -g ubuntu -m 700 "$staging_dir"
find "$staging_dir" -maxdepth 1 -type f -name 'discord-alt-notify-*.sqlite' -mtime +1 -delete
install -o ubuntu -g ubuntu -m 600 "$backup_path" "$staging_dir/$backup_name"
staged_hash=$(sha256sum "$staging_dir/$backup_name")
[[ ${staged_hash%% *} == "$remote_hash" ]] || { rm -f -- "$staging_dir/$backup_name"; echo 'staging hash mismatch' >&2; exit 1; }
printf '%s %s\n' "$backup_name" "$remote_hash"
