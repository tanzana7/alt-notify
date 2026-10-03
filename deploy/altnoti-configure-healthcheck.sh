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
  local started_at=$1
  for attempt in $(seq 1 60); do
    if systemctl is-active --quiet alt-notify.service && journalctl -u alt-notify.service --since "$started_at" --output=cat | grep -F '"message":"gateway ready"' >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
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
  local started_at
  started_at=$(date --iso-8601=ns) || return 1
  systemctl start alt-notify.service >/dev/null 2>&1 || return 1
  wait_gateway_ready "$started_at" || return 1
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
started_at=$(date --iso-8601=ns)
systemctl reset-failed alt-notify.service
if ! systemctl start alt-notify.service; then
  echo 'new service start failed' >&2
  exit 1
fi
if ! wait_gateway_ready "$started_at"; then
  echo 'gateway ready not confirmed for new configuration' >&2
  exit 1
fi
committed=1
echo 'healthcheck configured; gateway ready'
