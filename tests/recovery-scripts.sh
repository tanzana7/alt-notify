#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT

fail() { echo "recovery script test failed: $1" >&2; exit 1; }

for script_name in altnoti-rotate-token.sh altnoti-configure-healthcheck.sh; do
  for scenario in start_fail ready_timeout start_limit reset_fail stop_fail backup_fail rollback_fail success inactive; do
    case_dir=$(mktemp -d "$scratch/case.XXXXXX")
    mkdir "$case_dir/bin"
    printf 'DISCORD_TOKEN=old-fixture\nHEALTHCHECKS_HEARTBEAT_URL=https://old.invalid/fixture\n' > "$case_dir/env"
    cp "$case_dir/env" "$case_dir/original"
    printf 'active\n' > "$case_dir/service_state"
    printf '0\n' > "$case_dir/start_count"
    printf '0\n' > "$case_dir/reset_count"
    printf '0\n' > "$case_dir/stop_count"
    : > "$case_dir/log"

    # Only the test copy receives fixture paths and a short readiness deadline.
    sed -e "s@/etc/altnoti.env@$case_dir/env@g" \
      -e "s@/run/altnoti-@$case_dir/altnoti-@g" \
      -e 's@seq 1 60@seq 1 2@g' \
      -e 's@sleep 1@sleep 0@g' \
      "$repo_root/deploy/$script_name" > "$case_dir/script.sh"

    cat > "$case_dir/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$TEST_STATE_DIR/log"
case "$1" in
  is-active)
    [[ "$TEST_SCENARIO" != inactive && $(cat "$TEST_STATE_DIR/service_state") == active ]]
    ;;
  reset-failed)
    n=$(cat "$TEST_STATE_DIR/reset_count"); printf '%s\n' "$((n+1))" > "$TEST_STATE_DIR/reset_count"
    if [[ "$TEST_SCENARIO" == reset_fail && "$n" -eq 0 ]]; then exit 1; fi
    ;;
  stop)
    n=$(cat "$TEST_STATE_DIR/stop_count"); printf '%s\n' "$((n+1))" > "$TEST_STATE_DIR/stop_count"
    if [[ "$TEST_SCENARIO" == stop_fail && "$n" -eq 0 ]]; then exit 1; fi
    printf 'inactive\n' > "$TEST_STATE_DIR/service_state"
    ;;
  start)
    if [[ "$2" == altnoti-backup.service ]]; then
      [[ "$TEST_SCENARIO" != backup_fail ]]
      exit $?
    fi
    n=$(cat "$TEST_STATE_DIR/start_count"); n=$((n+1)); printf '%s\n' "$n" > "$TEST_STATE_DIR/start_count"
    if [[ "$TEST_SCENARIO" == rollback_fail && "$n" -eq 2 ]]; then exit 1; fi
    if [[ "$TEST_SCENARIO" == start_fail || "$TEST_SCENARIO" == start_limit || "$TEST_SCENARIO" == rollback_fail ]] && [[ "$n" -eq 1 ]]; then exit 1; fi
    if [[ "$TEST_SCENARIO" == start_limit && $(cat "$TEST_STATE_DIR/reset_count") -lt 2 ]]; then exit 1; fi
    printf 'active\n' > "$TEST_STATE_DIR/service_state"
    ;;
  *) exit 2 ;;
esac
MOCK
    cat > "$case_dir/bin/journalctl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
n=$(cat "$TEST_STATE_DIR/start_count")
if [[ "$TEST_SCENARIO" != ready_timeout || "$n" -gt 1 ]]; then
  printf '%s\n' '{"message":"gateway ready"}'
fi
MOCK
    cat > "$case_dir/bin/chown" <<'MOCK'
#!/usr/bin/env bash
printf 'chown %s\n' "$1" >> "$TEST_STATE_DIR/log"
MOCK
    cat > "$case_dir/bin/stat" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == -c ]]; then printf '%s\n' 'root:altnoti 640'; else /usr/bin/stat "$@"; fi
MOCK
    chmod +x "$case_dir/bin/"*

    if [[ "$script_name" == altnoti-rotate-token.sh ]]; then
      secret=$(printf 'x%.0s' {1..60})
    else
      secret='https://healthchecks.invalid/test-secret-value'
    fi
    export TEST_STATE_DIR="$case_dir" TEST_SCENARIO="$scenario"
    if printf '%s\n' "$secret" | PATH="$case_dir/bin:$PATH" bash "$case_dir/script.sh" > "$case_dir/out" 2> "$case_dir/err"; then
      result=0
    else
      result=$?
    fi
    if grep -Fq "$secret" "$case_dir/out" || grep -Fq "$secret" "$case_dir/err"; then fail "$script_name/$scenario exposed secret"; fi

    if [[ "$scenario" == success ]]; then
      [[ "$result" -eq 0 ]] || fail "$script_name/$scenario failed"
      cmp -s "$case_dir/env" "$case_dir/original" && fail "$script_name/$scenario did not update env"
      [[ $(cat "$case_dir/start_count") -eq 1 ]] || fail "$script_name/$scenario unexpected rollback"
    else
      [[ "$result" -ne 0 ]] || fail "$script_name/$scenario unexpectedly succeeded"
      cmp -s "$case_dir/env" "$case_dir/original" || fail "$script_name/$scenario did not preserve old env"
      if [[ "$scenario" == inactive || "$scenario" == backup_fail ]]; then
        [[ $(cat "$case_dir/start_count") -eq 0 ]] || fail "$script_name/$scenario started service"
        if [[ "$scenario" == inactive ]]; then
          ! grep -Fq 'start altnoti-backup.service' "$case_dir/log" || fail "$script_name/$scenario ran backup"
        fi
      elif [[ "$scenario" == rollback_fail ]]; then
        grep -Fq 'rollback failed; manual intervention required' "$case_dir/err" || fail "$script_name/$scenario missed manual intervention"
      else
        grep -Fq 'rollback succeeded' "$case_dir/err" || fail "$script_name/$scenario missed verified rollback"
        if [[ "$scenario" == stop_fail ]]; then
          [[ $(cat "$case_dir/start_count") -eq 1 && $(cat "$case_dir/reset_count") -eq 1 ]] || fail "$script_name/$scenario missed old-service recovery"
        elif [[ "$scenario" == reset_fail ]]; then
          [[ $(cat "$case_dir/start_count") -eq 1 && $(cat "$case_dir/reset_count") -eq 2 ]] || fail "$script_name/$scenario missed reset-failed recovery"
        else
          [[ $(cat "$case_dir/start_count") -eq 2 ]] || fail "$script_name/$scenario did not restart old service"
          [[ $(cat "$case_dir/reset_count") -eq 2 ]] || fail "$script_name/$scenario missed reset-failed"
        fi
      fi
    fi
    echo "PASS $script_name/$scenario"
  done
done
