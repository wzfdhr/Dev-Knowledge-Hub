import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDirectory, "../..");
const backupScript = join(scriptDirectory, "devkh-backup.sh");
const restoreDrillScript = join(scriptDirectory, "devkh-restore-drill.sh");
const ciRecoveryDrillScript = join(scriptDirectory, "ci-recovery-drill.sh");
const seedRecoveryFixtureScript = join(scriptDirectory, "seed-ci-recovery-fixture.sh");
const backupSnapshotId = "a".repeat(64);
const latestSnapshotId = "b".repeat(64);

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
  resticSnapshots = [{ id: latestSnapshotId, time: "1970-01-02T03:45:00.000Z" }],
  integrityResult = '{"orphanedReleases":0,"orphanedReleaseChannels":0,"crossWorkspaceProjectMembers":0,"projectMembersWithoutWorkspaceMembership":0,"orphanedArtifacts":0,"orphanedSourceAnalysisArtifacts":0}',
  artifactStorageKey = "33333333-3333-4333-8333-333333333333/55555555-5555-4555-8555-555555555555/convert/218589323cbe80b7ed077e3ee36f1663e7cb5f8f4e4ad02c938ad8a5c2c5a6b9.json",
  artifactContent = '{"fixture":true}'
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "devkh-backup-"));
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  const stateDirectory = join(root, "state");
  const passwordFile = join(root, "restic-password");
  const backupBlockFile = join(root, "backup.block");
  const restoreBlockFile = join(root, "restore.block");
  execFileSync("mkdir", ["-p", bin]);
  writeFileSync(log, "");
  writeFileSync(passwordFile, "test-only-password\n", { mode: 0o600 });
  writeFileSync(join(bin, "docker"), String.raw`#!/usr/bin/env sh
printf 'docker %s\n' "$*" >> "$CALL_LOG"
case " $* " in
  *" compose "*" stop app "*) exit "$DOCKER_STOP_EXIT" ;;
  *" rm -f "*|*" network rm "*) exit "$DOCKER_CLEANUP_EXIT" ;;
  *" compose "*" exec "*) printf 'fake-pgdump\n' ;;
  *" compose "*" images -q app "*) printf 'devkh-recovery-image\n' ;;
  *" pg_restore "*) printf 'pg_restore %s\n' "$*" >> "$CALL_LOG" ;;
  *" psql "*"workspaceCount"*) printf '{"workspaceCount":1,"userCount":1,"projectCount":1,"projectMemberCount":1,"snapshotCount":1,"releaseCount":1,"releaseChannelCount":1,"artifactCount":1,"sourceAnalysisArtifactCount":1}\n' ;;
  *" psql "*"orphanedReleases"*) printf '%s\n' "$FAKE_INTEGRITY_RESULT" ;;
  *" psql "*"artifact_manifests"*) printf '[{"projectId":"33333333-3333-4333-8333-333333333333","snapshotId":"55555555-5555-4555-8555-555555555555","stage":"convert","storageKey":"%s","contentDigest":"218589323cbe80b7ed077e3ee36f1663e7cb5f8f4e4ad02c938ad8a5c2c5a6b9"}]\n' "$FAKE_ARTIFACT_STORAGE_KEY" ;;
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
    for name in snapshots repositories sources; do
      mkdir -p "$empty_directory/$name/recovery"
      printf '%s\n' "$name" > "$empty_directory/$name/recovery/fixture.txt"
      tar -C "$empty_directory/$name" -czf "$set_directory/$name.tgz" .
    done
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
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "restic"), 0o755);
  chmodSync(join(bin, "rm"), 0o755);

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
      FAKE_ARTIFACT_STORAGE_KEY: artifactStorageKey,
      FAKE_ARTIFACT_CONTENT: artifactContent,
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
        integrity: evidence.integrity
      },
      {
        operation: "restore-drill",
        productionVolumeTouched: false,
        restoredSnapshotCount: 1,
        pgRestoreListValidated: true,
        ephemeralDatabaseRestored: true,
        healthCheckPassed: true,
        volumeArchives: ["snapshots.tgz", "repositories.tgz", "sources.tgz", "artifacts.tgz"],
        databaseStats: { workspaceCount: 1, userCount: 1, projectCount: 1, projectMemberCount: 1, snapshotCount: 1, releaseCount: 1, releaseChannelCount: 1, artifactCount: 1, sourceAnalysisArtifactCount: 1 },
        volumeFileCounts: { snapshots: 1, repositories: 1, sources: 1, artifacts: 1 },
        integrity: { orphanedReleases: 0, orphanedReleaseChannels: 0, crossWorkspaceProjectMembers: 0, projectMembersWithoutWorkspaceMembership: 0, orphanedArtifacts: 0, orphanedSourceAnalysisArtifacts: 0 }
      }
    );
    for (const archive of ["snapshots", "repositories", "sources", "artifacts"]) {
      assert.match(evidence.volumeArchiveSha256[archive], /^[a-f0-9]{64}$/);
    }
    assert.equal(evidence.artifactContentVerifiedCount, 1);
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
});
