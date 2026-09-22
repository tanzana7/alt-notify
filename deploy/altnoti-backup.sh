#!/usr/bin/env bash
set -euo pipefail

db_path=/var/lib/altnoti/discord-alt-notify.sqlite
backup_dir=/var/lib/altnoti/backups
timestamp=$(date -u +%Y%m%d-%H%M%S)
backup_path="$backup_dir/discord-alt-notify-$timestamp.sqlite"
temporary_path="$backup_path.tmp"

install -d -o root -g root -m 700 "$backup_dir"
if [[ ! -f "$db_path" ]]; then
  echo "database not found: $db_path" >&2
  exit 1
fi

# The application persists atomically, so copying a stable inode gives the
# backup job a consistent file without stopping the Gateway process.
cp --reflink=auto --preserve=mode,ownership,timestamps "$db_path" "$temporary_path"
chmod 600 "$temporary_path"
mv -f "$temporary_path" "$backup_path"

# Keep the newest seven local recovery points. Off-host encrypted replication
# remains an operator-controlled step because it requires an external target.
mapfile -t old_backups < <(find "$backup_dir" -maxdepth 1 -type f -name 'discord-alt-notify-*.sqlite' -printf '%T@ %p\n' | sort -rn | awk 'NR > 7 { sub(/^[^ ]+ /, ""); print }')
if ((${#old_backups[@]} > 0)); then
  rm -f -- "${old_backups[@]}"
fi
echo "backup created: $backup_path"
