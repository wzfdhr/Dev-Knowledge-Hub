import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDirectory, "../..");
const backupScript = join(scriptDirectory, "devkh-backup.sh");
const restoreDrillScript = join(scriptDirectory, "devkh-restore-drill.sh");

function createFixture({ resticBackupExit = "0" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "devkh-backup-"));
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  const stateDirectory = join(root, "state");
  const passwordFile = join(root, "restic-password");
  execFileSync("mkdir", ["-p", bin]);
  writeFileSync(passwordFile, "test-only-password\n", { mode: 0o600 });
  writeFileSync(join(bin, "docker"), String.raw`#!/usr/bin/env sh
printf 'docker %s\n' "$*" >> "$CALL_LOG"
case " $* " in
  *" compose "*" exec "*) printf 'fake-pgdump\n' ;;
  *" pg_restore "*) printf 'pg_restore %s\n' "$*" >> "$CALL_LOG" ;;
  *" run "*)
    stage=$(printf '%s\n' "$*" | sed -n 's/.*type=bind,src=\([^,]*\),dst=\/backup.*/\1/p')
    archive=$(printf '%s\n' "$*" | sed -n 's/.*\/backup\/\([^ ]*\.tgz\).*/\1/p')
    : > "$stage/$archive"
    ;;
esac
`);
  writeFileSync(join(bin, "restic"), String.raw`#!/usr/bin/env sh
printf 'restic %s\n' "$*" >> "$CALL_LOG"
case "$1" in
  backup) exit "$RESTIC_BACKUP_EXIT" ;;
  snapshots) printf '[{"short_id":"abc123"}]' ;;
  restore)
    target=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--target" ]; then target="$2"; shift 2; else shift; fi
    done
    set_directory="$target/backup-set"
    empty_directory="$target/empty"
    mkdir -p "$set_directory" "$empty_directory"
    printf 'fake-pgdump\n' > "$set_directory/database.pgdump"
    tar -C "$empty_directory" -czf "$set_directory/snapshots.tgz" .
    tar -C "$empty_directory" -czf "$set_directory/repositories.tgz" .
    tar -C "$empty_directory" -czf "$set_directory/sources.tgz" .
    tar -C "$empty_directory" -czf "$set_directory/uploads.tgz" .
    (cd "$set_directory" && sha256sum database.pgdump snapshots.tgz repositories.tgz sources.tgz uploads.tgz > checksums.sha256)
    printf '{"schemaVersion":1}\n' > "$set_directory/manifest.json"
    ;;
esac
`);
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "restic"), 0o755);

  return {
    root,
    log,
    environment: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALL_LOG: log,
      RESTIC_BACKUP_EXIT: resticBackupExit,
      COMPOSE_DIR: root,
      COMPOSE_PROJECT_NAME: "dev-knowledge-hub",
      SNAPSHOT_VOLUME: "devkh_snapshots",
      REPOSITORY_VOLUME: "devkh_repositories",
      UPLOADED_SOURCES_VOLUME: "devkh_sources",
      UPLOAD_VOLUME: "devkh_uploads",
      RESTIC_REPOSITORY: "s3:https://example.invalid/devkh",
      RESTIC_PASSWORD_FILE: passwordFile,
      BACKUP_STATE_DIR: stateDirectory
    }
  };
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

test("uploads one encrypted set before applying retention", () => {
  const fixture = createFixture();

  try {
    const result = spawnSync(backupScript, [], {
      env: fixture.environment,
      encoding: "utf8"
    });

    assert.equal(result.status, 0);
    const calls = readFileSync(fixture.log, "utf8");
    assert.match(calls, /restic backup .*--tag daily/);
    assert.match(calls, /restic forget --keep-daily 30 --keep-monthly 12 --prune/);
    const status = JSON.parse(readFileSync(join(fixture.environment.BACKUP_STATE_DIR, "status.json"), "utf8"));
    assert.deepEqual(
      { operation: status.operation, result: status.result, snapshotId: status.snapshotId },
      { operation: "backup", result: "success", snapshotId: "abc123" }
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("restore drill never writes production Docker volumes", () => {
  const fixture = createFixture();

  try {
    const result = spawnSync(restoreDrillScript, [], {
      env: fixture.environment,
      encoding: "utf8"
    });

    assert.equal(result.status, 0);
    const calls = readFileSync(fixture.log, "utf8");
    assert.match(calls, /restic restore latest --target/);
    assert.match(calls, /docker run .*postgres:16-bookworm pg_restore --list \/backup\/database\.pgdump/);
    assert.doesNotMatch(calls, /docker compose .* stop/);
    assert.doesNotMatch(calls, /docker compose .* exec/);
    assert.doesNotMatch(calls, /pg_restore .*--clean/);
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

test("backs up the durable uploaded source volume separately from upload staging", () => {
  const backup = readFileSync(backupScript, "utf8");
  const restore = readFileSync(restoreDrillScript, "utf8");
  const environment = readFileSync(join(projectRoot, "deployment/backup/backup.env.example"), "utf8");

  assert.match(environment, /UPLOADED_SOURCES_VOLUME=/);
  assert.match(backup, /sources:\$UPLOADED_SOURCES_VOLUME/);
  assert.match(restore, /sources\.tgz/);
});
