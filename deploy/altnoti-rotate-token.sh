#!/usr/bin/env bash
set -euo pipefail
umask 077

token_file=$(mktemp /run/altnoti-token.XXXXXX)
old_env=$(mktemp /run/altnoti-env-before.XXXXXX)
new_env=$(mktemp /run/altnoti-env-next.XXXXXX)
cleanup() {
  command -v shred >/dev/null 2>&1 && shred -u "$token_file" "$old_env" "$new_env" || rm -f -- "$token_file" "$old_env" "$new_env"
}
rollback() {
  systemctl stop alt-notify.service >/dev/null 2>&1 || true
  local restore_env
  restore_env=$(mktemp /etc/altnoti.env.restore.XXXXXX)
  cp -p "$old_env" "$restore_env"
  chown root:altnoti "$restore_env"
  chmod 640 "$restore_env"
  mv -f "$restore_env" /etc/altnoti.env
  systemctl start alt-notify.service >/dev/null 2>&1 || true
}
trap cleanup EXIT

IFS= read -r token || true
token="${token%$'\r'}"
if [[ ${#token} -lt 50 || "$token" =~ [[:space:]] ]]; then
  echo "token input rejected" >&2
  exit 2
fi
printf '%s\n' "$token" > "$token_file"
cp -p /etc/altnoti.env "$old_env"

awk -v token_file="$token_file" '
  BEGIN { getline token < token_file }
  /^DISCORD_TOKEN=/ { print "DISCORD_TOKEN=" token; found=1; next }
  { print }
  END { if (!found) print "DISCORD_TOKEN=" token }
' /etc/altnoti.env > "$new_env"
chown root:altnoti "$new_env"
chmod 640 "$new_env"

systemctl start altnoti-backup.service
systemctl stop alt-notify.service
mv -f "$new_env" /etc/altnoti.env
started_at=$(date --iso-8601=seconds)
systemctl start alt-notify.service

for attempt in $(seq 1 60); do
  if systemctl is-active --quiet alt-notify.service && journalctl -u alt-notify.service --since "$started_at" --output=cat | grep -Fq '"message":"gateway ready"'; then
    echo "token rotation completed; gateway ready"
    exit 0
  fi
  sleep 1
done

rollback
echo "token rotation failed; previous environment restored" >&2
exit 1
