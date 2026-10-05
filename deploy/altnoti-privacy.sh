#!/usr/bin/env bash
set -euo pipefail

state_helper=/usr/local/lib/altnoti/privacy-deletion-state.mjs
case ${1:-} in
  begin)
    [[ $# -eq 1 ]] || exit 2
    exec flock -x /run/lock/altnoti-backup.lock node "$state_helper" begin >/dev/null
    ;;
  finish)
    [[ $# -eq 1 ]] || exit 2
    state_json=$(node "$state_helper" status)
    pending=$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).cleanupPending))' "$state_json")
    database_deleted=$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).databaseDeleted))' "$state_json")
    [[ $pending == true ]] || exit 0
    [[ $database_deleted == true ]] || { echo 'active database deletion not confirmed' >&2; exit 1; }
    exec systemctl start --wait altnoti-privacy-finish.service
    ;;
  database-deleted)
    [[ $# -eq 1 ]] || exit 2
    exec flock -x /run/lock/altnoti-backup.lock node "$state_helper" database-deleted >/dev/null
    ;;
  status)
    [[ $# -eq 1 ]] || exit 2
    exec node "$state_helper" status
    ;;
  *) exit 2 ;;
esac
