#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT

fail() { echo "recovery script test failed: $1" >&2; exit 1; }

for script_name in altnoti-rotate-token.sh altnoti-configure-healthcheck.sh; do
  ! grep -Fq 'date --iso-8601=ns' "$repo_root/deploy/$script_name" || fail "$script_name still uses nanosecond timestamps"
  ! grep -Fq -- '--since' "$repo_root/deploy/$script_name" || fail "$script_name still uses journal time filtering"
done

for script_name in altnoti-rotate-token.sh altnoti-configure-healthcheck.sh; do
  for scenario in start_fail ready_timeout start_limit reset_fail stop_fail backup_fail rollback_fail success inactive old_ready switch_no_ready switch_then_ready journal_fail heartbeat_fail; do
    [[ "$script_name" == altnoti-configure-healthcheck.sh || "$scenario" != heartbeat_fail ]] || continue
    case_dir=$(mktemp -d "$scratch/case.XXXXXX")
    mkdir "$case_dir/bin"
    printf 'DISCORD_TOKEN=old-fixture\nHEALTHCHECKS_HEARTBEAT_URL=https://old.invalid/fixture\n' > "$case_dir/env"
    cp "$case_dir/env" "$case_dir/original"
    printf 'active\n' > "$case_dir/service_state"
    printf '0\n' > "$case_dir/start_count"
    printf '0\n' > "$case_dir/reset_count"
    printf '0\n' > "$case_dir/stop_count"
    printf '0\n' > "$case_dir/invocation_sequence"
    printf '0\n' > "$case_dir/show_count"
    printf 'invocation-initial\n' > "$case_dir/invocation_id"
    : > "$case_dir/log"

    # Only the test copy receives fixture paths and a short readiness deadline.
    sed -e "s@/etc/altnoti.env@$case_dir/env@g" \
      -e "s@/run/altnoti-@$case_dir/altnoti-@g" \
      -e 's@/usr/bin/node@node@g' \
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
  show)
    [[ "$2" == alt-notify.service && "$3" == --property=InvocationID && "$4" == --value ]] || exit 2
    n=$(cat "$TEST_STATE_DIR/show_count"); n=$((n+1)); printf '%s\n' "$n" > "$TEST_STATE_DIR/show_count"
    id=$(cat "$TEST_STATE_DIR/invocation_id")
    if [[ "$TEST_SCENARIO" == switch_no_ready || "$TEST_SCENARIO" == switch_then_ready ]] && [[ "$id" == invocation-1 ]]; then
      printf 'invocation-2\n' > "$TEST_STATE_DIR/invocation_id"
      printf '2\n' > "$TEST_STATE_DIR/invocation_sequence"
    fi
    printf '%s\n' "$id"
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
    sequence=$(cat "$TEST_STATE_DIR/invocation_sequence"); sequence=$((sequence+1)); printf '%s\n' "$sequence" > "$TEST_STATE_DIR/invocation_sequence"
    printf 'invocation-%s\n' "$sequence" > "$TEST_STATE_DIR/invocation_id"
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
[[ $# -eq 3 && "$1" == _SYSTEMD_INVOCATION_ID=* && "$2" == --output=cat && "$3" == --no-pager ]] || exit 2
id=${1#_SYSTEMD_INVOCATION_ID=}
printf 'journal %s\n' "$id" >> "$TEST_STATE_DIR/log"
[[ -n "$id" ]] || exit 2
if [[ "$TEST_SCENARIO" == journal_fail && "$id" == invocation-1 ]]; then exit 1; fi
if [[ "$id" == invocation-old ]]; then
  printf '%s\n' '{"message":"gateway ready"}'
elif [[ "$TEST_SCENARIO" == old_ready || "$TEST_SCENARIO" == ready_timeout || "$TEST_SCENARIO" == journal_fail ]] && [[ "$id" == invocation-1 ]]; then
  :
elif [[ "$TEST_SCENARIO" == switch_no_ready && "$id" == invocation-2 ]]; then
  :
else
  printf '%s\n' '{"message":"gateway ready"}'
fi
MOCK
    cat > "$case_dir/bin/node" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 3 && "$1" == --input-type=module && "$2" == - && "$3" == "$TEST_STATE_DIR"/altnoti-healthcheck-url.* ]] || exit 2
printf 'probe %s\n' "$3" >> "$TEST_STATE_DIR/log"
[[ "$TEST_SCENARIO" != heartbeat_fail ]]
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
    if grep -Fq "$secret" "$case_dir/out" || grep -Fq "$secret" "$case_dir/err" || grep -Fq "$secret" "$case_dir/log"; then fail "$script_name/$scenario exposed secret"; fi

    if [[ "$scenario" == success || "$scenario" == switch_then_ready ]]; then
      [[ "$result" -eq 0 ]] || fail "$script_name/$scenario failed"
      cmp -s "$case_dir/env" "$case_dir/original" && fail "$script_name/$scenario did not update env"
      [[ $(cat "$case_dir/start_count") -eq 1 ]] || fail "$script_name/$scenario unexpected rollback"
      if [[ "$script_name" == altnoti-configure-healthcheck.sh ]]; then
        grep -Fq 'probe ' "$case_dir/log" || fail "$script_name/$scenario missed heartbeat probe"
      fi
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
        if [[ "$scenario" == heartbeat_fail ]]; then
          grep -Fq 'probe ' "$case_dir/log" || fail "$script_name/$scenario missed heartbeat probe"
          ! grep -Fq 'healthcheck configured' "$case_dir/out" || fail "$script_name/$scenario claimed success"
        fi
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
    if [[ "$scenario" == old_ready ]]; then
      grep -Fq 'journal invocation-1' "$case_dir/log" || fail "$script_name/$scenario did not inspect current invocation"
      ! grep -Fq 'journal invocation-old' "$case_dir/log" || fail "$script_name/$scenario queried old invocation"
    fi
    if [[ "$scenario" == switch_no_ready || "$scenario" == switch_then_ready ]]; then
      grep -Fq 'journal invocation-2' "$case_dir/log" || fail "$script_name/$scenario ignored restarted invocation"
    fi
    echo "PASS $script_name/$scenario"
  done
done
