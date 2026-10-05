#!/usr/bin/env bash
set -euo pipefail

backup_dir=/var/lib/altnoti/backups
db_path=/var/lib/altnoti/discord-alt-notify.sqlite
staging_dir=/home/ubuntu/.altnoti-offsite-staging
privacy_helper=/usr/local/lib/altnoti/privacy-deletion-state.mjs
status_helper=/usr/local/lib/altnoti/offsite-status.mjs

if [[ ${1:-} == cleanup ]]; then
  [[ $# -eq 2 && $2 =~ ^discord-alt-notify-[0-9]{8}-[0-9]{6}\.sqlite$ ]] || exit 2
  rm -f -- "$staging_dir/$2" "$staging_dir/$2.meta.json"
  exit 0
fi
if [[ ${1:-} == mark-failure ]]; then
  [[ $# -eq 2 ]] || exit 2
  exec node "$status_helper" mark-failure "$2"
fi
if [[ ${1:-} == mark-success ]]; then
  [[ $# -eq 4 && $2 =~ ^discord-alt-notify-[0-9]{8}-[0-9]{6}\.sqlite$ && $3 =~ ^[0-9a-f]{64}$ && $4 =~ ^[0-9]+$ ]] || exit 2
  name=$2 hash=$3 generation=$4
  stage="$staging_dir/$name"
  [[ -f $stage && ! -L $stage ]] || exit 1
  actual=$(sha256sum "$stage"); [[ ${actual%% *} == "$hash" ]] || exit 1
  verified=$(node "$privacy_helper" verify "$name")
  node -e 'const m=JSON.parse(process.argv[1]); if(m.sha256!==process.argv[2] || String(m.privacyGeneration)!==process.argv[3]) process.exit(1)' "$verified" "$hash" "$generation"
  state=$(node "$privacy_helper" status)
  node -e 'const s=JSON.parse(process.argv[1]); if(s.cleanupPending || String(s.generation)!==process.argv[2]) process.exit(1)' "$state" "$generation"
  exec node "$status_helper" mark-success "$generation"
fi
if [[ ${1:-} == status ]]; then
  [[ $# -eq 1 ]] || exit 2
  exec node "$status_helper" status
fi
[[ $# -eq 0 ]] || exit 2

[[ -s $db_path ]] || { echo 'production database unavailable' >&2; exit 1; }
state=$(node "$privacy_helper" status)
node -e 'const s=JSON.parse(process.argv[1]); if(s.cleanupPending) process.exit(1)' "$state"
systemctl start altnoti-backup.service
metadata=$(node "$privacy_helper" latest)
name=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).name)' "$metadata")
hash=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).sha256)' "$metadata")
generation=$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).privacyGeneration))' "$metadata")

install -d -o ubuntu -g ubuntu -m 700 "$staging_dir"
find "$staging_dir" -maxdepth 1 -type f -name 'discord-alt-notify-*.sqlite*' -mtime +1 -delete
source="$backup_dir/$name"
stage="$staging_dir/$name"
[[ -f $source && ! -L $source && ! -e $stage ]] || { echo 'backup staging source invalid' >&2; exit 1; }
install -o ubuntu -g ubuntu -m 600 "$source" "$stage"
actual=$(sha256sum "$stage"); [[ ${actual%% *} == "$hash" ]] || { rm -f -- "$stage"; echo 'staging hash mismatch' >&2; exit 1; }
created=$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).createdAt))' "$metadata")
printf '{"name":"%s","sha256":"%s","privacyGeneration":%s,"createdAt":%s}\n' "$name" "$hash" "$generation" "$created"
