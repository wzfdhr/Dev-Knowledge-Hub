#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_directory/lib.sh"

require_backup_env

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
target=""
snapshot_id=""
network_name=""
database_container=""
application_container=""

finish() {
  local exit_code="$?"

  if [[ -n "$application_container" ]]; then
    docker rm -f "$application_container" >/dev/null 2>&1 || true
  fi

  if [[ -n "$database_container" ]]; then
    docker rm -f "$database_container" >/dev/null 2>&1 || true
  fi

  if [[ -n "$network_name" ]]; then
    docker network rm "$network_name" >/dev/null 2>&1 || true
  fi

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
volume_root="$target/volumes"
mkdir -p "$volume_root"
for archive in snapshots repositories sources artifacts; do
  if tar -tzf "$set_directory/$archive.tgz" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
    printf 'unsafe path in restored archive: %s.tgz\n' "$archive" >&2
    exit 65
  fi
  mkdir -p "$volume_root/$archive"
  tar -xzf "$set_directory/$archive.tgz" -C "$volume_root/$archive"
done

docker run --rm \
  --mount "type=bind,src=$set_directory,dst=/backup,readonly" \
  postgres:16-bookworm \
  pg_restore --list /backup/database.pgdump >/dev/null

network_name="devkh-restore-drill-$$"
database_container="$network_name-postgres"
application_container="$network_name-app"
docker network create "$network_name" >/dev/null
docker run -d \
  --name "$database_container" \
  --network "$network_name" \
  -e POSTGRES_DB=dev_knowledge_hub \
  -e POSTGRES_USER=devkh \
  -e POSTGRES_PASSWORD=restore-drill-only \
  postgres:16-bookworm >/dev/null

database_ready=0
for _ in $(seq 1 30); do
  if docker exec "$database_container" pg_isready -U devkh -d dev_knowledge_hub >/dev/null 2>&1; then
    database_ready=1
    break
  fi
  sleep 1
done
(( database_ready == 1 )) || {
  printf 'ephemeral recovery database did not become ready\n' >&2
  exit 69
}

docker exec -i "$database_container" \
  pg_restore -U devkh -d dev_knowledge_hub --no-owner --no-privileges --exit-on-error \
  < "$set_directory/database.pgdump"

database_stats="$(docker exec "$database_container" psql -U devkh -d dev_knowledge_hub -At -v ON_ERROR_STOP=1 -c \
  "SELECT json_build_object('workspaceCount',(SELECT count(*) FROM workspaces),'projectCount',(SELECT count(*) FROM projects),'releaseCount',(SELECT count(*) FROM releases),'artifactCount',(SELECT count(*) FROM knowledge_artifacts))::text;")"
integrity="$(docker exec "$database_container" psql -U devkh -d dev_knowledge_hub -At -v ON_ERROR_STOP=1 -c \
  "SELECT json_build_object('orphanedReleases',(SELECT count(*) FROM releases r LEFT JOIN repositories repo ON repo.id=r.repository_id AND repo.workspace_id=r.workspace_id LEFT JOIN build_jobs b ON b.id=r.build_job_id AND b.workspace_id=r.workspace_id WHERE repo.id IS NULL OR b.id IS NULL),'crossWorkspaceProjectMembers',(SELECT count(*) FROM project_members pm JOIN projects p ON p.id=pm.project_id JOIN admin_users u ON u.id=pm.user_id WHERE p.workspace_id<>u.workspace_id),'orphanedArtifacts',(SELECT count(*) FROM knowledge_artifacts a LEFT JOIN projects p ON p.id=a.project_id AND p.workspace_id=a.workspace_id LEFT JOIN source_snapshots s ON s.id=a.snapshot_id AND s.workspace_id=a.workspace_id LEFT JOIN build_jobs b ON b.id=a.build_job_id AND b.workspace_id=a.workspace_id WHERE p.id IS NULL OR s.id IS NULL OR b.id IS NULL))::text;")"
node -e 'const integrity=JSON.parse(process.argv[1]); if(Object.values(integrity).some((value)=>value!==0)){console.error("restored database integrity check failed",integrity);process.exit(1)}' "$integrity"

if [[ -n "${RECOVERY_APP_IMAGE:-}" ]]; then
  application_image="$RECOVERY_APP_IMAGE"
else
  application_image="$(cd "$COMPOSE_DIR" && docker compose -f docker-compose.yml -p "$COMPOSE_PROJECT_NAME" images -q app | head -n 1)"
fi
[[ -n "$application_image" ]] || {
  printf 'unable to identify application image for recovery health check\n' >&2
  exit 69
}

docker run -d \
  --name "$application_container" \
  --network "$network_name" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  -e NODE_ENV=production \
  -e HOST=0.0.0.0 \
  -e PORT=3000 \
  -e DATA_DIR=/var/lib/devkh \
  -e "DATABASE_URL=postgres://devkh:restore-drill-only@$database_container:5432/dev_knowledge_hub" \
  -e DEVKH_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
  -e DEVKH_SESSION_SECRET=restore-drill-session-secret-not-for-production \
  --mount "type=bind,src=$volume_root/snapshots,dst=/var/lib/devkh/snapshots" \
  --mount "type=bind,src=$volume_root/repositories,dst=/var/lib/devkh/repos" \
  --mount "type=bind,src=$volume_root/sources,dst=/var/lib/devkh/uploads" \
  --mount "type=bind,src=$volume_root/artifacts,dst=/var/lib/devkh/artifacts" \
  "$application_image" >/dev/null

health_check_passed=0
for _ in $(seq 1 30); do
  if docker exec "$application_container" node -e \
    "fetch('http://127.0.0.1:3000/api/health').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"; then
    health_check_passed=1
    break
  fi
  sleep 1
done
(( health_check_passed == 1 )) || {
  printf 'restored application did not pass its health check\n' >&2
  exit 69
}

evidence_directory="$BACKUP_STATE_DIR/recovery-evidence"
mkdir -p "$evidence_directory"
chmod 700 "$evidence_directory"
database_checksum="$(sha256sum "$set_directory/database.pgdump" | awk '{print $1}')"
evidence_path="$evidence_directory/$(date -u +%Y%m%dT%H%M%SZ)-$snapshot_id.json"
temporary_evidence_path="$evidence_path.tmp.$$"
node -e 'const fs=require("node:fs"); const [path,temporaryPath,startedAt,snapshotId,checksum,databaseStats,integrity]=process.argv.slice(1); fs.writeFileSync(temporaryPath,JSON.stringify({schemaVersion:2,operation:"restore-drill",result:"success",startedAt,finishedAt:new Date().toISOString(),resticSnapshotId:snapshotId,databaseArchiveSha256:checksum,volumeArchives:["snapshots.tgz","repositories.tgz","sources.tgz","artifacts.tgz"],productionVolumeTouched:false,restoredSnapshotCount:1,pgRestoreListValidated:true,ephemeralDatabaseRestored:true,healthCheckPassed:true,databaseStats:JSON.parse(databaseStats),integrity:JSON.parse(integrity)})+"\n",{mode:0o600}); fs.renameSync(temporaryPath,path);' "$evidence_path" "$temporary_evidence_path" "$started_at" "$snapshot_id" "$database_checksum" "$database_stats" "$integrity"
