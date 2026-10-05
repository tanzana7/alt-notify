#!/usr/bin/env bash
set -euo pipefail

db_path=/var/lib/altnoti/discord-alt-notify.sqlite
backup_dir=/var/lib/altnoti/backups
timestamp=$(date -u +%Y%m%d-%H%M%S)
backup_path="$backup_dir/discord-alt-notify-$timestamp.sqlite"
temporary_path="$backup_path.tmp"
retention_cutoff=$(date -u -d '14 days ago' +%Y%m%d%H%M%S)

install -d -o root -g root -m 700 "$backup_dir"
if [[ ! -f "$db_path" ]]; then
  echo "database not found: $db_path" >&2
  exit 1
fi
if [[ -e "$backup_path" || -e "$temporary_path" ]]; then
  echo "backup destination already exists" >&2
  exit 1
fi

# The application persists atomically, so copying a stable inode gives the
# backup job a consistent file without stopping the Gateway process.
cp --reflink=auto --preserve=mode,ownership,timestamps "$db_path" "$temporary_path"
chmod 600 "$temporary_path"
mv -f "$temporary_path" "$backup_path"

# The copied DB retains the source mtime. During quiet periods, every backup
# can have the same mtime, so generation order must come from our UTC filename.
# Ignore temporary and unexpected names rather than deleting unknown files.
generation=0
while IFS= read -r backup_name; do
  stamp=${backup_name#discord-alt-notify-}
  stamp=${stamp%.sqlite}
  canonical=$(date -u -d "${stamp:0:8} ${stamp:9:2}:${stamp:11:2}:${stamp:13:2}" +%Y%m%d-%H%M%S 2>/dev/null || true)
  # Ignore impossible calendar dates as well as unexpected names: retention
  # must never turn a malformed file into a deletion target.
  [[ $canonical == "$stamp" ]] || continue
  sortable=${stamp//-/}
  if [[ $sortable < $retention_cutoff ]] || ((generation >= 7)); then
    rm -f -- "$backup_dir/$backup_name"
  else
    ((generation += 1))
  fi
done < <(find "$backup_dir" -maxdepth 1 -type f -regextype posix-extended -regex '.*/discord-alt-notify-[0-9]{8}-[0-9]{6}\.sqlite' -printf '%f\n' | LC_ALL=C sort -r)
echo "backup created: $backup_path"
