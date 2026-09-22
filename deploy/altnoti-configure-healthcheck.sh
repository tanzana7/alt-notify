#!/usr/bin/env bash
set -euo pipefail
umask 077

url_file=$(mktemp /run/altnoti-healthcheck-url.XXXXXX)
old_env=$(mktemp /run/altnoti-env-before-healthcheck.XXXXXX)
new_env=$(mktemp /run/altnoti-env-next-healthcheck.XXXXXX)
cleanup() {
  command -v shred >/dev/null 2>&1 && shred -u "$url_file" "$old_env" "$new_env" || rm -f -- "$url_file" "$old_env" "$new_env"
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

IFS= read -r url || true
url="${url%$'\r'}"
if [[ "$url" != https://* || "$url" =~ [[:space:]] ]]; then
  echo "healthcheck URL rejected" >&2
  exit 2
fi
printf '%s\n' "$url" > "$url_file"
cp -p /etc/altnoti.env "$old_env"

awk -v url_file="$url_file" '
  BEGIN { getline url < url_file }
  /^HEALTHCHECKS_HEARTBEAT_URL=/ { print "HEALTHCHECKS_HEARTBEAT_URL=" url; found=1; next }
  { print }
  END { if (!found) print "HEALTHCHECKS_HEARTBEAT_URL=" url }
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
    echo "healthcheck configured; gateway ready"
    exit 0
  fi
  sleep 1
done

rollback
echo "healthcheck configuration failed; previous environment restored" >&2
exit 1
