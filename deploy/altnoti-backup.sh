#!/usr/bin/env bash
set -euo pipefail

db_path=/var/lib/altnoti/discord-alt-notify.sqlite
backup_dir=/var/lib/altnoti/backups
state_helper=/usr/local/lib/altnoti/privacy-deletion-state.mjs
timestamp=$(date -u +%Y%m%d-%H%M%S)
backup_path="$backup_dir/discord-alt-notify-$timestamp.sqlite"
temporary_path="$backup_path.tmp"
mode=${1:-normal}
[[ $# -le 1 && ( $mode == normal || $mode == --privacy-finalize ) ]] || { echo 'invalid backup mode' >&2; exit 2; }

# The same lock brackets delete-epoch advancement and each snapshot. A regular
# timer run must never relabel pre-delete data with a newer privacy generation.
exec 9>/run/lock/altnoti-backup.lock
flock -x 9

state_json=$(node "$state_helper" status)
privacy_pending=$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).cleanupPending))' "$state_json")
database_deleted=$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).databaseDeleted))' "$state_json")
# A timer must not complete privacy maintenance behind the fixed artifact
# cleanup step in altnoti-privacy finish.
if [[ $privacy_pending == true && ( $database_deleted != true || $mode != --privacy-finalize ) ]]; then
  echo 'privacy deletion maintenance pending' >&2
  exit 1
fi
if [[ $mode == --privacy-finalize && $privacy_pending != true ]]; then
  exit 0
fi

retention_cutoff=$(date -u -d '14 days ago' +%Y%m%d%H%M%S)
install -d -o root -g root -m 700 "$backup_dir"
[[ -f $db_path && ! -L $db_path && -s $db_path ]] || { echo 'production database unavailable' >&2; exit 1; }
[[ ! -e $backup_path && ! -e $temporary_path ]] || { echo 'backup destination already exists' >&2; exit 1; }

check_integrity() {
  python3 - "$1" <<'PY'
import sqlite3
import sys
connection = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
try:
    if connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
        raise SystemExit(1)
    required = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if not {"main_accounts", "account_links", "notification_queue"}.issubset(required):
        raise SystemExit(1)
finally:
    connection.close()
PY
}

check_integrity "$db_path"
cp --reflink=auto --preserve=mode,ownership,timestamps "$db_path" "$temporary_path"
chmod 600 "$temporary_path"
check_integrity "$temporary_path"
mv -n "$temporary_path" "$backup_path"
[[ -f $backup_path && ! -e $temporary_path ]] || { echo 'atomic backup save failed' >&2; exit 1; }

# The manifest is written only after the SQLite copy is independently opened
# and checked; it contains no user or message identifiers.
node "$state_helper" record "${backup_path##*/}" >/dev/null
if [[ $mode == --privacy-finalize ]]; then
  : # The caller checks unmanaged artifacts before clearing the pending epoch.
else
  node "$state_helper" prune >/dev/null
fi
echo "backup created: $backup_path"
