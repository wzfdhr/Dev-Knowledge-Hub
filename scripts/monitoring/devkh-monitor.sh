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

if [[ -n "${OBSERVATION_CANDIDATE_COMMIT:-}" ]]; then
  [[ "$OBSERVATION_CANDIDATE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
    printf 'OBSERVATION_CANDIDATE_COMMIT must be a lowercase 40-character SHA\n' >&2
    exit 64
  }
fi

if [[ -n "${OBSERVATION_SOURCE_STORAGE_MODE:-}" ]]; then
  [[ "$OBSERVATION_SOURCE_STORAGE_MODE" =~ ^(legacy|shadow|active)$ ]] || {
    printf 'OBSERVATION_SOURCE_STORAGE_MODE must be legacy, shadow, or active\n' >&2
    exit 64
  }
fi

observation_project_filter=""
if [[ -n "${OBSERVATION_PROJECT_ID:-}" ]]; then
  [[ "$OBSERVATION_PROJECT_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]] || {
    printf 'OBSERVATION_PROJECT_ID must be a UUID\n' >&2
    exit 64
  }
  observation_project_filter=" AND project_id = '${OBSERVATION_PROJECT_ID}'::uuid"
fi

observation_started_at_filter=""
if [[ -n "${OBSERVATION_STARTED_AT:-}" ]]; then
  [[ "$OBSERVATION_STARTED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || {
    printf 'OBSERVATION_STARTED_AT must be a UTC ISO-8601 timestamp with whole seconds\n' >&2
    exit 64
  }
  observation_started_at_filter=" AND updated_at >= '${OBSERVATION_STARTED_AT}'::timestamptz"
fi

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
  if ! STATUS_PATH="$temporary" HISTORY_PATH="$MONITOR_STATE_DIR/results.jsonl" node -e 'const fs=require("node:fs"); const [result,startedAt,...failures]=process.argv.slice(1); const status={schemaVersion:1,result,startedAt,finishedAt:new Date().toISOString(),failures}; if(process.env.OBSERVATION_PROJECT_ID) status.observationProjectId=process.env.OBSERVATION_PROJECT_ID; const serialized=JSON.stringify(status)+"\n"; fs.writeFileSync(process.env.STATUS_PATH,serialized,{mode:0o600}); fs.appendFileSync(process.env.HISTORY_PATH,serialized,{encoding:"utf8",mode:0o600}); fs.chmodSync(process.env.HISTORY_PATH,0o600);' \
    "${status_args[@]}"; then
    printf 'failed to write monitor evidence\n' >&2
    return 1
  fi
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
  counts="$(docker compose -f "$COMPOSE_DIR/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" exec -T postgres psql -U devkh -d dev_knowledge_hub -Atqc "SELECT count(*) FILTER (WHERE status = 'failed') || '|' || count(*) FROM import_reports WHERE started_at >= now() - interval '24 hours'${observation_project_filter}")" || { failures+=("import_report_query"); return; }
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
      WHERE updated_at >= now() - interval '24 hours'${observation_project_filter}${observation_started_at_filter}
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

check_observation_candidate() {
  [[ -n "${OBSERVATION_CANDIDATE_COMMIT:-}" ]] || return
  local candidate
  candidate="$(git -C "$COMPOSE_DIR" rev-parse HEAD 2>/dev/null)" || {
    failures+=("candidate_commit")
    return
  }
  [[ "$candidate" == "$OBSERVATION_CANDIDATE_COMMIT" ]] || failures+=("candidate_commit")
}

check_observation_source_storage_mode() {
  [[ -n "${OBSERVATION_SOURCE_STORAGE_MODE:-}" ]] || return
  local app_id runtime_mode
  app_id="$(docker compose -f "$COMPOSE_DIR/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" ps -q app)" || {
    failures+=("source_storage_mode")
    return
  }
  [[ -n "$app_id" ]] || {
    failures+=("source_storage_mode")
    return
  }
  runtime_mode="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$app_id" | sed -n 's/^DEVKH_SOURCE_STORAGE_MODE=//p')" || {
    failures+=("source_storage_mode")
    return
  }
  [[ "$runtime_mode" == "$OBSERVATION_SOURCE_STORAGE_MODE" ]] || failures+=("source_storage_mode")
}

check_application
check_containers
check_disk
check_backup
check_import_failure_rate
check_shadow_pipeline_failures
check_observation_candidate
check_observation_source_storage_mode

if (( ${#failures[@]} )); then
  write_status failed
  printf 'Dev Knowledge Hub monitoring failed: %s\n' "${failures[*]}" >&2
  exit 1
fi

write_status success
