import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDirectory, "../..");
const monitorScript = join(scriptDirectory, "devkh-monitor.sh");

function fixture({ snapshotTime = "1970-01-02T03:45:00.000Z", importCounts = "0|0" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "devkh-monitor-"));
  const bin = join(root, "bin");
  const state = join(root, "state");
  const backupEnv = join(root, "backup.env");
  mkdirSync(bin);
  const writeExecutable = (name, source) => {
    const destination = join(bin, name);
    writeFileSync(destination, source);
    chmodSync(destination, 0o755);
  };

  writeFileSync(backupEnv, "RESTIC_REPOSITORY=s3:https://example.invalid/devkh\nRESTIC_PASSWORD_FILE=/tmp/password\n");
  writeFileSync(join(root, "docker-compose.yml"), "services: {}\n");
  writeExecutable("curl", "#!/usr/bin/env sh\nexit 0\n");
  writeExecutable("docker", `#!/usr/bin/env sh\ncase "$*" in *exec*) printf '%s\\n' '${importCounts}' ;; *) printf "app healthy\\npostgres healthy\\n" ;; esac\n`);
  writeExecutable("df", "#!/usr/bin/env sh\nprintf \"Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/vda 100 70 30 70%% /\\n\"\n");
  writeExecutable("restic", `#!/usr/bin/env sh\nprintf '%s\\n' '${JSON.stringify([{ time: snapshotTime }])}'\n`);

  return {
    root,
    environment: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      COMPOSE_DIR: root,
      COMPOSE_PROJECT_NAME: "dev-knowledge-hub",
      APP_HEALTH_URL: "http://127.0.0.1:3000/api/health",
      BACKUP_ENV_FILE: backupEnv,
      MONITOR_STATE_DIR: state,
      DISK_PATH: "/",
      MAX_DISK_USED_PERCENT: "85",
      MAX_BACKUP_AGE_SECONDS: "108000",
      MAX_IMPORT_FAILURE_RATE_PERCENT: "25",
      DEVKH_MONITOR_NOW_EPOCH_SECONDS: "100000"
    }
  };
}

test("writes a sanitized successful status when all operational checks pass", () => {
  const value = fixture();
  try {
    const result = spawnSync(monitorScript, [], { env: value.environment, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(readFileSync(join(value.root, "state", "status.json"), "utf8"));
    assert.equal(status.schemaVersion, 1);
    assert.equal(status.result, "success");
    assert.match(status.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(status.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(status.failures, []);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("fails when at least four recent imports exceed the configured failure rate", () => {
  const value = fixture({ importCounts: "3|10" });
  try {
    const result = spawnSync(monitorScript, [], { env: value.environment, encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    const status = JSON.parse(readFileSync(join(value.root, "state", "status.json"), "utf8"));
    assert.deepEqual(status.failures, ["import_failure_rate"]);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("fails when the latest encrypted backup is stale", () => {
  const value = fixture({ snapshotTime: "1969-12-30T00:00:00.000Z" });
  try {
    const result = spawnSync(monitorScript, [], { env: value.environment, encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    const status = JSON.parse(readFileSync(join(value.root, "state", "status.json"), "utf8"));
    assert.equal(status.result, "failed");
    assert.deepEqual(status.failures, ["backup_freshness"]);
    assert.doesNotMatch(readFileSync(join(value.root, "state", "status.json"), "utf8"), /example\.invalid/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("refuses a relative Compose directory before querying operational services", () => {
  const value = fixture();
  try {
    const result = spawnSync(monitorScript, [], {
      env: { ...value.environment, COMPOSE_DIR: "." },
      encoding: "utf8"
    });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /COMPOSE_DIR must be an absolute path/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("systemd monitoring timer keeps configuration and credentials outside unit files", () => {
  const service = readFileSync(join(projectRoot, "deployment/monitoring/devkh-monitor.service"), "utf8");
  const timer = readFileSync(join(projectRoot, "deployment/monitoring/devkh-monitor.timer"), "utf8");
  const environment = readFileSync(join(projectRoot, "deployment/monitoring/monitor.env.example"), "utf8");

  assert.match(service, /EnvironmentFile=\/etc\/devkh-monitor\/monitor\.env/);
  assert.match(service, /ReadWritePaths=\/var\/lib\/devkh-monitor/);
  assert.doesNotMatch(service, /AWS_SECRET_ACCESS_KEY|RESTIC_PASSWORD=/);
  assert.match(timer, /OnCalendar=\*:0\/5/);
  assert.match(timer, /Persistent=true/);
  assert.match(environment, /MAX_BACKUP_AGE_SECONDS=108000/);
});
