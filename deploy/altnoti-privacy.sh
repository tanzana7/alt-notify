#!/usr/bin/env bash
set -euo pipefail

state_helper=/usr/local/lib/altnoti/privacy-deletion-state.mjs
artifact_helper=/usr/local/lib/altnoti/oracle-artifact-cleanup.mjs
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
    systemctl start --wait altnoti-privacy-finish.service
    # Reacquire the backup lock across artifact cleanup and state completion;
    # neither a timer backup nor another deletion may interleave here.
    exec flock -x /run/lock/altnoti-backup.lock bash -c '
      node /usr/local/lib/altnoti/oracle-artifact-cleanup.mjs cleanup >/dev/null
      node /usr/local/lib/altnoti/privacy-deletion-state.mjs complete >/dev/null
    '
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
