#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
temporary_root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/devkh-recovery-drill.XXXXXX")"
evidence_root="${RECOVERY_EVIDENCE_DIR:-${RUNNER_TEMP:-/tmp}/devkh-recovery-evidence}"
evidence_directory="$evidence_root/run-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}"
password_file="$temporary_root/restic-password"

cleanup() {
  rm -rf "$temporary_root"
}
trap cleanup EXIT INT TERM

mkdir -p "$evidence_directory"
printf 'ci-ephemeral-restic-password\n' > "$password_file"
chmod 600 "$password_file"

export COMPOSE_DIR="$project_root"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-devkh-ci}"
export SNAPSHOT_VOLUME="${COMPOSE_PROJECT_NAME}_snapshot_data"
export REPOSITORY_VOLUME="${COMPOSE_PROJECT_NAME}_repository_mirrors"
export UPLOADED_SOURCES_VOLUME="${COMPOSE_PROJECT_NAME}_uploaded_sources"
export ARTIFACT_VOLUME="${COMPOSE_PROJECT_NAME}_artifact_data"
export RESTIC_REPOSITORY="$temporary_root/restic-repository"
export RESTIC_PASSWORD_FILE="$password_file"
export BACKUP_STATE_DIR="$evidence_directory"
export RECOVERY_APP_IMAGE="${RECOVERY_APP_IMAGE:-devkh:ci}"

restic init >/dev/null
"$project_root/scripts/backup/seed-ci-recovery-fixture.sh"
"$project_root/scripts/backup/devkh-backup.sh"
"$project_root/scripts/backup/devkh-restore-drill.sh"

evidence_path="$(find "$evidence_directory/recovery-evidence" -type f -name '*.json' -print -quit)"
[[ -n "$evidence_path" ]] || {
  printf 'recovery drill did not produce evidence\n' >&2
  exit 65
}

node "$project_root/scripts/backup/validate-recovery-evidence.mjs" "$evidence_path"
