#!/usr/bin/env bash
set -euo pipefail
umask 077

if ! systemctl is-active --quiet alt-notify.service; then
  echo 'service is not active; investigate before changing configuration' >&2
  exit 1
fi

url_file=$(mktemp /run/altnoti-healthcheck-url.XXXXXX)
old_env=$(mktemp /run/altnoti-env-before-healthcheck.XXXXXX)
new_env=$(mktemp /etc/altnoti.env.next-healthcheck.XXXXXX)
restart_needed=0
committed=0
cleanup() {
  local file
  for file in "$url_file" "$old_env" "$new_env"; do
    [[ -e "$file" ]] || continue
    if command -v shred >/dev/null 2>&1; then
      shred -u "$file" || rm -f -- "$file"
    else
      rm -f -- "$file"
    fi
  done
}
wait_gateway_ready() {
  local invocation_id current_id
  for attempt in $(seq 1 60); do
    if systemctl is-active --quiet alt-notify.service; then
      invocation_id=$(systemctl show alt-notify.service --property=InvocationID --value) || invocation_id=''
      if [[ -n "$invocation_id" ]] && journalctl "_SYSTEMD_INVOCATION_ID=$invocation_id" --output=cat --no-pager 2>/dev/null | grep -F '"message":"gateway ready"' >/dev/null; then
        current_id=$(systemctl show alt-notify.service --property=InvocationID --value) || current_id=''
        if [[ "$current_id" == "$invocation_id" ]] && systemctl is-active --quiet alt-notify.service; then
          return 0
        fi
      fi
    fi
    sleep 1
  done
  return 1
}
probe_heartbeat() {
  # Read the secret URL from a root-only file; never place it in argv, logs, or errors.
  /usr/bin/node --input-type=module - "$url_file" <<'NODE'
import { readFile } from 'node:fs/promises';
async function probe() {
  const url = (await readFile(process.argv[2], 'utf8')).trim();
  if (!url.startsWith('https://')) return false;
  const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5_000) });
  return response.ok;
}
probe().then((accepted) => { process.exitCode = accepted ? 0 : 1; }, () => { process.exitCode = 1; });
NODE
}
rollback() {
  local stop_failed=0
  systemctl stop alt-notify.service >/dev/null 2>&1 || stop_failed=1
  local restore_env
  restore_env=$(mktemp /etc/altnoti.env.restore.XXXXXX) || return 1
  if ! (cp -p "$old_env" "$restore_env" && chown root:altnoti "$restore_env" && chmod 640 "$restore_env" && mv -f "$restore_env" /etc/altnoti.env); then
    rm -f -- "$restore_env"
    return 1
  fi
  cmp -s "$old_env" /etc/altnoti.env || return 1
  [[ $(stat -c '%U:%G %a' /etc/altnoti.env) == 'root:altnoti 640' ]] || return 1
  systemctl reset-failed alt-notify.service >/dev/null 2>&1 || return 1
  systemctl start alt-notify.service >/dev/null 2>&1 || return 1
  wait_gateway_ready || return 1
  (( stop_failed == 0 ))
}
finish() {
  local result=$?
  trap - EXIT
  if (( restart_needed && !committed )); then
    if rollback; then
      echo 'rollback succeeded' >&2
    else
      echo 'rollback failed; manual intervention required' >&2
    fi
    result=1
  fi
  cleanup
  exit "$result"
}
trap finish EXIT

IFS= read -r url || true
url="${url%$'\r'}"
if [[ "$url" != https://* || "$url" =~ [[:space:]] ]]; then
  echo "healthcheck URL rejected" >&2
  exit 2
fi
printf '%s\n' "$url" > "$url_file"
cp -p /etc/altnoti.env "$old_env"
chown root:root "$old_env"
chmod 600 "$old_env"

awk -v url_file="$url_file" '
  BEGIN { getline url < url_file }
  /^HEALTHCHECKS_HEARTBEAT_URL=/ { print "HEALTHCHECKS_HEARTBEAT_URL=" url; found=1; next }
  { print }
  END { if (!found) print "HEALTHCHECKS_HEARTBEAT_URL=" url }
' /etc/altnoti.env > "$new_env"
chown root:altnoti "$new_env"
chmod 640 "$new_env"

systemctl start altnoti-backup.service
restart_needed=1
systemctl stop alt-notify.service
mv -f "$new_env" /etc/altnoti.env
systemctl reset-failed alt-notify.service
if ! systemctl start alt-notify.service; then
  echo 'new service start failed' >&2
  exit 1
fi
if ! wait_gateway_ready; then
  echo 'gateway ready not confirmed for new configuration' >&2
  exit 1
fi
if ! probe_heartbeat; then
  echo 'healthcheck endpoint probe failed' >&2
  exit 1
fi
committed=1
echo 'healthcheck configured; gateway ready'
