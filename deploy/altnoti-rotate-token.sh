#!/usr/bin/env bash
set -euo pipefail
umask 077

if ! systemctl is-active --quiet alt-notify.service; then
  echo 'service is not active; investigate before changing configuration' >&2
  exit 1
fi
recovery_dir=/var/backups/altnoti-config-recovery
recovery_copy="$recovery_dir/altnoti.env"
# mkdir is exclusive: an unresolved copy must never be replaced by a new secret.
if [[ -e "$recovery_dir" || -L "$recovery_dir" ]]; then
  echo 'unresolved configuration recovery copy; manual intervention required' >&2
  exit 1
fi

token_file=$(mktemp /run/altnoti-token.XXXXXX)
old_env=$(mktemp /run/altnoti-env-before.XXXXXX)
new_env=$(mktemp /etc/altnoti.env.next.XXXXXX)
restart_needed=0
committed=0
recovery_created=0
rollback_verified=0
cleanup() {
  local file
  for file in "$token_file" "$old_env" "$new_env"; do
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
        # A restart between reading the journal and accepting ready must not validate an old process.
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
  # Once stopping begins, even a failed stop/swap must restore and verify the old service.
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

IFS= read -r token || true
token="${token%$'\r'}"
if [[ ${#token} -lt 50 || "$token" =~ [[:space:]] ]]; then
  echo "token input rejected" >&2
  exit 2
fi
printf '%s\n' "$token" > "$token_file"
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
# Flush the recoverable old configuration before stopping the running service.
sync -f "$recovery_copy"
sync -f "$recovery_dir"
cp -p /etc/altnoti.env "$old_env"
chown root:root "$old_env"
chmod 600 "$old_env"

awk -v token_file="$token_file" '
  BEGIN { getline token < token_file }
  /^DISCORD_TOKEN=/ { print "DISCORD_TOKEN=" token; found=1; next }
  { print }
  END { if (!found) print "DISCORD_TOKEN=" token }
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
committed=1
echo 'token rotation completed; gateway ready'
