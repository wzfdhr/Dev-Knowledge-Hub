#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_directory/lib.sh"

require_backup_env

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
target=""
snapshot_id=""

finish() {
  local exit_code="$?"

  if [[ -n "$target" ]]; then
    rm -rf "$target"
  fi

  if (( exit_code == 0 )); then
    write_status restore-drill success "$started_at" "$snapshot_id" ""
  else
    write_status restore-drill failed "$started_at" "" restore_drill_failed || true
  fi

  exit "$exit_code"
}

trap finish EXIT INT TERM

mkdir -p "$BACKUP_STATE_DIR"
chmod 700 "$BACKUP_STATE_DIR"
target="$(mktemp -d "$BACKUP_STATE_DIR/restore-check.XXXXXX")"

restic restore latest --target "$target"
snapshot_id="$(latest_snapshot_id)"
set_directory="$(dirname "$(find "$target" -type f -name manifest.json -print -quit)")"

[[ -n "$set_directory" && -f "$set_directory/checksums.sha256" ]] || {
  printf 'restored backup set is incomplete\n' >&2
  exit 65
}

(
  cd "$set_directory"
  sha256sum -c checksums.sha256
)
tar -tzf "$set_directory/snapshots.tgz" >/dev/null
tar -tzf "$set_directory/repositories.tgz" >/dev/null
tar -tzf "$set_directory/sources.tgz" >/dev/null
tar -tzf "$set_directory/uploads.tgz" >/dev/null
docker run --rm \
  --mount "type=bind,src=$set_directory,dst=/backup,readonly" \
  postgres:16-bookworm \
  pg_restore --list /backup/database.pgdump >/dev/null
