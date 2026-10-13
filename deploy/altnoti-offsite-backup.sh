#!/usr/bin/env bash
set -euo pipefail

exec 9>/run/lock/altnoti-offsite-backup.lock
flock -n 9 || { echo 'offsite backup already running' >&2; exit 1; }

# The local helper takes the same backup/privacy lock used by deletion
# maintenance. The R2 upload therefore always starts from a current,
# independently verified Oracle artifact and never reads the live database.
/usr/local/sbin/altnoti-backup
exec /usr/bin/node /opt/altnoti/deploy/oracle-offsite-backup.mjs
