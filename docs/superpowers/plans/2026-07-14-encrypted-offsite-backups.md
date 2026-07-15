# Encrypted Offsite Backups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver encrypted, off-host, application-consistent backups for production Dev Knowledge Hub and prove a recovery point can be read without touching production data.

**Architecture:** Root-owned Bash scripts make a short-lived local set from PostgreSQL and the three data volumes. Restic encrypts it before storing it in private Alibaba OSS. Systemd triggers daily backup, weekly integrity check, and monthly isolated restore drill.

**Tech Stack:** Bash, Docker Compose, PostgreSQL `pg_dump`/`pg_restore`, restic, Alibaba OSS S3 API, systemd, Node.js test harness.

## Global Constraints

- Preserve existing Tailscale-only application access; never open another public port.
- A backup set contains PostgreSQL plus `snapshot_data`, `repository_mirrors`, and `upload_staging`.
- Stop only `app` while staging. A trap restarts it after any post-stop exit.
- Retain 30 daily and 12 monthly snapshots. Never prune after a failed upload.
- No secret, `.env`, `DEVKH_MASTER_KEY`, archive content, or raw database data may enter Git, status JSON, or logs.
- Do not modify existing uncommitted package/runtime changes, apart from appending `test:backup` to `package.json`.
- OSS activation, Bucket/RAM-key creation, and recovery-password generation require a new user confirmation immediately before execution.

## Files

- Create `scripts/backup/lib.sh` — environment validation, secret-free status writing, checksums, latest snapshot ID.
- Create `scripts/backup/devkh-backup.sh` — staging, archive, restic backup, retention.
- Create `scripts/backup/devkh-restore-drill.sh` — restore into a temporary folder and validate it.
- Create `scripts/backup/backup.test.mjs` — fake `docker`/`restic` test harness.
- Create `deployment/backup/` systemd services/timers and a non-secret environment template.
- Create `docs/operations/encrypted-offsite-backups.md` and update `README.md`.

---

### Task 1: Establish Tested Backup Interfaces

**Files:**
- Create: `scripts/backup/lib.sh`
- Create: `scripts/backup/backup.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Export `require_backup_env()`, `write_status()`, `write_checksums()`, and `latest_snapshot_id()`.
- Require `COMPOSE_DIR`, `COMPOSE_PROJECT_NAME`, `SNAPSHOT_VOLUME`, `REPOSITORY_VOLUME`, `UPLOAD_VOLUME`, `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE`, and `BACKUP_STATE_DIR`.
- Expose `npm run test:backup`.

- [ ] **Step 1: Write the failing orchestration test**

Create a Node test fixture that puts fake `docker` and `restic` executables first in `PATH`. It logs arguments in `CALL_LOG` and returns exit 23 only for `restic backup`.

```js
test("restarts app and skips retention when upload fails", () => {
  const run = fixture({ resticBackupExit: "23" });
  assert.throws(() => execFileSync(backup, [], { env: run.env, stdio: "pipe" }));
  const calls = readFileSync(run.log, "utf8");
  assert.match(calls, /docker compose .* stop app/);
  assert.match(calls, /docker compose .* start app/);
  assert.match(calls, /restic backup/);
  assert.doesNotMatch(calls, /restic forget/);
});
```

- [ ] **Step 2: Verify red**

Run: `node --test scripts/backup/backup.test.mjs`

Expected: FAIL because `devkh-backup.sh` does not exist.

- [ ] **Step 3: Create shared helpers**

Implement strict Bash helpers. Status is written through `status.json.tmp` with mode `0600` then renamed atomically. It contains schema version, operation, result, start/end time, snapshot ID or null, and fixed error class or null. It never receives stderr.

```bash
require_backup_env() {
  local name
  for name in COMPOSE_DIR COMPOSE_PROJECT_NAME SNAPSHOT_VOLUME REPOSITORY_VOLUME UPLOAD_VOLUME RESTIC_REPOSITORY RESTIC_PASSWORD_FILE BACKUP_STATE_DIR; do
    [[ -n "${!name:-}" ]] || { printf 'missing required backup setting: %s\n' "$name" >&2; return 64; }
  done
  [[ -r "$RESTIC_PASSWORD_FILE" ]] || return 64
}
write_checksums() { (cd "$1" && sha256sum database.pgdump snapshots.tgz repositories.tgz uploads.tgz > checksums.sha256); }
```

`latest_snapshot_id` parses `restic snapshots --latest 1 --json` using Node and outputs only `short_id`.

- [ ] **Step 4: Add test command and commit**

Add:

```json
"test:backup": "node --test scripts/backup/backup.test.mjs"
```

Run: `npm run test:backup`

Expected: still FAIL until Task 2.

```bash
git add scripts/backup/lib.sh scripts/backup/backup.test.mjs package.json
git commit -m "test: define backup orchestration contract"
```

### Task 2: Implement Backup And Restore Drill

**Files:**
- Create: `scripts/backup/devkh-backup.sh`
- Create: `scripts/backup/devkh-restore-drill.sh`
- Modify: `scripts/backup/backup.test.mjs`

**Interfaces:**
- Each snapshot root contains `database.pgdump`, `snapshots.tgz`, `repositories.tgz`, `uploads.tgz`, `checksums.sha256`, and `manifest.json`.
- Backup status operation is `backup`; drill status operation is `restore-drill`.
- Drill cannot stop Compose, run a Docker volume write, or invoke `pg_restore --clean`.

- [ ] **Step 1: Extend tests first**

Add a success assertion for `restic backup ... --tag daily`, `restic forget --keep-daily 30 --keep-monthly 12 --prune`, and a status with `snapshotId: "abc123"`. Make fake restic create a test backup set for `restic restore latest --target`. Assert the drill does not log write-capable Docker actions.

```js
assert.match(calls, /restic backup .*--tag daily/);
assert.match(calls, /restic forget --keep-daily 30 --keep-monthly 12 --prune/);
assert.doesNotMatch(calls, /docker compose .* stop/);
assert.doesNotMatch(calls, /docker run/);
assert.doesNotMatch(calls, /pg_restore --clean/);
```

- [ ] **Step 2: Verify red**

Run: `npm run test:backup`

Expected: FAIL because both operational scripts are absent.

- [ ] **Step 3: Implement the application-consistent backup**

Source `lib.sh`, stage under `BACKUP_STATE_DIR`, stop `app`, dump only the configured production database in custom format, archive each named volume read-only, checksum the artifacts, write a manifest with timestamp/Git revision/filenames, and start `app` before network upload. The `EXIT INT TERM` trap restarts app if needed and writes only `backup_failed` on error.

```bash
(cd "$COMPOSE_DIR" && docker compose -f "$COMPOSE_DIR/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" stop app)
app_stopped=1
(cd "$COMPOSE_DIR" && docker compose -f "$COMPOSE_DIR/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" exec -T postgres pg_dump -U devkh -d dev_knowledge_hub -Fc) > "$stage/database.pgdump"
for pair in "snapshots:$SNAPSHOT_VOLUME" "repositories:$REPOSITORY_VOLUME" "uploads:$UPLOAD_VOLUME"; do
  name="${pair%%:*}"; volume="${pair#*:}"
  docker run --rm --mount "type=volume,src=$volume,dst=/source,readonly" --mount "type=bind,src=$stage,dst=/backup" alpine:3.20 tar -C /source -czf "/backup/$name.tgz" .
done
write_checksums "$stage"
(cd "$COMPOSE_DIR" && docker compose -f "$COMPOSE_DIR/docker-compose.yml" -p "$COMPOSE_PROJECT_NAME" start app)
app_stopped=0
restic backup "$stage" --tag daily
snapshot_id="$(latest_snapshot_id)"
restic forget --keep-daily 30 --keep-monthly 12 --prune
```

Add `--tag monthly` when local day is `01`. Retention remains below the successful restic backup command, so it cannot run after an upload failure.

- [ ] **Step 4: Implement isolated restore validation**

Restore with `restic restore latest --target "$target"` where target is `mktemp -d "$BACKUP_STATE_DIR/restore-check.XXXXXX"`. Find the restored `manifest.json`, check the checksum file, list each archive, and only parse the dump. The cleanup trap deletes only this temporary target.

```bash
(cd "$set_dir" && sha256sum -c checksums.sha256)
tar -tzf "$set_dir/snapshots.tgz" >/dev/null
tar -tzf "$set_dir/repositories.tgz" >/dev/null
tar -tzf "$set_dir/uploads.tgz" >/dev/null
pg_restore --list "$set_dir/database.pgdump" >/dev/null
```

- [ ] **Step 5: Verify and commit**

```bash
bash -n scripts/backup/lib.sh scripts/backup/devkh-backup.sh scripts/backup/devkh-restore-drill.sh
npm run test:backup
git add scripts/backup/devkh-backup.sh scripts/backup/devkh-restore-drill.sh scripts/backup/backup.test.mjs
git commit -m "feat: add encrypted backup and restore drill"
```

Expected: syntax and focused tests exit `0`.

### Task 3: Add Systemd Assets And Operations Documentation

**Files:**
- Create: `deployment/backup/devkh-backup.service`
- Create: `deployment/backup/devkh-backup.timer`
- Create: `deployment/backup/devkh-restic-check.service`
- Create: `deployment/backup/devkh-restic-check.timer`
- Create: `deployment/backup/devkh-restore-drill.service`
- Create: `deployment/backup/devkh-restore-drill.timer`
- Create: `deployment/backup/backup.env.example`
- Create: `docs/operations/encrypted-offsite-backups.md`
- Modify: `README.md`
- Modify: `scripts/backup/backup.test.mjs`

- [ ] **Step 1: Add a static template test**

Assert the service reads an external environment file and no unit embeds secrets; assert the daily timer is persistent at 03:30.

```js
assert.match(daily, /OnCalendar=\*-\*-\* 03:30:00/);
assert.match(daily, /Persistent=true/);
assert.match(service, /EnvironmentFile=\/etc\/devkh-backup\/backup.env/);
assert.doesNotMatch(service, /AWS_SECRET_ACCESS_KEY|RESTIC_PASSWORD=/);
```

- [ ] **Step 2: Verify red**

Run: `npm run test:backup`

Expected: FAIL because `deployment/backup` does not exist.

- [ ] **Step 3: Create services, timers, and environment template**

Use the same hardening for backup, check, and restore services. The check service runs `restic check`; the drill service runs the drill script. Set weekly/monthly persistent timers for those two services.

```ini
[Service]
Type=oneshot
User=root
EnvironmentFile=/etc/devkh-backup/backup.env
ExecStart=/usr/local/lib/devkh-backup/devkh-backup.sh
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=/var/lib/devkh-backup
```

```ini
[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
RandomizedDelaySec=15m
Unit=devkh-backup.service
```

The example must contain `COMPOSE_DIR`, `COMPOSE_PROJECT_NAME`, three volume names, `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE`, `BACKUP_STATE_DIR`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_DEFAULT_REGION`, all using non-secret placeholders.

- [ ] **Step 4: Write runbook and README pointer**

The runbook must cover private non-Hangzhou OSS, Bucket/prefix-restricted RAM, independent restic password plus separately held `DEVKH_MASTER_KEY`, `0600 root:root` secret files, verified restic installation, timer/journal checks, RAM-key revocation, and full restore into an empty compatible deployment. Replace README's manual archive commands with this runbook link while preserving the master-key warning.

- [ ] **Step 5: Verify and commit**

```bash
npm run test:backup
git diff --check
git add deployment/backup docs/operations/encrypted-offsite-backups.md README.md scripts/backup/backup.test.mjs
git commit -m "docs: add encrypted backup operations"
```

Expected: all checks exit `0`.

### Task 4: Create Cloud Resources After Fresh Authorization

**Files:**
- Modify: `docs/operations/encrypted-offsite-backups.md` only for verified non-secret inventory.

- [ ] **Step 1: Obtain action-time authorization**

Ask exactly: `即将开通 OSS、在非杭州地域创建私有 Bucket，并创建只允许该 Bucket 读写的 RAM 访问密钥；这些操作可能产生云资源费用。请确认执行。`

Expected: do not activate OSS or create any resource without a direct affirmative answer.

- [ ] **Step 2: Create private storage**

After approval, activate OSS if required and create globally unique `devkh-backup-<account-suffix>` in `cn-shanghai` unless the operator selects another non-Hangzhou mainland region. ACL must be private, public-access blocking must remain enabled, and website hosting stays off. Verify anonymous list/read is unavailable.

- [ ] **Step 3: Create least-privilege RAM access and recovery password**

Create `devkh-backup-writer` with programmatic AccessKey only and a policy limited to the Bucket and `devkh/*` prefix:

```json
{
  "Version": "1",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["oss:ListObjects", "oss:GetObject", "oss:PutObject", "oss:DeleteObject"],
    "Resource": ["acs:oss:*:*:devkh-backup-ACCOUNT_SUFFIX", "acs:oss:*:*:devkh-backup-ACCOUNT_SUFFIX/devkh/*"]
  }]
}
```

Generate restic password with `openssl rand -base64 32` and store it in the operator's independent password manager. Write AccessKey and password only to the root-only files in Task 5. Record only region, bucket, endpoint hostname, RAM user, and date in the runbook.

- [ ] **Step 4: Commit non-secret inventory only if it changed**

```bash
git add docs/operations/encrypted-offsite-backups.md
git commit -m "docs: record backup storage inventory"
```

### Task 5: Install, Initialize, And Verify On Production ECS

**Files:**
- No source change expected; install assets on `root@118.31.105.66`.

- [ ] **Step 1: Verify server prerequisites and volume names**

```bash
ssh -i /Users/start/Desktop/root.pem root@118.31.105.66 '
  set -e; cd /opt/dev-knowledge-hub
  docker compose -f /opt/dev-knowledge-hub/docker-compose.yml ps
  docker volume ls --format "{{.Name}}" | grep -E "dev-knowledge-hub_(snapshot_data|repository_mirrors|upload_staging)$"
  systemctl --version | head -1
'
```

Expected: app and PostgreSQL run, three data volumes exist, and systemd is present. Use discovered volume names only in server config.

- [ ] **Step 2: Install verified restic, scripts, and units**

Verify the official restic release checksum/signature before installing it as `/usr/local/bin/restic`. Then:

```bash
install -d -m 0700 /usr/local/lib/devkh-backup /etc/devkh-backup /var/lib/devkh-backup
install -m 0700 scripts/backup/lib.sh scripts/backup/devkh-backup.sh scripts/backup/devkh-restore-drill.sh /usr/local/lib/devkh-backup/
install -m 0644 deployment/backup/*.service deployment/backup/*.timer /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/devkh-*.service /etc/systemd/system/devkh-*.timer
```

- [ ] **Step 3: Write server secret files without displaying contents**

Create `/etc/devkh-backup/backup.env` from the example and `/etc/devkh-backup/restic-password` from independently retained recovery material. Then verify only metadata:

```bash
chmod 600 /etc/devkh-backup/backup.env /etc/devkh-backup/restic-password
chown root:root /etc/devkh-backup/backup.env /etc/devkh-backup/restic-password
stat -c '%a %U:%G %n' /etc/devkh-backup/backup.env /etc/devkh-backup/restic-password
```

- [ ] **Step 4: Initialize and prove recovery**

```bash
set -a; . /etc/devkh-backup/backup.env; set +a
restic init
systemctl daemon-reload
systemctl enable --now devkh-backup.timer devkh-restic-check.timer devkh-restore-drill.timer
systemctl start devkh-backup.service
systemctl start devkh-restic-check.service
systemctl start devkh-restore-drill.service
cat /var/lib/devkh-backup/status.json
docker compose -f /opt/dev-knowledge-hub/docker-compose.yml ps
curl --fail --silent --show-error http://127.0.0.1:3000/api/health
```

Expected: initial backup, check, and isolated drill succeed; status reports successful `restore-drill`; app stays healthy.

- [ ] **Step 5: Run final checks**

```bash
npm run test:backup
npm run typecheck
npm run lint
npm run secrets:scan
git diff --check
git status --short
```

Expected: all verification exits `0`. Never stage secret files, generated status, archives, or pre-existing unrelated changes; commit only a live-verification correction to the runbook.
