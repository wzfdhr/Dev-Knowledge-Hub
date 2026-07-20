import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { gzipSync } from "node:zlib";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDirectory, "../..");
const backupScript = join(scriptDirectory, "devkh-backup.sh");
const restoreDrillScript = join(scriptDirectory, "devkh-restore-drill.sh");
const ciRecoveryDrillScript = join(scriptDirectory, "ci-recovery-drill.sh");
const seedRecoveryFixtureScript = join(scriptDirectory, "seed-ci-recovery-fixture.sh");
const validateTarArchiveScript = join(scriptDirectory, "validate-tar-archive.mjs");
const backupSnapshotId = "a".repeat(64);
const latestSnapshotId = "b".repeat(64);
const sourceBlobFence = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function writeTarOctal(header, offset, length, value) {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function gzipTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    writeTarOctal(header, 100, 8, entry.mode ?? 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, [undefined, "0", "x", "g", "L", "K"].includes(entry.type) ? contents.length : 0);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    if (entry.linkName) header.write(entry.linkName, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    writeTarOctal(header, 148, 8, [...header].reduce((sum, byte) => sum + byte, 0));
    blocks.push(header);
    if (contents.length) {
      blocks.push(contents, Buffer.alloc((512 - (contents.length % 512)) % 512));
    }
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

test("documents all four durable backup volumes", () => {
  const readme = readFileSync(join(projectRoot, "README.md"), "utf8");

  assert.match(
    readme,
    /four durable application volumes \(snapshots, repository mirrors, uploaded sources,\s+and artifacts\)/
  );
});

function createFixture({
  dockerStopExit = "0",
  dockerCleanupExit = "0",
  restoreCleanupExit = "0",
  resticBackupExit = "0",
  resticBackupDelay = "0",
  resticRestoreDelay = "0",
  resticBackupBlock = false,
  resticRestoreBlock = false,
  sourceBlobManifestPaddingBytes = 0,
  requireManifestMode = false,
  snapshotArchiveEntries = null,
  postExtractSymlink = false,
  writableSourceBlob = false,
  writableSnapshotView = false,
  deriveSourceBlobIntegrity = true,
  resticSnapshots = [{ id: latestSnapshotId, time: "1970-01-02T03:45:00.000Z" }],
  integrityResult = '{"orphanedReleases":0,"orphanedReleaseChannels":0,"crossWorkspaceProjectMembers":0,"projectMembersWithoutWorkspaceMembership":0,"orphanedArtifacts":0,"orphanedSourceAnalysisArtifacts":0,"invalidSourceBlobReferences":0}',
  artifactStorageKey = "33333333-3333-4333-8333-333333333333/55555555-5555-4555-8555-555555555555/convert/218589323cbe80b7ed077e3ee36f1663e7cb5f8f4e4ad02c938ad8a5c2c5a6b9.json",
  artifactContent = '{"fixture":true}',
  sourceBlobManifest = '[{"workspaceId":"11111111-1111-4111-8111-111111111111","snapshotId":"55555555-5555-4555-8555-555555555555","snapshotStoragePath":"/var/lib/devkh/snapshots/snapshots/55555555-5555-4555-8555-555555555555/files","path":"src/one.ts","contentHash":"47092ec41fd29a196ba9cc5101cb3ee100635028f95193116a37bd95961f8b28","byteSize":34,"generation":1,"storageKey":"blobs/11111111-1111-4111-8111-111111111111/47/47092ec41fd29a196ba9cc5101cb3ee100635028f95193116a37bd95961f8b28/1","status":"active","fencingToken":null,"tombstonedAt":null,"trashedAt":null,"deletedAt":null},{"workspaceId":"11111111-1111-4111-8111-111111111111","snapshotId":"55555555-5555-4555-8555-555555555555","snapshotStoragePath":"/var/lib/devkh/snapshots/snapshots/55555555-5555-4555-8555-555555555555/files","path":"src/two.ts","contentHash":"47092ec41fd29a196ba9cc5101cb3ee100635028f95193116a37bd95961f8b28","byteSize":34,"generation":1,"storageKey":"blobs/11111111-1111-4111-8111-111111111111/47/47092ec41fd29a196ba9cc5101cb3ee100635028f95193116a37bd95961f8b28/1","status":"active","fencingToken":null,"tombstonedAt":null,"trashedAt":null,"deletedAt":null}]'
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "devkh-backup-"));
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  const stateDirectory = join(root, "state");
  const passwordFile = join(root, "restic-password");
  const backupBlockFile = join(root, "backup.block");
  const restoreBlockFile = join(root, "restore.block");
  const sourceBlobManifestFile = join(root, "source-blob-manifests.json");
  const snapshotArchiveFile = join(root, "snapshot-attack.tgz");
  const systemTar = execFileSync("which", ["tar"], { encoding: "utf8" }).trim();
  execFileSync("mkdir", ["-p", bin]);
  writeFileSync(log, "");
  writeFileSync(passwordFile, "test-only-password\n", { mode: 0o600 });
  writeFileSync(sourceBlobManifestFile, `${sourceBlobManifest}${" ".repeat(sourceBlobManifestPaddingBytes)}\n`, { mode: 0o600 });
  if (snapshotArchiveEntries) writeFileSync(snapshotArchiveFile, gzipTar(snapshotArchiveEntries), { mode: 0o600 });
  writeFileSync(join(bin, "docker"), String.raw`#!/usr/bin/env sh
printf 'docker %s\n' "$*" >> "$CALL_LOG"
case " $* " in
  *" compose "*" stop app "*) exit "$DOCKER_STOP_EXIT" ;;
  *" rm -f "*|*" network rm "*) exit "$DOCKER_CLEANUP_EXIT" ;;
  *" compose "*" exec "*) printf 'fake-pgdump\n' ;;
  *" compose "*" images -q app "*) printf 'devkh-recovery-image\n' ;;
  *" pg_restore "*) printf 'pg_restore %s\n' "$*" >> "$CALL_LOG" ;;
  *" psql "*"workspaceCount"*) printf '{"workspaceCount":1,"userCount":1,"projectCount":1,"projectMemberCount":1,"snapshotCount":1,"releaseCount":1,"releaseChannelCount":1,"artifactCount":1,"sourceAnalysisArtifactCount":1,"sourceBlobCount":2,"sourceFileBlobReferenceCount":2,"referencedSourceBlobGenerationCount":1}\n' ;;
  *" psql "*"orphanedReleases"*)
    node -e 'const fs=require("node:fs"); const result=JSON.parse(process.env.FAKE_INTEGRITY_RESULT); if(process.env.FAKE_DERIVE_SOURCE_BLOB_INTEGRITY==="true"){const manifests=JSON.parse(fs.readFileSync(process.env.FAKE_SOURCE_BLOB_MANIFEST_PATH,"utf8")); const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; const valid=(item)=>item.status==="active" ? item.fencingToken===null&&item.tombstonedAt===null&&item.trashedAt===null&&item.deletedAt===null : item.status==="tombstoned"&&uuid.test(item.fencingToken??"")&&typeof item.tombstonedAt==="string"&&item.trashedAt===null&&item.deletedAt===null; result.invalidSourceBlobReferences=manifests.filter((item)=>!valid(item)).length;} process.stdout.write(JSON.stringify(result)+"\n");' ;;
  *" psql "*"artifact_manifests"*) printf '[{"projectId":"33333333-3333-4333-8333-333333333333","snapshotId":"55555555-5555-4555-8555-555555555555","stage":"convert","storageKey":"%s","contentDigest":"218589323cbe80b7ed077e3ee36f1663e7cb5f8f4e4ad02c938ad8a5c2c5a6b9"}]\n' "$FAKE_ARTIFACT_STORAGE_KEY" ;;
  *" psql "*"source_blob_manifests"*)
    node -e 'const fs=require("node:fs"); if(process.env.FAKE_REQUIRE_MANIFEST_MODE==="true"&&(fs.fstatSync(1).mode&0o777)!==0o600) process.exit(73); fs.createReadStream(process.env.FAKE_SOURCE_BLOB_MANIFEST_PATH).pipe(process.stdout);' ;;
  *" pg_isready "*) exit 0 ;;
  *" exec "*" node -e "*) exit 0 ;;
  *" run "*" alpine:3.20 tar "*)
    stage=$(printf '%s\n' "$*" | sed -n 's/.*type=bind,src=\([^,]*\),dst=\/backup.*/\1/p')
    archive=$(printf '%s\n' "$*" | sed -n 's/.*\/backup\/\([^ ]*\.tgz\).*/\1/p')
    : > "$stage/$archive"
    ;;
  *" run -d "*) printf 'fake-container-id\n' ;;
esac
`);
  writeFileSync(join(bin, "restic"), String.raw`#!/usr/bin/env sh
printf 'restic %s\n' "$*" >> "$CALL_LOG"
case "$1" in
  backup)
    while [ -n "$RESTIC_BACKUP_BLOCK_FILE" ] && [ ! -e "$RESTIC_BACKUP_BLOCK_FILE" ]; do sleep 0.05; done
    sleep "$RESTIC_BACKUP_DELAY"
    if [ "$RESTIC_BACKUP_EXIT" != "0" ]; then exit "$RESTIC_BACKUP_EXIT"; fi
    printf '{"message_type":"summary","snapshot_id":"%s"}\n' "$RESTIC_BACKUP_SNAPSHOT_ID"
    ;;
  snapshots) printf '%s' "$RESTIC_SNAPSHOTS_JSON" ;;
  restore)
    while [ -n "$RESTIC_RESTORE_BLOCK_FILE" ] && [ ! -e "$RESTIC_RESTORE_BLOCK_FILE" ]; do sleep 0.05; done
    sleep "$RESTIC_RESTORE_DELAY"
    target=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--target" ]; then target="$2"; shift 2; else shift; fi
    done
    set_directory="$target/backup-set"
    empty_directory="$target/empty"
    mkdir -p "$set_directory" "$empty_directory"
    printf 'fake-pgdump\n' > "$set_directory/database.pgdump"
    for name in repositories sources; do
      mkdir -p "$empty_directory/$name/recovery"
      printf '%s\n' "$name" > "$empty_directory/$name/recovery/fixture.txt"
      tar -C "$empty_directory/$name" -czf "$set_directory/$name.tgz" .
    done
    blob="$empty_directory/snapshots/blobs/11111111-1111-4111-8111-111111111111/47/47092ec41fd29a196ba9cc5101cb3ee100635028f95193116a37bd95961f8b28/1"
    mkdir -p "$(dirname "$blob")" "$empty_directory/snapshots/snapshots/55555555-5555-4555-8555-555555555555/files/src"
    printf 'export const recoveryFixture = 1;\n' > "$blob"
    ln "$blob" "$empty_directory/snapshots/snapshots/55555555-5555-4555-8555-555555555555/files/src/one.ts"
    ln "$blob" "$empty_directory/snapshots/snapshots/55555555-5555-4555-8555-555555555555/files/src/two.ts"
    chmod 0444 "$blob"
    if [ "$FAKE_WRITABLE_SOURCE_BLOB" = "true" ]; then chmod 0644 "$blob"; fi
    if [ "$FAKE_WRITABLE_SNAPSHOT_VIEW" = "true" ]; then
      writable_view="$empty_directory/snapshots/snapshots/55555555-5555-4555-8555-555555555555/files/src/one.ts"
      cp "$writable_view" "$writable_view.copy"
      rm "$writable_view"
      mv "$writable_view.copy" "$writable_view"
      chmod 0644 "$writable_view"
    fi
    tar -C "$empty_directory/snapshots" -czf "$set_directory/snapshots.tgz" .
    if [ -n "$FAKE_SNAPSHOT_ARCHIVE_PATH" ]; then cp "$FAKE_SNAPSHOT_ARCHIVE_PATH" "$set_directory/snapshots.tgz"; fi
    artifact_path="$empty_directory/artifacts/33333333-3333-4333-8333-333333333333/55555555-5555-4555-8555-555555555555/convert"
    mkdir -p "$artifact_path"
    printf '%s\n' "$FAKE_ARTIFACT_CONTENT" > "$artifact_path/218589323cbe80b7ed077e3ee36f1663e7cb5f8f4e4ad02c938ad8a5c2c5a6b9.json"
    tar -C "$empty_directory/artifacts" -czf "$set_directory/artifacts.tgz" .
    (cd "$set_directory" && sha256sum database.pgdump snapshots.tgz repositories.tgz sources.tgz artifacts.tgz > checksums.sha256)
    printf '{"schemaVersion":1}\n' > "$set_directory/manifest.json"
    ;;
esac
`);
  writeFileSync(join(bin, "rm"), String.raw`#!/usr/bin/env sh
if [ "$RESTORE_CLEANUP_EXIT" != "0" ]; then exit "$RESTORE_CLEANUP_EXIT"; fi
exec /bin/rm "$@"
`);
  writeFileSync(join(bin, "tar"), String.raw`#!/usr/bin/env sh
extract=false
destination=
previous=
for argument in "$@"; do
  case "$argument" in -*x*) extract=true ;; esac
  if [ "$previous" = "-C" ]; then destination="$argument"; fi
  previous="$argument"
done
"$SYSTEM_TAR" "$@"
status=$?
if [ "$status" != "0" ]; then exit "$status"; fi
if [ "$POST_EXTRACT_SYMLINK" = "true" ] && [ "$extract" = "true" ] && [ -n "$destination" ]; then
  ln -s ../outside "$destination/injected-symlink"
fi
`);
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "restic"), 0o755);
  chmodSync(join(bin, "rm"), 0o755);
  chmodSync(join(bin, "tar"), 0o755);

  return {
    root,
    log,
    environment: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALL_LOG: log,
      DOCKER_STOP_EXIT: dockerStopExit,
      DOCKER_CLEANUP_EXIT: dockerCleanupExit,
      RESTORE_CLEANUP_EXIT: restoreCleanupExit,
      RESTIC_BACKUP_EXIT: resticBackupExit,
      RESTIC_BACKUP_DELAY: resticBackupDelay,
      RESTIC_RESTORE_DELAY: resticRestoreDelay,
      RESTIC_BACKUP_BLOCK_FILE: resticBackupBlock ? backupBlockFile : "",
      RESTIC_RESTORE_BLOCK_FILE: resticRestoreBlock ? restoreBlockFile : "",
      RESTIC_BACKUP_SNAPSHOT_ID: backupSnapshotId,
      RESTIC_SNAPSHOTS_JSON: JSON.stringify(resticSnapshots),
      FAKE_INTEGRITY_RESULT: integrityResult,
      FAKE_DERIVE_SOURCE_BLOB_INTEGRITY: String(deriveSourceBlobIntegrity),
      FAKE_ARTIFACT_STORAGE_KEY: artifactStorageKey,
      FAKE_ARTIFACT_CONTENT: artifactContent,
      FAKE_SOURCE_BLOB_MANIFEST_PATH: sourceBlobManifestFile,
      FAKE_REQUIRE_MANIFEST_MODE: String(requireManifestMode),
      FAKE_SNAPSHOT_ARCHIVE_PATH: snapshotArchiveEntries ? snapshotArchiveFile : "",
      SYSTEM_TAR: systemTar,
      POST_EXTRACT_SYMLINK: String(postExtractSymlink),
      FAKE_WRITABLE_SOURCE_BLOB: String(writableSourceBlob),
      FAKE_WRITABLE_SNAPSHOT_VIEW: String(writableSnapshotView),
      COMPOSE_DIR: root,
      COMPOSE_PROJECT_NAME: "dev-knowledge-hub",
      SNAPSHOT_VOLUME: "devkh_snapshots",
      REPOSITORY_VOLUME: "devkh_repositories",
      UPLOADED_SOURCES_VOLUME: "devkh_sources",
      ARTIFACT_VOLUME: "devkh_artifacts",
      RESTIC_REPOSITORY: "s3:https://example.invalid/devkh",
      RESTIC_PASSWORD_FILE: passwordFile,
      BACKUP_STATE_DIR: stateDirectory
    }
  };
}

function mutateSourceBlobManifest(fixture, mutate) {
  const manifestPath = fixture.environment.FAKE_SOURCE_BLOB_MANIFEST_PATH;
  const manifests = JSON.parse(readFileSync(manifestPath, "utf8"));
  mutate(manifests);
  writeFileSync(manifestPath, `${JSON.stringify(manifests)}\n`, { mode: 0o600 });
}

async function waitForLog(path, pattern, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (pattern.test(readFileSync(path, "utf8"))) return;
    } catch {
      // The command has not written its first log entry yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${pattern}`);
}

function signalProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(child, timeoutMs = 10_000) {
  if (!child.pid) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for child process group exit after ${timeoutMs}ms`);
}

async function waitForChildExit(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(async () => {
      signalProcessGroup(child, "SIGKILL");
      try {
        await waitForProcessGroupExit(child);
        reject(new Error(`Timed out waiting for child process exit after ${timeoutMs}ms`));
      } catch (error) {
        reject(error);
      }
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

test("restarts app and skips retention when the encrypted upload fails", () => {
  const fixture = createFixture({ resticBackupExit: "23" });

  try {
    const result = spawnSync(backupScript, [], {
      env: fixture.environment,
      encoding: "utf8"
    });

    assert.equal(result.status, 23);
    const calls = readFileSync(fixture.log, "utf8");
    assert.match(calls, /docker compose .* stop app/);
    assert.match(calls, /docker compose .* start app/);
    assert.match(calls, /restic backup/);
    assert.doesNotMatch(calls, /restic forget/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("attempts to restart the app when the stop command reports failure", () => {
  const fixture = createFixture({ dockerStopExit: "19" });

  try {
    const result = spawnSync(backupScript, [], {
      env: fixture.environment,
      encoding: "utf8"
    });

    assert.equal(result.status, 19);
    const calls = readFileSync(fixture.log, "utf8");
    assert.match(calls, /docker compose .* stop app/);
    assert.match(calls, /docker compose .* start app/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("refuses a relative Compose directory before changing application state", () => {
  const fixture = createFixture();

  try {
    const result = spawnSync(backupScript, [], {
      env: { ...fixture.environment, COMPOSE_DIR: "." },
      encoding: "utf8"
    });

    assert.equal(result.status, 64);
    assert.match(result.stderr, /COMPOSE_DIR must be an absolute path/);
    assert.equal(readFileSync(fixture.log, "utf8"), "");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("uploads one encrypted set before applying retention", () => {
  const fixture = createFixture();

  try {
    const result = spawnSync(backupScript, [], {
      env: fixture.environment,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(fixture.log, "utf8");
    assert.match(calls, /restic backup --json .*--tag daily/);
    assert.doesNotMatch(calls, /restic snapshots/);
    assert.match(calls, /restic forget --keep-daily 30 --keep-monthly 12 --prune/);
    const status = JSON.parse(readFileSync(join(fixture.environment.BACKUP_STATE_DIR, "status.json"), "utf8"));
    assert.deepEqual(
      { operation: status.operation, result: status.result, snapshotId: status.snapshotId },
      { operation: "backup", result: "success", snapshotId: backupSnapshotId }
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("refuses to seed recovery fixtures outside an isolated CI compose project", () => {
  const fixture = createFixture();

  try {
    const result = spawnSync(ciRecoveryDrillScript, [], {
      env: {
        ...fixture.environment,
        DEVKH_CONTAINER_SMOKE: "true",
        COMPOSE_PROJECT_NAME: "dev-knowledge-hub"
      },
      encoding: "utf8"
    });

    assert.equal(result.status, 64);
    assert.match(result.stderr, /isolated CI Compose project/);
    assert.equal(readFileSync(fixture.log, "utf8"), "");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the recovery fixture seeder refuses direct execution outside an isolated CI compose project", () => {
  const fixture = createFixture();

  try {
    const result = spawnSync(seedRecoveryFixtureScript, [], {
      env: {
        ...fixture.environment,
        DEVKH_CONTAINER_SMOKE: "true",
        COMPOSE_PROJECT_NAME: "dev-knowledge-hub"
      },
      encoding: "utf8"
    });

    assert.equal(result.status, 64);
    assert.match(result.stderr, /isolated CI Compose project/);
    assert.equal(readFileSync(fixture.log, "utf8"), "");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the recovery fixture seeder makes the source blob hardlink inode read-only", () => {
  const seed = readFileSync(seedRecoveryFixtureScript, "utf8");

  assert.match(seed, /ln "\$blob" "\$view\/two\.ts"\n\s+chmod 0444 "\$blob"/);
});

test("interrupted backup and restore operations are recorded as failures", async () => {
  for (const operation of ["backup", "restore-drill"]) {
    const fixture = createFixture(operation === "backup"
      ? { resticBackupBlock: true }
      : { resticRestoreBlock: true });
    const script = operation === "backup" ? backupScript : restoreDrillScript;
    const marker = operation === "backup" ? /restic backup/ : /restic restore/;
    let child;

    try {
      child = spawn(script, [], {
        env: fixture.environment,
        detached: true,
        stdio: "ignore"
      });
      await waitForLog(fixture.log, marker);
      signalProcessGroup(child, "SIGTERM");
      const result = await waitForChildExit(child);

      assert.notEqual(result.code, 0);
      const status = JSON.parse(readFileSync(join(fixture.environment.BACKUP_STATE_DIR, "status.json"), "utf8"));
      assert.equal(status.operation, operation);
      assert.equal(status.result, "failed");
    } finally {
      signalProcessGroup(child, "SIGKILL");
      await waitForProcessGroupExit(child);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("restore drill never writes production Docker volumes", () => {
  const fixture = createFixture();

  try {
    const result = spawnSync(restoreDrillScript, [], {
      env: fixture.environment,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(fixture.log, "utf8");
    assert.match(calls, new RegExp(`restic snapshots --json[\\s\\S]*restic restore ${latestSnapshotId} --target`));
    assert.match(calls, /docker run .*postgres:16-bookworm pg_restore --list \/backup\/database\.pgdump/);
    assert.match(calls, /docker exec .* createdb -U devkh dev_knowledge_hub/);
    assert.match(calls, /docker network create devkh-restore-drill-/);
    assert.match(calls, /docker exec -i devkh-restore-drill-.* pg_restore .*--exit-on-error/);
    assert.match(calls, /docker exec .* psql .*workspaceCount/);
    assert.match(calls, /docker exec .* node -e .*api\/health/);
    assert.match(calls, /docker rm -f devkh-restore-drill-/);
    assert.doesNotMatch(calls, /docker compose .* stop/);
    assert.doesNotMatch(calls, /docker compose .* exec/);
    assert.doesNotMatch(calls, /type=volume/);
    assert.doesNotMatch(calls, /pg_restore .*--clean/);
    const evidenceDirectory = join(fixture.environment.BACKUP_STATE_DIR, "recovery-evidence");
    const [evidenceFile] = execFileSync("find", [evidenceDirectory, "-type", "f"], { encoding: "utf8" }).trim().split("\n");
    const evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
    assert.deepEqual(
      {
        operation: evidence.operation,
        productionVolumeTouched: evidence.productionVolumeTouched,
        restoredSnapshotCount: evidence.restoredSnapshotCount,
        pgRestoreListValidated: evidence.pgRestoreListValidated,
        ephemeralDatabaseRestored: evidence.ephemeralDatabaseRestored,
        healthCheckPassed: evidence.healthCheckPassed,
        volumeArchives: evidence.volumeArchives,
        databaseStats: evidence.databaseStats,
        volumeFileCounts: evidence.volumeFileCounts,
        integrity: evidence.integrity,
        blobReferenceCount: evidence.blobReferenceCount,
        blobContentVerifiedCount: evidence.blobContentVerifiedCount,
        blobHardlinkVerifiedCount: evidence.blobHardlinkVerifiedCount,
        referencedSourceBlobGenerationCount: evidence.referencedSourceBlobGenerationCount,
        sourceBlobLogicalBytes: evidence.sourceBlobLogicalBytes,
        sourceBlobPhysicalBytes: evidence.sourceBlobPhysicalBytes
      },
      {
        operation: "restore-drill",
        productionVolumeTouched: false,
        restoredSnapshotCount: 1,
        pgRestoreListValidated: true,
        ephemeralDatabaseRestored: true,
        healthCheckPassed: true,
        volumeArchives: ["snapshots.tgz", "repositories.tgz", "sources.tgz", "artifacts.tgz"],
        databaseStats: { workspaceCount: 1, userCount: 1, projectCount: 1, projectMemberCount: 1, snapshotCount: 1, releaseCount: 1, releaseChannelCount: 1, artifactCount: 1, sourceAnalysisArtifactCount: 1, sourceBlobCount: 2, sourceFileBlobReferenceCount: 2, referencedSourceBlobGenerationCount: 1 },
        volumeFileCounts: { snapshots: 3, repositories: 1, sources: 1, artifacts: 1 },
        integrity: { orphanedReleases: 0, orphanedReleaseChannels: 0, crossWorkspaceProjectMembers: 0, projectMembersWithoutWorkspaceMembership: 0, orphanedArtifacts: 0, orphanedSourceAnalysisArtifacts: 0, invalidSourceBlobReferences: 0 },
        blobReferenceCount: 2,
        blobContentVerifiedCount: 1,
        blobHardlinkVerifiedCount: 2,
        referencedSourceBlobGenerationCount: 1,
        sourceBlobLogicalBytes: 34,
        sourceBlobPhysicalBytes: 4096
      }
    );
    for (const archive of ["snapshots", "repositories", "sources", "artifacts"]) {
      assert.match(evidence.volumeArchiveSha256[archive], /^[a-f0-9]{64}$/);
    }
    assert.equal(evidence.artifactContentVerifiedCount, 1);
    assert.equal(evidence.schemaVersion, 3);
    assert.equal(evidence.resticSnapshotId, latestSnapshotId);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("restore drill selects the globally newest remote snapshot", () => {
  const olderSnapshotId = "c".repeat(64);
  const fixture = createFixture({
    resticSnapshots: [
      { id: olderSnapshotId, time: "1969-12-30T00:00:00.000Z" },
      { id: latestSnapshotId, time: "1970-01-02T03:45:00.000Z" }
    ]
  });

  try {
    const result = spawnSync(restoreDrillScript, [], {
      env: fixture.environment,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(fixture.log, "utf8");
    assert.match(calls, new RegExp(`restic restore ${latestSnapshotId} --target`));
    assert.doesNotMatch(calls, new RegExp(`restic restore ${olderSnapshotId} --target`));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("preserves the restored fixture when cleanup cannot remove recovery resources", () => {
  const fixture = createFixture({ dockerCleanupExit: "19" });

  try {
    const result = spawnSync(restoreDrillScript, [], {
      env: fixture.environment,
      encoding: "utf8"
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /recovery cleanup failed/);
    assert.match(execFileSync("find", [fixture.environment.BACKUP_STATE_DIR, "-type", "d", "-name", "restore-check.*"], { encoding: "utf8" }), /restore-check/);
    assert.equal(execFileSync("find", [join(fixture.environment.BACKUP_STATE_DIR, "recovery-evidence"), "-type", "f"], { encoding: "utf8" }).trim(), "");
    const status = JSON.parse(readFileSync(join(fixture.environment.BACKUP_STATE_DIR, "status.json"), "utf8"));
    assert.equal(status.result, "failed");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("records a failed cleanup when the restored directory cannot be removed", () => {
  const fixture = createFixture({ restoreCleanupExit: "19" });

  try {
    const result = spawnSync(restoreDrillScript, [], { env: fixture.environment, encoding: "utf8" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /recovery cleanup failed/);
    assert.match(result.stderr, /inspect recovery resources/);
    const status = JSON.parse(readFileSync(join(fixture.environment.BACKUP_STATE_DIR, "status.json"), "utf8"));
    assert.equal(status.result, "failed");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("restore drill rejects artifact content that does not match its manifest digest", () => {
  const fixture = createFixture({ artifactContent: '{"fixture":false}' });

  try {
    const result = spawnSync(restoreDrillScript, [], {
      env: fixture.environment,
      encoding: "utf8"
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /artifact content digest mismatch/);
    assert.match(result.stderr, /retained fixture/);
    assert.match(
      execFileSync("find", [fixture.environment.BACKUP_STATE_DIR, "-type", "d", "-name", "restore-check.*"], { encoding: "utf8" }),
      /restore-check/
    );
    const calls = readFileSync(fixture.log, "utf8");
    assert.doesNotMatch(calls, /docker rm -f/);
    assert.doesNotMatch(calls, /docker network rm/);
    const status = JSON.parse(readFileSync(join(fixture.environment.BACKUP_STATE_DIR, "status.json"), "utf8"));
    assert.equal(status.result, "failed");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("restore drill rejects artifact storage keys outside the runtime manifest path", () => {
  const fixture = createFixture({
    artifactStorageKey: "wrong-project/55555555-5555-4555-8555-555555555555/convert/218589323cbe80b7ed077e3ee36f1663e7cb5f8f4e4ad02c938ad8a5c2c5a6b9.json"
  });

  try {
    const result = spawnSync(restoreDrillScript, [], {
      env: fixture.environment,
      encoding: "utf8"
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /artifact storage key does not match manifest/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("restore drill rejects invalid cross-record relationships", () => {
  const fixture = createFixture({
    integrityResult: '{"orphanedReleases":0,"orphanedReleaseChannels":0,"crossWorkspaceProjectMembers":0,"projectMembersWithoutWorkspaceMembership":0,"orphanedArtifacts":1}'
  });

  try {
    const result = spawnSync(restoreDrillScript, [], {
      env: fixture.environment,
      encoding: "utf8"
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restored database integrity check failed/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("restore drill rejects source blob references that are not backed by a same-inode snapshot view", () => {
  const fixture = createFixture();
  mutateSourceBlobManifest(fixture, (manifests) => { manifests[0].path = "src/missing.ts"; });

  try {
    const result = spawnSync(restoreDrillScript, [], { env: fixture.environment, encoding: "utf8" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /snapshot view is unavailable/);
    assert.equal(existsSync(join(fixture.environment.BACKUP_STATE_DIR, "recovery-evidence")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("restore drill accepts unreferenced deleted source blob generations", () => {
  const fixture = createFixture();

  try {
    const result = spawnSync(restoreDrillScript, [], { env: fixture.environment, encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const evidenceDirectory = join(fixture.environment.BACKUP_STATE_DIR, "recovery-evidence");
    const [evidenceFile] = execFileSync("find", [evidenceDirectory, "-type", "f"], { encoding: "utf8" }).trim().split("\n");
    const evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
    assert.equal(evidence.databaseStats.sourceBlobCount, 2);
    assert.equal(evidence.databaseStats.referencedSourceBlobGenerationCount, 1);
    assert.equal(evidence.referencedSourceBlobGenerationCount, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("restore drill rejects source-file references to trash or deleted source blobs", () => {
  for (const status of ["trash", "deleted"]) {
    const fixture = createFixture();
    mutateSourceBlobManifest(fixture, (manifests) => {
      for (const manifest of manifests) {
        manifest.status = status;
        manifest.fencingToken = sourceBlobFence;
        manifest.tombstonedAt = "2026-07-20T00:00:00.000Z";
        manifest.trashedAt = "2026-07-21T00:00:00.000Z";
        manifest.deletedAt = status === "deleted" ? "2026-07-22T00:00:00.000Z" : null;
      }
    });

    try {
      const result = spawnSync(restoreDrillScript, [], { env: fixture.environment, encoding: "utf8" });

      assert.notEqual(result.status, 0, status);
      assert.match(result.stderr, /restored database integrity check failed/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("restore drill rejects a snapshot storage path that only has the expected suffix", () => {
  const fixture = createFixture();
  mutateSourceBlobManifest(fixture, (manifests) => {
    manifests[0].snapshotStoragePath = manifests[0].snapshotStoragePath.replace(
      "/var/lib/devkh/snapshots/snapshots/",
      "/tmp/attacker-controlled/snapshots/"
    );
  });

  try {
    const result = spawnSync(restoreDrillScript, [], { env: fixture.environment, encoding: "utf8" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /snapshot storage path does not match manifest/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("restore drill rejects source-file paths containing backslashes", () => {
  const fixture = createFixture();
  mutateSourceBlobManifest(fixture, (manifests) => { manifests[0].path = "src\\one.ts"; });

  try {
    const result = spawnSync(restoreDrillScript, [], { env: fixture.environment, encoding: "utf8" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid source blob path/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("restore drill reads source blob manifests larger than 256 KiB from a mode-0600 file", () => {
  const fixture = createFixture({ sourceBlobManifestPaddingBytes: 300 * 1024, requireManifestMode: true });

  try {
    const result = spawnSync(restoreDrillScript, [], { env: fixture.environment, encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(restoreDrillScript, "utf8"), /source_blob_manifest_path/);
    assert.doesNotMatch(readFileSync(restoreDrillScript, "utf8"), /"\$source_blob_manifests"/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("tar validation streams a highly compressed regular-file body without buffering it", async () => {
  const uncompressedBodyBytes = 2 * 1024 * 1024;
  const compressed = gzipTar([{ name: "large.bin", contents: Buffer.alloc(uncompressedBodyBytes, 0x61) }]);
  const { validateTarArchive } = await import(validateTarArchiveScript);
  let maximumBufferedBytes = 0;

  async function* chunks() {
    for (let offset = 0; offset < compressed.length; offset += 37) {
      yield compressed.subarray(offset, offset + 37);
    }
  }

  await validateTarArchive("unused-by-injected-stream", {
    createInputStream: () => Readable.from(chunks()),
    maxMetadataBytes: 1024,
    onBufferedBytes: (bytes) => { maximumBufferedBytes = Math.max(maximumBufferedBytes, bytes); }
  });

  assert.ok(compressed.length < 16 * 1024, `expected a small compressed fixture, got ${compressed.length}`);
  assert.ok(maximumBufferedBytes <= 1024, `buffered ${maximumBufferedBytes} bytes`);
  assert.doesNotMatch(readFileSync(validateTarArchiveScript, "utf8"), /readFileSync|gunzipSync/);
});

test("tar validation rejects oversized buffered metadata", async () => {
  const compressed = gzipTar([{ name: "pax-header", type: "x", contents: Buffer.alloc(2048, 0x61) }]);
  const { validateTarArchive } = await import(validateTarArchiveScript);

  await assert.rejects(
    validateTarArchive("unused-by-injected-stream", {
      createInputStream: () => Readable.from([compressed]),
      maxMetadataBytes: 1024
    }),
    /archive metadata exceeds safe limit/
  );
});

for (const [name, options, message] of [
  ["source blob", { writableSourceBlob: true }, /source blob content must be read-only/],
  ["snapshot view", { writableSnapshotView: true }, /snapshot view must be read-only/]
]) {
  test(`restore drill rejects a writable ${name}`, () => {
    const fixture = createFixture(options);

    try {
      const result = spawnSync(restoreDrillScript, [], { env: fixture.environment, encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("restore drill accepts a strictly formed tombstoned source blob reference", () => {
  const fixture = createFixture();
  mutateSourceBlobManifest(fixture, (manifests) => {
    for (const manifest of manifests) {
      manifest.status = "tombstoned";
      manifest.fencingToken = sourceBlobFence;
      manifest.tombstonedAt = "2026-07-20T00:00:00.000Z";
    }
  });

  try {
    const result = spawnSync(restoreDrillScript, [], { env: fixture.environment, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("restore drill independently rejects invalid active source blob state metadata", () => {
  const fixture = createFixture({ deriveSourceBlobIntegrity: false });
  mutateSourceBlobManifest(fixture, (manifests) => { manifests[0].fencingToken = sourceBlobFence; });

  try {
    const result = spawnSync(restoreDrillScript, [], { env: fixture.environment, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid active source blob state/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const [condition, mutate] of [
  ["missing fence", (manifest) => { manifest.fencingToken = null; }],
  ["missing tombstone time", (manifest) => { manifest.tombstonedAt = null; }],
  ["trash time present", (manifest) => { manifest.trashedAt = "2026-07-21T00:00:00.000Z"; }],
  ["deleted time present", (manifest) => { manifest.deletedAt = "2026-07-22T00:00:00.000Z"; }]
]) {
  test(`restore drill rejects tombstoned source blob state with ${condition}`, () => {
    const fixture = createFixture({ deriveSourceBlobIntegrity: false });
    mutateSourceBlobManifest(fixture, (manifests) => {
      manifests[0].status = "tombstoned";
      manifests[0].fencingToken = sourceBlobFence;
      manifests[0].tombstonedAt = "2026-07-20T00:00:00.000Z";
      mutate(manifests[0]);
    });

    try {
      const result = spawnSync(restoreDrillScript, [], { env: fixture.environment, encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /invalid tombstoned source blob state/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("restore drill rejects an archive with an intermediate-directory symlink escape", () => {
  const fixture = createFixture({ snapshotArchiveEntries: [
    { name: "escape", type: "2", linkName: "../outside" },
    { name: "escape/payload", contents: "owned" }
  ] });

  try {
    const result = spawnSync(restoreDrillScript, [], { env: fixture.environment, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsafe archive member type/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("restore drill rejects a symlink discovered only after archive extraction", () => {
  const fixture = createFixture({ postExtractSymlink: true });

  try {
    const result = spawnSync(restoreDrillScript, [], { env: fixture.environment, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsafe symlink in extracted archive/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("restore drill rejects archive hardlinks that escape the extraction root", () => {
  const fixture = createFixture({ snapshotArchiveEntries: [
    { name: "inside", type: "1", linkName: "../../outside" }
  ] });

  try {
    const result = spawnSync(restoreDrillScript, [], { env: fixture.environment, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsafe archive hardlink target/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("restore drill rejects non-regular archive members", () => {
  const fixture = createFixture({ snapshotArchiveEntries: [
    { name: "named-pipe", type: "6" }
  ] });

  try {
    const result = spawnSync(restoreDrillScript, [], { env: fixture.environment, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsafe archive member type/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("systemd backup timer keeps credentials outside its unit file", () => {
  const timer = readFileSync(join(projectRoot, "deployment/backup/devkh-backup.timer"), "utf8");
  const service = readFileSync(join(projectRoot, "deployment/backup/devkh-backup.service"), "utf8");
  const environment = readFileSync(join(projectRoot, "deployment/backup/backup.env.example"), "utf8");

  assert.match(timer, /OnCalendar=\*-\*-\* 03:30:00/);
  assert.match(timer, /Persistent=true/);
  assert.match(service, /EnvironmentFile=\/etc\/devkh-backup\/backup.env/);
  assert.doesNotMatch(service, /AWS_SECRET_ACCESS_KEY|RESTIC_PASSWORD=/);
  assert.match(service, /UMask=0077/);
  assert.match(service, /ReadWritePaths=\/var\/lib\/devkh-backup/);
  assert.match(environment, /RESTIC_CACHE_DIR=\/var\/lib\/devkh-backup\/restic-cache/);
});

test("backs up durable sources and content-addressed artifacts separately from upload staging", () => {
  const backup = readFileSync(backupScript, "utf8");
  const restore = readFileSync(restoreDrillScript, "utf8");
  const environment = readFileSync(join(projectRoot, "deployment/backup/backup.env.example"), "utf8");

  assert.match(environment, /UPLOADED_SOURCES_VOLUME=/);
  assert.match(environment, /ARTIFACT_VOLUME=/);
  assert.doesNotMatch(environment, /UPLOAD_VOLUME=/);
  assert.match(backup, /sources:\$UPLOADED_SOURCES_VOLUME/);
  assert.match(backup, /artifacts:\$ARTIFACT_VOLUME/);
  assert.doesNotMatch(backup, /uploads:\$UPLOAD_VOLUME/);
  assert.match(restore, /sources\.tgz/);
  assert.match(restore, /artifacts\.tgz/);
  assert.doesNotMatch(restore, /uploads\.tgz/);
  assert.match(restore, /b\.snapshot_id<>r\.snapshot_id/);
  assert.match(restore, /s\.repository_id<>r\.repository_id/);
  assert.match(restore, /r\.repository_id<>c\.repository_id/);
  assert.match(restore, /repo\.project_id<>a\.project_id/);
  assert.match(restore, /s\.repository_id<>b\.repository_id/);
  assert.match(restore, /artifact content digest mismatch/);
  assert.match(backup, /snapshots:\$SNAPSHOT_VOLUME/);
  assert.match(restore, /source_blob_manifests/);
  assert.match(restore, /same-inode hardlink/);
});
