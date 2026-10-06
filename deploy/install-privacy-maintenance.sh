#!/usr/bin/env bash
set -euo pipefail
stage=/home/ubuntu/.altnoti-deploy-stage
[[ -d $stage && ! -L $stage ]] || { echo 'deployment stage unavailable' >&2; exit 1; }

for file in privacy-deletion-state.mjs oracle-artifact-cleanup.mjs altnoti-backup.sh altnoti-backup.service altnoti-privacy.sh altnoti-privacy-finish.service altnoti-privacy.sudoers alt-notify-privacy-sudo.conf; do
  [[ -f $stage/$file && ! -L $stage/$file ]] || { echo 'deployment file missing or invalid' >&2; exit 1; }
done

install -d -o root -g root -m 755 /usr/local/lib/altnoti
install -d -o root -g altnoti -m 750 /var/lib/altnoti-monitoring
install -o root -g root -m 755 "$stage/privacy-deletion-state.mjs" /usr/local/lib/altnoti/privacy-deletion-state.mjs
install -o root -g root -m 755 "$stage/oracle-artifact-cleanup.mjs" /usr/local/lib/altnoti/oracle-artifact-cleanup.mjs
install -o root -g root -m 755 "$stage/altnoti-backup.sh" /usr/local/sbin/altnoti-backup
install -o root -g root -m 755 "$stage/altnoti-privacy.sh" /usr/local/sbin/altnoti-privacy
install -o root -g root -m 644 "$stage/altnoti-backup.service" /etc/systemd/system/altnoti-backup.service
install -o root -g root -m 644 "$stage/altnoti-privacy-finish.service" /etc/systemd/system/altnoti-privacy-finish.service
install -o root -g root -m 440 "$stage/altnoti-privacy.sudoers" /etc/sudoers.d/altnoti-privacy
visudo -cf /etc/sudoers.d/altnoti-privacy
install -d -o root -g root -m 755 /etc/systemd/system/alt-notify.service.d
install -o root -g root -m 644 "$stage/alt-notify-privacy-sudo.conf" /etc/systemd/system/alt-notify.service.d/30-privacy-sudo.conf
node /usr/local/lib/altnoti/privacy-deletion-state.mjs initialize >/dev/null
systemctl daemon-reload
stat -c '%U:%G %a' /var/lib/altnoti-monitoring
stat -c '%U:%G %a' /var/lib/altnoti-monitoring/privacy-deletion-state.json
