#!/usr/bin/env bash
set -euo pipefail

[[ "${DEVKH_CONTAINER_SMOKE:-}" == "true" ]] || {
  printf 'CI recovery drill requires DEVKH_CONTAINER_SMOKE=true\n' >&2
  exit 64
}
[[ "${COMPOSE_PROJECT_NAME:-}" =~ ^devkh-ci(-[a-z0-9]+)*$ ]] || {
  printf 'CI recovery drill requires an isolated CI Compose project named devkh-ci or devkh-ci-<suffix>\n' >&2
  exit 64
}

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$project_root/scripts/backup/lib.sh"
temporary_root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/devkh-recovery-drill.XXXXXX")"
evidence_root="${RECOVERY_EVIDENCE_DIR:-${RUNNER_TEMP:-/tmp}/devkh-recovery-evidence}"
evidence_directory="$evidence_root/run-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}"
password_file="$temporary_root/restic-password"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cleanup() {
  local exit_code="$1"
  if (( exit_code == 0 )); then
    if ! rm -rf "$temporary_root"; then
      if ! rm -f "$evidence_directory"/recovery-evidence/*.json; then
        printf 'CI recovery cleanup failed to invalidate success evidence: %s\n' "$evidence_directory" >&2
      fi
      if ! write_status restore-drill failed "$started_at" "" recovery_cleanup_failed "$temporary_root"; then
        printf 'CI recovery cleanup failed to write failure status: %s\n' "$temporary_root" >&2
      fi
      printf 'CI recovery cleanup failed; retained temporary root: %s\n' "$temporary_root" >&2
      return 1
    fi
  else
    printf 'CI recovery drill failed; retained temporary root: %s\n' "$temporary_root" >&2
  fi
  return "$exit_code"
}
trap 'exit_code=$?; cleanup "$exit_code"; cleanup_code=$?; exit "$cleanup_code"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$evidence_directory"
printf 'ci-ephemeral-restic-password\n' > "$password_file"
chmod 600 "$password_file"

export COMPOSE_DIR="$project_root"
export COMPOSE_PROJECT_NAME
export SNAPSHOT_VOLUME="${COMPOSE_PROJECT_NAME}_snapshot_data"
export REPOSITORY_VOLUME="${COMPOSE_PROJECT_NAME}_repository_mirrors"
export UPLOADED_SOURCES_VOLUME="${COMPOSE_PROJECT_NAME}_uploaded_sources"
export ARTIFACT_VOLUME="${COMPOSE_PROJECT_NAME}_artifact_data"
export RESTIC_REPOSITORY="$temporary_root/restic-repository"
export RESTIC_PASSWORD_FILE="$password_file"
export BACKUP_STATE_DIR="$evidence_directory"
export RECOVERY_APP_IMAGE="${RECOVERY_APP_IMAGE:-devkh:ci}"
export RECOVERY_EVIDENCE_DEFER_FINALIZATION="${RECOVERY_EVIDENCE_DEFER_FINALIZATION:-false}"

restic init >/dev/null
"$project_root/scripts/backup/seed-ci-recovery-fixture.sh"
"$project_root/scripts/backup/devkh-backup.sh"
"$project_root/scripts/backup/devkh-restore-drill.sh"

evidence_pattern='*.json'
if [[ "$RECOVERY_EVIDENCE_DEFER_FINALIZATION" == "true" ]]; then
  evidence_pattern='*.json.pending'
fi
evidence_path="$(find "$evidence_directory/recovery-evidence" -type f -name "$evidence_pattern" -print -quit)"
[[ -n "$evidence_path" ]] || {
  printf 'recovery drill did not produce evidence\n' >&2
  exit 65
}

node "$project_root/scripts/backup/validate-recovery-evidence.mjs" "$evidence_path"
