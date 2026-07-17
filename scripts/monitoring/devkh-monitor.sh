#!/usr/bin/env bash
set -uo pipefail

: "${COMPOSE_DIR:?missing COMPOSE_DIR}"
: "${COMPOSE_PROJECT_NAME:?missing COMPOSE_PROJECT_NAME}"
: "${APP_HEALTH_URL:?missing APP_HEALTH_URL}"
: "${BACKUP_ENV_FILE:?missing BACKUP_ENV_FILE}"
: "${MONITOR_STATE_DIR:?missing MONITOR_STATE_DIR}"
: "${DISK_PATH:?missing DISK_PATH}"
: "${MAX_DISK_USED_PERCENT:?missing MAX_DISK_USED_PERCENT}"
: "${MAX_BACKUP_AGE_SECONDS:?missing MAX_BACKUP_AGE_SECONDS}"
: "${MAX_IMPORT_FAILURE_RATE_PERCENT:?missing MAX_IMPORT_FAILURE_RATE_PERCENT}"
: "${MAX_SHADOW_PIPELINE_FAILURES_24H:?missing MAX_SHADOW_PIPELINE_FAILURES_24H}"

[[ "$COMPOSE_DIR" == /* ]] || {
  printf 'COMPOSE_DIR must be an absolute path\n' >&2
  exit 64
}

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
failures=()

write_status() {
  local result="$1"
  local temporary="$MONITOR_STATE_DIR/status.json.tmp"
  local status_args=("$result" "$started_at")

  if (( ${#failures[@]} )); then
    status_args+=("${failures[@]}")
  fi

  mkdir -p "$MONITOR_STATE_DIR"
  chmod 700 "$MONITOR_STATE_DIR"
  STATUS_PATH="$temporary" node -e 'const fs=require("node:fs"); const [result,startedAt,...failures]=process.argv.slice(1); fs.writeFileSync(process.env.STATUS_PATH,JSON.stringify({schemaVersion:1,result,startedAt,finishedAt:new Date().toISOString(),failures})+"\n",{mode:0o600});' \
    "${status_args[@]}"
  chmod 600 "$temporary"
  mv "$temporary" "$MONITOR_STATE_DIR/status.json"
}

check_application() {
  curl -fsS "$APP_HEALTH_URL" >/dev/null || failures+=("application_http")
}

check_containers() {
  local output
  output="$(docker compose -f "$COMPOSE_DIR/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" ps --format '{{.Service}} {{.Health}}')" \
    || { failures+=("compose_status"); return; }
  grep -Fx 'app healthy' <<< "$output" >/dev/null || failures+=("app_container")
  grep -Fx 'postgres healthy' <<< "$output" >/dev/null || failures+=("postgres_container")
}

check_disk() {
  local used
  used="$(df -P "$DISK_PATH" | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')"
  [[ "$used" =~ ^[0-9]+$ && "$used" -lt "$MAX_DISK_USED_PERCENT" ]] || failures+=("disk_capacity")
}

check_backup() {
  local age
  [[ -r "$BACKUP_ENV_FILE" ]] || { failures+=("backup_configuration"); return; }
  age="$(
    set -a
    # shellcheck disable=SC1090
    . "$BACKUP_ENV_FILE"
    set +a
    restic snapshots --json | node -e 'let raw=""; process.stdin.on("data",d=>raw+=d); process.stdin.on("end",()=>{const timestamps=JSON.parse(raw).map((snapshot)=>Date.parse(snapshot?.time ?? "")).filter(Number.isFinite); const timestamp=Math.max(...timestamps); const now=Number(process.env.DEVKH_MONITOR_NOW_EPOCH_SECONDS ?? Math.floor(Date.now()/1000)); if (!Number.isFinite(timestamp) || !Number.isFinite(now)) process.exit(1); process.stdout.write(String(now - Math.floor(timestamp / 1000)));});'
  )" || { failures+=("backup_snapshot"); return; }
  [[ "$age" =~ ^[0-9]+$ && "$age" -le "$MAX_BACKUP_AGE_SECONDS" ]] || failures+=("backup_freshness")
}

check_import_failure_rate() {
  local counts failed total
  counts="$(docker compose -f "$COMPOSE_DIR/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" exec -T postgres psql -U devkh -d dev_knowledge_hub -Atqc "SELECT count(*) FILTER (WHERE status = 'failed') || '|' || count(*) FROM import_reports WHERE started_at >= now() - interval '24 hours'")" || { failures+=("import_report_query"); return; }
  IFS='|' read -r failed total <<< "$counts"
  [[ "$failed" =~ ^[0-9]+$ && "$total" =~ ^[0-9]+$ ]] || { failures+=("import_report_query"); return; }
  (( total < 4 || failed * 100 <= total * MAX_IMPORT_FAILURE_RATE_PERCENT )) || failures+=("import_failure_rate")
}

check_shadow_pipeline_failures() {
  local failed_builds
  failed_builds="$(docker compose -f "$COMPOSE_DIR/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" exec -T postgres psql -U devkh -d dev_knowledge_hub -Atqc "
    WITH latest_stage_attempt AS (
      SELECT DISTINCT ON (build_job_id, stage) build_job_id, stage, status
      FROM build_stage_runs
      WHERE updated_at >= now() - interval '24 hours'
      ORDER BY build_job_id, stage, attempt DESC
    )
    SELECT count(*)
    FROM (
      SELECT build_job_id
      FROM latest_stage_attempt
      GROUP BY build_job_id
      HAVING bool_or(status = 'failed')
    ) failed_builds
  ")" || { failures+=("shadow_pipeline_query"); return; }
  [[ "$failed_builds" =~ ^[0-9]+$ ]] || { failures+=("shadow_pipeline_query"); return; }
  (( failed_builds <= MAX_SHADOW_PIPELINE_FAILURES_24H )) || failures+=("shadow_pipeline_failures")
}

check_application
check_containers
check_disk
check_backup
check_import_failure_rate
check_shadow_pipeline_failures

if (( ${#failures[@]} )); then
  write_status failed
  printf 'Dev Knowledge Hub monitoring failed: %s\n' "${failures[*]}" >&2
  exit 1
fi

write_status success
