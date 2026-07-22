#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_directory/lib.sh"

require_backup_env

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
target=""
snapshot_id=""
evidence_path=""
evidence_sidecar_path=""
network_name=""
database_container=""
application_container=""
cleanup_failed=0

validate_archive_members() {
  node "$script_directory/validate-tar-archive.mjs" "$1"
}

validate_extracted_tree() {
  node - "$1" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = fs.realpathSync(process.argv[2]);
const contained = (candidate) => candidate === root || candidate.startsWith(root + path.sep);
const walk = (directory) => {
  for (const name of fs.readdirSync(directory)) {
    const candidate = path.join(directory, name);
    const stats = fs.lstatSync(candidate, { bigint: true });
    if (stats.isSymbolicLink()) throw new Error("unsafe symlink in extracted archive: " + candidate);
    const canonical = fs.realpathSync(candidate);
    if (!contained(canonical)) throw new Error("extracted archive path escapes root: " + candidate);
    if (stats.isDirectory()) walk(candidate);
    else if (!stats.isFile()) throw new Error("unsafe non-regular extracted archive member: " + candidate);
  }
};
walk(root);
NODE
}

finish() {
  local exit_code="$1"

  trap - EXIT INT TERM

  if (( exit_code != 0 )); then
    [[ -z "$evidence_path" ]] || rm -f "$evidence_path" "${evidence_path%.pending}" || true
    [[ -z "$evidence_sidecar_path" ]] || rm -f "$evidence_sidecar_path" "${evidence_sidecar_path%.pending}" || true
    printf 'recovery drill failed; retained fixture: %s\n' "$target" >&2
  else
    if [[ -n "$application_container" ]] && ! docker rm -f "$application_container" >/dev/null 2>&1; then
      printf 'recovery cleanup failed for application container: %s\n' "$application_container" >&2
      cleanup_failed=1
    fi

    if [[ -n "$database_container" ]] && ! docker rm -f "$database_container" >/dev/null 2>&1; then
      printf 'recovery cleanup failed for database container: %s\n' "$database_container" >&2
      cleanup_failed=1
    fi

    if [[ -n "$network_name" ]] && ! docker network rm "$network_name" >/dev/null 2>&1; then
      printf 'recovery cleanup failed for network: %s\n' "$network_name" >&2
      cleanup_failed=1
    fi

    if (( ! cleanup_failed )) && [[ -n "$target" ]] && ! rm -rf "$target"; then
      printf 'recovery cleanup failed for restored directory: %s\n' "$target" >&2
      cleanup_failed=1
    fi

    if (( cleanup_failed )); then
      if [[ -n "$evidence_path" ]]; then
        if ! rm -f "$evidence_path" "${evidence_path%.pending}"; then
          printf 'recovery cleanup failed to invalidate success evidence: %s\n' "$evidence_path" >&2
        fi
      fi
      if [[ -n "$evidence_sidecar_path" ]]; then
        if ! rm -f "$evidence_sidecar_path" "${evidence_sidecar_path%.pending}"; then
          printf 'recovery cleanup failed to invalidate source blob evidence: %s\n' "$evidence_sidecar_path" >&2
        fi
      fi
      printf 'recovery cleanup failed; inspect recovery resources under: %s\n' "$target" >&2
      exit_code=1
    elif [[ -n "$evidence_path" && "${RECOVERY_EVIDENCE_DEFER_FINALIZATION:-false}" != "true" ]]; then
      if ! mv "$evidence_sidecar_path" "${evidence_sidecar_path%.pending}" || ! mv "$evidence_path" "${evidence_path%.pending}"; then
        rm -f "$evidence_path" "${evidence_path%.pending}" "$evidence_sidecar_path" "${evidence_sidecar_path%.pending}"
        printf 'recovery evidence finalization failed\n' >&2
        exit_code=1
      fi
    fi
  fi

  if (( exit_code == 0 )); then
    write_status restore-drill success "$started_at" "$snapshot_id" ""
  else
    if ! write_status restore-drill failed "$started_at" "" restore_drill_failed "$target"; then
      printf 'recovery drill failed to write failure status: %s\n' "$target" >&2
    fi
  fi

  exit "$exit_code"
}

trap 'finish $?' EXIT
trap 'finish 130' INT
trap 'finish 143' TERM

mkdir -p "$BACKUP_STATE_DIR"
chmod 700 "$BACKUP_STATE_DIR"
target="$(mktemp -d "$BACKUP_STATE_DIR/restore-check.XXXXXX")"

snapshot_id="$(latest_snapshot_id)"
restic restore "$snapshot_id" --target "$target"
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
  validate_archive_members "$set_directory/$archive.tgz"
  mkdir -p "$volume_root/$archive"
  tar -xzf "$set_directory/$archive.tgz" -C "$volume_root/$archive"
  validate_extracted_tree "$volume_root/$archive"
done
volume_file_counts="$(node -e 'const fs=require("node:fs"); const path=require("node:path"); const root=process.argv[1]; const count=(directory)=>fs.readdirSync(directory,{withFileTypes:true}).reduce((total,entry)=>total+(entry.isDirectory()?count(path.join(directory,entry.name)):entry.isFile()?1:0),0); process.stdout.write(JSON.stringify(Object.fromEntries(["snapshots","repositories","sources","artifacts"].map((name)=>[name,count(path.join(root,name))]))));' "$volume_root")"
volume_archive_sha256="$(node -e 'const fs=require("node:fs"); const crypto=require("node:crypto"); const root=process.argv[1]; const digest=(name)=>crypto.createHash("sha256").update(fs.readFileSync(`${root}/${name}.tgz`)).digest("hex"); process.stdout.write(JSON.stringify(Object.fromEntries(["snapshots","repositories","sources","artifacts"].map((name)=>[name,digest(name)]))));' "$set_directory")"

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

if ! docker exec "$database_container" psql -U devkh -d postgres -At -v ON_ERROR_STOP=1 -c \
  "SELECT 1 FROM pg_database WHERE datname = 'dev_knowledge_hub';" | grep -qx 1; then
  docker exec "$database_container" createdb -U devkh dev_knowledge_hub
fi

docker exec -i "$database_container" \
  pg_restore -U devkh -d dev_knowledge_hub --no-owner --no-privileges --exit-on-error \
  < "$set_directory/database.pgdump"

database_stats="$(docker exec "$database_container" psql -U devkh -d dev_knowledge_hub -At -v ON_ERROR_STOP=1 -c \
  "SELECT json_build_object('workspaceCount',(SELECT count(*) FROM workspaces),'userCount',(SELECT count(*) FROM admin_users),'projectCount',(SELECT count(*) FROM projects),'projectMemberCount',(SELECT count(*) FROM project_members),'snapshotCount',(SELECT count(*) FROM source_snapshots),'releaseCount',(SELECT count(*) FROM releases),'releaseChannelCount',(SELECT count(*) FROM release_channels),'artifactCount',(SELECT count(*) FROM knowledge_artifacts),'sourceAnalysisArtifactCount',(SELECT count(*) FROM source_analysis_artifacts),'sourceBlobCount',(SELECT count(*) FROM source_blobs),'sourceFileBlobReferenceCount',(SELECT count(*) FROM source_files WHERE source_blob_id IS NOT NULL),'referencedSourceBlobGenerationCount',(SELECT count(DISTINCT source_blob_id) FROM source_files WHERE source_blob_id IS NOT NULL))::text;")"
integrity="$(docker exec "$database_container" psql -U devkh -d dev_knowledge_hub -At -v ON_ERROR_STOP=1 -c \
  "SELECT json_build_object('orphanedReleases',(SELECT count(*) FROM releases r LEFT JOIN repositories repo ON repo.id=r.repository_id AND repo.workspace_id=r.workspace_id LEFT JOIN build_jobs b ON b.id=r.build_job_id AND b.workspace_id=r.workspace_id LEFT JOIN source_snapshots s ON s.id=r.snapshot_id AND s.workspace_id=r.workspace_id WHERE repo.id IS NULL OR b.id IS NULL OR s.id IS NULL OR b.repository_id<>r.repository_id OR b.snapshot_id<>r.snapshot_id OR s.repository_id<>r.repository_id),'orphanedReleaseChannels',(SELECT count(*) FROM release_channels c LEFT JOIN releases r ON r.id=c.release_id AND r.workspace_id=c.workspace_id LEFT JOIN repositories repo ON repo.id=c.repository_id AND repo.workspace_id=c.workspace_id WHERE (c.release_id IS NOT NULL AND (r.id IS NULL OR r.repository_id<>c.repository_id)) OR repo.id IS NULL),'crossWorkspaceProjectMembers',(SELECT count(*) FROM project_members pm JOIN projects p ON p.id=pm.project_id JOIN admin_users u ON u.id=pm.user_id WHERE p.workspace_id<>u.workspace_id),'projectMembersWithoutWorkspaceMembership',(SELECT count(*) FROM project_members pm JOIN projects p ON p.id=pm.project_id LEFT JOIN workspace_members wm ON wm.workspace_id=p.workspace_id AND wm.user_id=pm.user_id WHERE wm.user_id IS NULL),'orphanedArtifacts',(SELECT count(*) FROM knowledge_artifacts a LEFT JOIN projects p ON p.id=a.project_id AND p.workspace_id=a.workspace_id LEFT JOIN source_snapshots s ON s.id=a.snapshot_id AND s.workspace_id=a.workspace_id LEFT JOIN build_jobs b ON b.id=a.build_job_id AND b.workspace_id=a.workspace_id LEFT JOIN repositories repo ON repo.id=b.repository_id AND repo.workspace_id=b.workspace_id WHERE p.id IS NULL OR s.id IS NULL OR b.id IS NULL OR repo.id IS NULL OR b.snapshot_id<>a.snapshot_id OR s.repository_id<>b.repository_id OR repo.project_id<>a.project_id),'orphanedSourceAnalysisArtifacts',(SELECT count(*) FROM source_analysis_artifacts a LEFT JOIN workspaces w ON w.id=a.workspace_id WHERE w.id IS NULL),'unboundSourceFiles',(SELECT count(*) FROM source_files WHERE source_blob_id IS NULL),'invalidSourceBlobReferences',(SELECT count(*) FROM source_files sf LEFT JOIN source_blobs sb ON sb.id=sf.source_blob_id WHERE sf.source_blob_id IS NOT NULL AND (sb.id IS NULL OR sb.workspace_id<>sf.workspace_id OR sb.content_hash<>sf.content_hash OR sb.byte_size<>sf.byte_size OR sb.generation<1 OR sb.status NOT IN ('active','tombstoned') OR (sb.status='active' AND (sb.fencing_token IS NOT NULL OR sb.tombstoned_at IS NOT NULL OR sb.trashed_at IS NOT NULL OR sb.deleted_at IS NOT NULL)) OR (sb.status='tombstoned' AND (sb.fencing_token IS NULL OR sb.tombstoned_at IS NULL OR sb.trashed_at IS NOT NULL OR sb.deleted_at IS NOT NULL)))))::text;")"
node -e 'const integrity=JSON.parse(process.argv[1]); if(Object.values(integrity).some((value)=>value!==0)){console.error("restored database integrity check failed",integrity);process.exit(1)}' "$integrity"

source_blob_manifest_path="$target/source-blob-manifests.json"
(
  umask 077
  docker exec "$database_container" psql -U devkh -d dev_knowledge_hub -At -v ON_ERROR_STOP=1 -c \
    "SELECT COALESCE(json_agg(json_build_object('workspaceId',sf.workspace_id,'snapshotId',sf.snapshot_id,'snapshotStoragePath',s.storage_path,'path',sf.path,'contentHash',sf.content_hash,'byteSize',sf.byte_size,'generation',sb.generation,'storageKey',sb.storage_key,'status',sb.status,'fencingToken',sb.fencing_token,'tombstonedAt',sb.tombstoned_at,'trashedAt',sb.trashed_at,'deletedAt',sb.deleted_at) ORDER BY sf.workspace_id::text COLLATE \"C\",sf.snapshot_id::text COLLATE \"C\",sf.path COLLATE \"C\"),'[]'::json)::text AS source_blob_manifests FROM source_files sf JOIN source_blobs sb ON sb.id=sf.source_blob_id AND sb.workspace_id=sf.workspace_id JOIN source_snapshots s ON s.id=sf.snapshot_id AND s.workspace_id=sf.workspace_id WHERE sf.source_blob_id IS NOT NULL;" \
    > "$source_blob_manifest_path"
)
chmod 600 "$source_blob_manifest_path"
source_blob_record_manifest_path="$target/source-blob-records.ndjson"
source_blob_evidence="$(node -e '
  const fs=require("node:fs"); const path=require("node:path"); const crypto=require("node:crypto");
  const root=fs.realpathSync(path.resolve(process.argv[1])); const manifests=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
  const recordFile=fs.openSync(process.argv[3],"wx",0o600);
  const safeSegment=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/; const digest=/^[a-f0-9]{64}$/; const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const contained=(candidate)=>candidate===root||candidate.startsWith(root+path.sep);
  const noFollow=fs.constants.O_NOFOLLOW; if(!Number.isInteger(noFollow)) throw new Error("no-follow file verification is unavailable");
  const openRegularFile=(segments,label)=>{
    let parent=root;
    for(let index=0;index<segments.length-1;index++){
      parent=path.join(parent,segments[index]);
      let stats; try{stats=fs.lstatSync(parent,{bigint:true})}catch{throw new Error(label+" path parent is unavailable")}
      if(stats.isSymbolicLink()||!stats.isDirectory()) throw new Error(label+" path parent is not a real directory");
      let canonical; try{canonical=fs.realpathSync(parent)}catch{throw new Error(label+" parent canonical path is unavailable")}
      if(!contained(canonical)) throw new Error(label+" escapes snapshot volume");
    }
    const candidate=path.join(parent,segments.at(-1)); let descriptor;
    try{descriptor=fs.openSync(candidate,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK|noFollow)}catch{throw new Error(label+" must be a regular no-follow file")}
    try{
      const stats=fs.fstatSync(descriptor,{bigint:true});
      if(!stats.isFile()) throw new Error(label+" must be a regular no-follow file");
      if((stats.mode&0o222n)!==0n) throw new Error(label+" must be read-only");
      return {descriptor,stats};
    }catch(error){fs.closeSync(descriptor);throw error}
  };
  const checkedGenerations=new Map(); const physicalInodes=new Set(); let blobHardlinkVerifiedCount=0; let sourceBlobLogicalBytes=0n; let sourceBlobPhysicalBytes=0n;
  try{for(const manifest of manifests){
    if(!safeSegment.test(manifest.workspaceId??"")||!safeSegment.test(manifest.snapshotId??"")||typeof manifest.path!=="string"||!digest.test(manifest.contentHash??"")||!Number.isSafeInteger(manifest.byteSize)||manifest.byteSize<0||!Number.isSafeInteger(manifest.generation)||manifest.generation<1) throw new Error("invalid source blob manifest");
    const pathSegments=manifest.path.split("/"); if(!pathSegments.length||manifest.path.includes("\\")||pathSegments.some((segment)=>!segment||segment==="."||segment===".."||segment.includes("\0"))) throw new Error("invalid source blob path");
    const stateTimes=[manifest.fencingToken,manifest.tombstonedAt,manifest.trashedAt,manifest.deletedAt];
    if(manifest.status==="active"){if(stateTimes.some((value)=>value!==null)) throw new Error("invalid active source blob state");}
    else if(manifest.status==="tombstoned"){if(!uuid.test(manifest.fencingToken??"")||typeof manifest.tombstonedAt!=="string"||!Number.isFinite(Date.parse(manifest.tombstonedAt))||manifest.trashedAt!==null||manifest.deletedAt!==null) throw new Error("invalid tombstoned source blob state");}
    else throw new Error("referenced source blob status is not recoverable");
    const expectedStorageKey=["blobs",manifest.workspaceId,manifest.contentHash.slice(0,2),manifest.contentHash,String(manifest.generation)].join("/");
    if(manifest.storageKey!==expectedStorageKey) throw new Error("source blob storage key does not match manifest");
    const expectedSnapshotStoragePath="/var/lib/devkh/snapshots/snapshots/"+manifest.snapshotId+"/files";
    if(manifest.snapshotStoragePath!==expectedSnapshotStoragePath) throw new Error("snapshot storage path does not match manifest");
    let blobFile; let viewFile;
    try{
      blobFile=openRegularFile(manifest.storageKey.split("/"),"source blob content"); const blob=blobFile.stats;
      viewFile=openRegularFile(["snapshots",manifest.snapshotId,"files",...pathSegments],"snapshot view"); const view=viewFile.stats;
      const blobBytes=fs.readFileSync(blobFile.descriptor); const blobContentSha256=crypto.createHash("sha256").update(blobBytes).digest("hex"); if(blobBytes.length!==manifest.byteSize||blobContentSha256!==manifest.contentHash) throw new Error("source blob content digest mismatch");
      const generationKey=[manifest.workspaceId,manifest.contentHash,manifest.generation].join("/");
      const known=checkedGenerations.get(generationKey); if(known&&known!==manifest.storageKey) throw new Error("source blob generation has inconsistent storage keys");
      if(!known){ checkedGenerations.set(generationKey,manifest.storageKey); sourceBlobLogicalBytes+=BigInt(manifest.byteSize); const inodeKey=blob.dev.toString()+":"+blob.ino.toString(); if(!physicalInodes.has(inodeKey)){physicalInodes.add(inodeKey); sourceBlobPhysicalBytes+=blob.blocks*512n;} }
      const viewBytes=fs.readFileSync(viewFile.descriptor); const viewContentSha256=crypto.createHash("sha256").update(viewBytes).digest("hex"); if(viewBytes.length!==manifest.byteSize||viewContentSha256!==manifest.contentHash) throw new Error("snapshot view content digest mismatch");
      if(view.dev!==blob.dev||view.ino!==blob.ino) throw new Error("snapshot view is not a same-inode hardlink");
      const mode=(stats)=>(stats.mode&0o7777n).toString(8).padStart(4,"0"); const allocated=(stats)=>(stats.blocks*512n).toString();
      const record={workspaceId:manifest.workspaceId,snapshotId:manifest.snapshotId,sourcePath:manifest.path,storageKey:manifest.storageKey,snapshotStoragePath:manifest.snapshotStoragePath,contentHash:manifest.contentHash,generation:manifest.generation,byteSize:manifest.byteSize,status:manifest.status,fencingToken:manifest.fencingToken,tombstonedAt:manifest.tombstonedAt,trashedAt:manifest.trashedAt,deletedAt:manifest.deletedAt,blobMode:mode(blob),viewMode:mode(view),blobDevice:blob.dev.toString(),blobInode:blob.ino.toString(),viewDevice:view.dev.toString(),viewInode:view.ino.toString(),blobSize:blob.size.toString(),viewSize:view.size.toString(),blobBlocks:blob.blocks.toString(),viewBlocks:view.blocks.toString(),blobAllocatedBytes:allocated(blob),viewAllocatedBytes:allocated(view),blobContentSha256,viewContentSha256,relationship:"same-device-inode-hardlink"};
      fs.writeSync(recordFile,JSON.stringify(record)+"\n");
      blobHardlinkVerifiedCount++;
    }finally{if(viewFile)fs.closeSync(viewFile.descriptor);if(blobFile)fs.closeSync(blobFile.descriptor)}
  }}finally{fs.closeSync(recordFile)}
  const maximum=BigInt(Number.MAX_SAFE_INTEGER); if(sourceBlobLogicalBytes>maximum||sourceBlobPhysicalBytes>maximum) throw new Error("source blob byte evidence exceeds safe integer range");
  process.stdout.write(JSON.stringify({blobReferenceCount:manifests.length,blobContentVerifiedCount:checkedGenerations.size,blobHardlinkVerifiedCount,referencedSourceBlobGenerationCount:checkedGenerations.size,sourceBlobLogicalBytes:Number(sourceBlobLogicalBytes),sourceBlobPhysicalBytes:Number(sourceBlobPhysicalBytes)}));
' "$volume_root/snapshots" "$source_blob_manifest_path" "$source_blob_record_manifest_path")"

artifact_manifests="$(docker exec "$database_container" psql -U devkh -d dev_knowledge_hub -At -v ON_ERROR_STOP=1 -c \
  "SELECT COALESCE(json_agg(json_build_object('projectId',project_id,'snapshotId',snapshot_id,'stage',stage,'storageKey',storage_key,'contentDigest',content_digest) ORDER BY storage_key),'[]'::json)::text AS artifact_manifests FROM knowledge_artifacts;")"
artifact_content_verified_count="$(node -e '
  const fs=require("node:fs"); const path=require("node:path"); const crypto=require("node:crypto");
  const root=path.resolve(process.argv[1]); const manifests=JSON.parse(process.argv[2]);
  for(const manifest of manifests){
    const safeSegment=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
    const validStage=["convert","extract","tables","graph","synthesize","index","lint","viz","validate","package"].includes(manifest.stage);
    if(!safeSegment.test(manifest.projectId??"")||!safeSegment.test(manifest.snapshotId??"")||!validStage||typeof manifest.storageKey!=="string"||!/^[a-f0-9]{64}$/.test(manifest.contentDigest??"")) throw new Error("invalid artifact manifest");
    const expected=[manifest.projectId,manifest.snapshotId,manifest.stage,`${manifest.contentDigest}.json`].join("/");
    if(manifest.storageKey!==expected) throw new Error("artifact storage key does not match manifest");
    const absolute=path.resolve(root,...manifest.storageKey.split("/"));
    if(!absolute.startsWith(`${root}${path.sep}`)) throw new Error("artifact storage key escapes store");
    let contents; try{contents=fs.readFileSync(absolute)}catch{throw new Error("artifact content is unavailable")}
    if(crypto.createHash("sha256").update(contents).digest("hex")!==manifest.contentDigest) throw new Error("artifact content digest mismatch");
    try{JSON.parse(contents.toString("utf8"))}catch{throw new Error("artifact content is not valid JSON")}
  }
  process.stdout.write(String(manifests.length));
' "$volume_root/artifacts" "$artifact_manifests")"

if [[ -n "${RECOVERY_APP_IMAGE:-}" ]]; then
  application_image="$RECOVERY_APP_IMAGE"
else
  application_image="$(cd "$COMPOSE_DIR" && docker compose -f "$COMPOSE_DIR/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" images -q app | head -n 1)"
fi
[[ -n "$application_image" ]] || {
  printf 'unable to identify application image for recovery health check\n' >&2
  exit 69
}

for volume in snapshots repositories sources artifacts; do
  docker run --rm --user root \
    --mount "type=bind,src=$volume_root/$volume,dst=/restore-volume" \
    "$application_image" \
    chown -R node:node /restore-volume
done

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
  docker logs "$application_container" >&2 || true
  printf 'restored application did not pass its health check\n' >&2
  exit 69
}

evidence_directory="$BACKUP_STATE_DIR/recovery-evidence"
mkdir -p "$evidence_directory"
chmod 700 "$evidence_directory"
database_checksum="$(sha256sum "$set_directory/database.pgdump" | awk '{print $1}')"
evidence_basename="$(date -u +%Y%m%dT%H%M%SZ)-$snapshot_id"
evidence_path="$evidence_directory/$evidence_basename.json.pending"
source_blob_record_manifest_file="$evidence_basename.source-blobs.ndjson"
evidence_sidecar_path="$evidence_directory/$source_blob_record_manifest_file.pending"
temporary_sidecar_path="$evidence_sidecar_path.tmp.$$"
cp "$source_blob_record_manifest_path" "$temporary_sidecar_path"
chmod 600 "$temporary_sidecar_path"
mv "$temporary_sidecar_path" "$evidence_sidecar_path"
source_blob_record_manifest_sha256="$(sha256sum "$evidence_sidecar_path" | awk '{print $1}')"
source_blob_record_manifest_count="$(wc -l < "$evidence_sidecar_path" | tr -d ' ')"
temporary_evidence_path="$evidence_path.tmp.$$"
node -e 'const fs=require("node:fs"); const [path,temporaryPath,startedAt,snapshotId,checksum,databaseStats,integrity,volumeArchiveSha256,volumeFileCounts,artifactContentVerifiedCount,sourceBlobEvidence,recordFile,recordSha256,recordCount]=process.argv.slice(1); fs.writeFileSync(temporaryPath,JSON.stringify({schemaVersion:3,operation:"restore-drill",result:"success",startedAt,finishedAt:new Date().toISOString(),resticSnapshotId:snapshotId,databaseArchiveSha256:checksum,volumeArchives:["snapshots.tgz","repositories.tgz","sources.tgz","artifacts.tgz"],volumeArchiveSha256:JSON.parse(volumeArchiveSha256),volumeFileCounts:JSON.parse(volumeFileCounts),productionVolumeTouched:false,restoredSnapshotCount:1,pgRestoreListValidated:true,ephemeralDatabaseRestored:true,healthCheckPassed:true,artifactContentVerifiedCount:Number(artifactContentVerifiedCount),databaseStats:JSON.parse(databaseStats),integrity:JSON.parse(integrity),...JSON.parse(sourceBlobEvidence),sourceBlobRecordManifest:{file:recordFile,sha256:recordSha256,recordCount:Number(recordCount)}})+"\n",{mode:0o600}); fs.renameSync(temporaryPath,path);' "$evidence_path" "$temporary_evidence_path" "$started_at" "$snapshot_id" "$database_checksum" "$database_stats" "$integrity" "$volume_archive_sha256" "$volume_file_counts" "$artifact_content_verified_count" "$source_blob_evidence" "$source_blob_record_manifest_file" "$source_blob_record_manifest_sha256" "$source_blob_record_manifest_count"
node "$script_directory/validate-recovery-evidence.mjs" "$evidence_path" >/dev/null
