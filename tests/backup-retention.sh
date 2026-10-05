#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT

db_path="$scratch/database.sqlite"
backup_dir="$scratch/backups"
today=$(date -u +%Y%m%d)
stamps=()
mkdir -p "$backup_dir"
printf 'fixture database\n' > "$db_path"
touch -t 202001010000 "$db_path"
for age in 1 2 3 4 5 6 7 21 22; do
  stamp=$(date -u -d "$age days ago" +%Y%m%d-%H%M%S)
  stamps+=("$stamp")
  backup="$backup_dir/discord-alt-notify-$stamp.sqlite"
  printf 'historical backup\n' > "$backup"
  touch -t 202001010000 "$backup"
done
printf 'unfinished\n' > "$backup_dir/discord-alt-notify-${today}-000000.sqlite.tmp"
printf 'unrelated\n' > "$backup_dir/keep-me.sqlite"
printf 'unexpected name\n' > "$backup_dir/discord-alt-notify-INVALID.sqlite"
printf 'impossible date\n' > "$backup_dir/discord-alt-notify-20261399-999999.sqlite"

# Exercise the production algorithm with only fixture paths/ownership changed.
sed -e "s@/var/lib/altnoti/discord-alt-notify.sqlite@$db_path@g" \
  -e "s@/var/lib/altnoti/backups@$backup_dir@g" \
  -e 's/install -d -o root -g root -m 700/mkdir -p/' \
  "$repo_root/deploy/altnoti-backup.sh" > "$scratch/backup.sh"

bash "$scratch/backup.sh" >/dev/null
mapfile -t retained < <(find "$backup_dir" -maxdepth 1 -type f -regextype posix-extended -regex '.*/discord-alt-notify-[0-9]{8}-[0-9]{6}\.sqlite' -printf '%f\n' | grep -v '20261399-999999' | LC_ALL=C sort)
[[ ${#retained[@]} -eq 7 ]] || { echo 'backup retention count failed' >&2; exit 1; }
for index in 6 7 8; do
  [[ ! -e "$backup_dir/discord-alt-notify-${stamps[$index]}.sqlite" ]] || { echo 'expired backup retained' >&2; exit 1; }
done
for index in 0 1 2 3 4 5; do
  [[ -f "$backup_dir/discord-alt-notify-${stamps[$index]}.sqlite" ]] || { echo 'valid backup deleted' >&2; exit 1; }
done
[[ -f "$backup_dir/discord-alt-notify-${today}-000000.sqlite.tmp" && -f "$backup_dir/keep-me.sqlite" && -f "$backup_dir/discord-alt-notify-INVALID.sqlite" && -f "$backup_dir/discord-alt-notify-20261399-999999.sqlite" ]] || { echo 'unrelated file deleted' >&2; exit 1; }
[[ -s "$backup_dir/${retained[6]}" ]] || { echo 'new backup missing' >&2; exit 1; }

rm -f -- "$db_path"
if bash "$scratch/backup.sh" >/dev/null 2>&1; then
  echo 'missing database accepted' >&2
  exit 1
fi
echo 'PASS backup retention and missing database'
