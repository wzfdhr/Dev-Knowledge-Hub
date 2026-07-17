#!/usr/bin/env bash
set -euo pipefail

require_backup_env() {
  local name

  for name in COMPOSE_DIR COMPOSE_PROJECT_NAME SNAPSHOT_VOLUME REPOSITORY_VOLUME UPLOADED_SOURCES_VOLUME ARTIFACT_VOLUME RESTIC_REPOSITORY RESTIC_PASSWORD_FILE BACKUP_STATE_DIR; do
    [[ -n "${!name:-}" ]] || {
      printf 'missing required backup setting: %s\n' "$name" >&2
      return 64
    }
  done

  [[ "$COMPOSE_DIR" == /* ]] || {
    printf 'COMPOSE_DIR must be an absolute path\n' >&2
    return 64
  }

  [[ -r "$RESTIC_PASSWORD_FILE" ]] || {
    printf 'restic password file is not readable\n' >&2
    return 64
  }
}

write_status() {
  local operation="$1"
  local result="$2"
  local started_at="$3"
  local snapshot_id="$4"
  local error_class="$5"
  local retention_path="${6:-}"
  local temporary="$BACKUP_STATE_DIR/status.json.tmp"

  mkdir -p "$BACKUP_STATE_DIR"
  chmod 700 "$BACKUP_STATE_DIR"
  node -e 'const [operation,result,startedAt,snapshotId,errorClass,retentionPath]=process.argv.slice(1); process.stdout.write(JSON.stringify({schemaVersion:1,operation,result,startedAt,finishedAt:new Date().toISOString(),snapshotId:snapshotId||null,errorClass:errorClass||null,retentionPath:retentionPath||null})+"\n")' "$operation" "$result" "$started_at" "$snapshot_id" "$error_class" "$retention_path" > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$BACKUP_STATE_DIR/status.json"
}

write_checksums() {
  (
    cd "$1"
    sha256sum database.pgdump snapshots.tgz repositories.tgz sources.tgz artifacts.tgz > checksums.sha256
  )
}

latest_snapshot_id() {
  restic snapshots --json | node -e 'let raw=""; process.stdin.on("data", (chunk) => { raw += chunk; }); process.stdin.on("end", () => { const snapshot=JSON.parse(raw).map((value) => ({ ...value, timestamp: Date.parse(value?.time ?? "") })).filter((value) => /^[a-f0-9]{64}$/.test(value.id ?? "") && Number.isFinite(value.timestamp)).sort((left, right) => right.timestamp - left.timestamp)[0]; if (!snapshot) process.exit(1); process.stdout.write(snapshot.id); });'
}
