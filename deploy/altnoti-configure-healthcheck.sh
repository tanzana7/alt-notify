#!/usr/bin/env bash
set -euo pipefail
umask 077

if ! systemctl is-active --quiet alt-notify.service; then
  echo 'service is not active; investigate before changing configuration' >&2
  exit 1
fi
recovery_dir=/var/backups/altnoti-config-recovery
recovery_copy="$recovery_dir/altnoti.env"
if [[ -e "$recovery_dir" || -L "$recovery_dir" ]]; then
  echo 'unresolved configuration recovery copy; manual intervention required' >&2
  exit 1
fi

url_file=$(mktemp /run/altnoti-healthcheck-url.XXXXXX)
old_env=$(mktemp /run/altnoti-env-before-healthcheck.XXXXXX)
new_env=$(mktemp /etc/altnoti.env.next-healthcheck.XXXXXX)
restart_needed=0
committed=0
recovery_created=0
rollback_verified=0
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
      if [[ -n "$invocation_id" ]] && journalctl "_SYSTEMD_INVOCATION_ID=$invocation_id" --output=cat --no-pager 2>/dev/null | awk '
        /"message":"gateway (ready|connected|disconnected|reconnecting)"/ {
          if (/"message":"gateway (ready|connected)"/) latest="ready";
          else latest="unready";
        }
        END { exit(latest == "ready" ? 0 : 1) }
      '; then
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
  # The helper reads the URL from a root-only file and never prints its value.
  /usr/bin/node /usr/local/lib/altnoti/probe-heartbeat.mjs "$url_file"
}
rollback() {
  local stop_failed=0
  systemctl stop alt-notify.service >/dev/null 2>&1 || stop_failed=1
  local restore_env
  restore_env=$(mktemp /etc/altnoti.env.restore.XXXXXX) || return 1
  if ! (cp -p "$recovery_copy" "$restore_env" && chown root:altnoti "$restore_env" && chmod 640 "$restore_env" && mv -f "$restore_env" /etc/altnoti.env); then
    rm -f -- "$restore_env"
    return 1
  fi
  cmp -s "$recovery_copy" /etc/altnoti.env || return 1
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
      rollback_verified=1
      echo 'rollback succeeded' >&2
    else
      echo 'rollback failed; manual intervention required' >&2
    fi
    result=1
  fi
  if (( recovery_created && (committed || rollback_verified || !restart_needed) )); then
    if ! (rm -f -- "$recovery_copy" && rmdir -- "$recovery_dir"); then
      echo 'configuration recovery copy cleanup failed; manual intervention required' >&2
      result=1
    fi
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
mkdir -m 700 -- "$recovery_dir"
recovery_created=1
chown root:root "$recovery_dir"
chmod 700 "$recovery_dir"
cp -p /etc/altnoti.env "$recovery_copy"
chown root:root "$recovery_copy"
chmod 600 "$recovery_copy"
cmp -s /etc/altnoti.env "$recovery_copy"
[[ $(stat -c '%U:%G %a' "$recovery_dir") == 'root:root 700' ]]
[[ $(stat -c '%U:%G %a' "$recovery_copy") == 'root:root 600' ]]
sync -f "$recovery_copy"
sync -f "$recovery_dir"
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
