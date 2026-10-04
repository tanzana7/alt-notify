#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT

db_path="$scratch/database.sqlite"
backup_dir="$scratch/backups"
mkdir -p "$backup_dir"
printf 'fixture database\n' > "$db_path"
touch -t 202001010000 "$db_path"
for day in {01..09}; do
  backup="$backup_dir/discord-alt-notify-202601${day}-120000.sqlite"
  printf 'historical backup\n' > "$backup"
  touch -t 202001010000 "$backup"
done
printf 'unfinished\n' > "$backup_dir/discord-alt-notify-20260110-120000.sqlite.tmp"
printf 'unrelated\n' > "$backup_dir/keep-me.sqlite"
printf 'unexpected name\n' > "$backup_dir/discord-alt-notify-INVALID.sqlite"

# Exercise the production algorithm with only fixture paths/ownership changed.
sed -e "s@/var/lib/altnoti/discord-alt-notify.sqlite@$db_path@g" \
  -e "s@/var/lib/altnoti/backups@$backup_dir@g" \
  -e 's/install -d -o root -g root -m 700/mkdir -p/' \
  "$repo_root/deploy/altnoti-backup.sh" > "$scratch/backup.sh"

bash "$scratch/backup.sh" >/dev/null
mapfile -t retained < <(find "$backup_dir" -maxdepth 1 -type f -regextype posix-extended -regex '.*/discord-alt-notify-[0-9]{8}-[0-9]{6}\.sqlite' -printf '%f\n' | LC_ALL=C sort)
[[ ${#retained[@]} -eq 7 ]] || { echo 'backup retention count failed' >&2; exit 1; }
for day in {01..03}; do
  [[ ! -e "$backup_dir/discord-alt-notify-202601${day}-120000.sqlite" ]] || { echo 'old backup retained' >&2; exit 1; }
done
for day in {04..09}; do
  [[ -f "$backup_dir/discord-alt-notify-202601${day}-120000.sqlite" ]] || { echo 'new backup deleted' >&2; exit 1; }
done
[[ -f "$backup_dir/discord-alt-notify-20260110-120000.sqlite.tmp" && -f "$backup_dir/keep-me.sqlite" && -f "$backup_dir/discord-alt-notify-INVALID.sqlite" ]] || { echo 'unrelated file deleted' >&2; exit 1; }
[[ -s "$backup_dir/${retained[6]}" ]] || { echo 'new backup missing' >&2; exit 1; }

rm -f -- "$db_path"
if bash "$scratch/backup.sh" >/dev/null 2>&1; then
  echo 'missing database accepted' >&2
  exit 1
fi
echo 'PASS backup retention and missing database'
