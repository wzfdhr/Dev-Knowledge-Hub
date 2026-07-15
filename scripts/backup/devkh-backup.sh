#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_directory/lib.sh"

require_backup_env

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
stage=""
snapshot_id=""
app_stopped=0

finish() {
  local exit_code="$?"

  if (( app_stopped )); then
    (
      cd "$COMPOSE_DIR"
      docker compose -f docker-compose.yml -p "$COMPOSE_PROJECT_NAME" start app
    ) || exit_code=1
  fi

  if [[ -n "$stage" ]]; then
    rm -rf "$stage"
  fi

  if (( exit_code == 0 )); then
    write_status backup success "$started_at" "$snapshot_id" ""
  else
    write_status backup failed "$started_at" "" backup_failed || true
  fi

  exit "$exit_code"
}

trap finish EXIT INT TERM

mkdir -p "$BACKUP_STATE_DIR"
chmod 700 "$BACKUP_STATE_DIR"
stage="$(mktemp -d "$BACKUP_STATE_DIR/staging.XXXXXX")"

(
  cd "$COMPOSE_DIR"
  docker compose -f docker-compose.yml -p "$COMPOSE_PROJECT_NAME" stop app
)
app_stopped=1

(
  cd "$COMPOSE_DIR"
  docker compose -f docker-compose.yml -p "$COMPOSE_PROJECT_NAME" exec -T postgres pg_dump -U devkh -d dev_knowledge_hub -Fc
) > "$stage/database.pgdump"

for pair in "snapshots:$SNAPSHOT_VOLUME" "repositories:$REPOSITORY_VOLUME" "sources:$UPLOADED_SOURCES_VOLUME" "artifacts:$ARTIFACT_VOLUME"; do
  name="${pair%%:*}"
  volume="${pair#*:}"
  docker run --rm \
    --mount "type=volume,src=$volume,dst=/source,readonly" \
    --mount "type=bind,src=$stage,dst=/backup" \
    alpine:3.20 tar -C /source -czf "/backup/$name.tgz" .
done

write_checksums "$stage"

git_revision="$(git -C "$COMPOSE_DIR" rev-parse HEAD 2>/dev/null || printf unknown)"
node -e 'const fs=require("node:fs"); const [directory,createdAt,gitRevision]=process.argv.slice(1); fs.writeFileSync(`${directory}/manifest.json`,JSON.stringify({schemaVersion:2,createdAt,gitRevision,files:["database.pgdump","snapshots.tgz","repositories.tgz","sources.tgz","artifacts.tgz","checksums.sha256"]})+"\n",{mode:0o600});' "$stage" "$started_at" "$git_revision"

(
  cd "$COMPOSE_DIR"
  docker compose -f docker-compose.yml -p "$COMPOSE_PROJECT_NAME" start app
)
app_stopped=0

backup_tags=(--tag daily)
if [[ "$(date +%d)" == "01" ]]; then
  backup_tags+=(--tag monthly)
fi

restic backup "$stage" "${backup_tags[@]}"
snapshot_id="$(latest_snapshot_id)"
restic forget --keep-daily 30 --keep-monthly 12 --prune
