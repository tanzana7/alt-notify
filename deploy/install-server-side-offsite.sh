#!/usr/bin/env bash
set -euo pipefail

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo 'root is required' >&2; exit 1; }
repo=${1:-/opt/altnoti}
env_file=/etc/altnoti-offsite/r2.env
key_file=/etc/altnoti-offsite/backup.key
[[ -d $repo && -f $repo/deploy/oracle-offsite-backup.mjs ]] || { echo 'application deployment is incomplete' >&2; exit 1; }
[[ -f $env_file ]] || { echo 'R2 credential file is not installed' >&2; exit 1; }
[[ -f $key_file ]] || { echo 'independent offsite encryption key is not installed' >&2; exit 1; }

for secret_file in "$env_file" "$key_file"; do
  permissions=$(stat -c '%U:%G %a' "$secret_file")
  [[ $permissions == 'root:root 600' || $permissions == 'root:root 400' ]] || { echo 'offsite secret permissions invalid' >&2; exit 1; }
done
grep -Eq '^ALTN_R2_ENDPOINT=https://[^[:space:]]+$' "$env_file" || { echo 'R2 endpoint missing' >&2; exit 1; }
for variable in ALTN_R2_BUCKET ALTN_R2_ACCESS_KEY_ID ALTN_R2_SECRET_ACCESS_KEY; do
  grep -Eq "^${variable}=.+$" "$env_file" || { echo 'R2 credential incomplete' >&2; exit 1; }
done
[[ $(wc -c < "$key_file") -eq 32 ]] || { echo 'offsite encryption key invalid' >&2; exit 1; }
install -d -o root -g root -m 755 /usr/local/lib/altnoti
install -o root -g root -m 755 "$repo/deploy/altnoti-offsite-backup.sh" /usr/local/sbin/altnoti-offsite-backup
install -o root -g root -m 644 "$repo/deploy/altnoti-offsite-backup.service" /etc/systemd/system/altnoti-offsite-backup.service
install -o root -g root -m 644 "$repo/deploy/altnoti-offsite-backup.timer" /etc/systemd/system/altnoti-offsite-backup.timer
systemctl daemon-reload
systemctl enable altnoti-offsite-backup.timer >/dev/null
echo 'server-side offsite backup installed; timer not started'
