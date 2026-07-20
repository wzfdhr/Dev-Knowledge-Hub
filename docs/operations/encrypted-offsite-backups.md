# Encrypted Offsite Backups

## Scope

This runbook backs up one application-consistent set: the PostgreSQL database and the
`snapshot_data`, `repository_mirrors`, `uploaded_sources`, and `artifact_data` Docker volumes. It encrypts
the set on the ECS host with restic before it is uploaded to a private Alibaba Cloud OSS
bucket. Tailscale protects application access; it is not a backup or source-at-rest
encryption mechanism.

## Secret Custody

Recovery requires two independent secrets:

1. The restic repository password, stored in an operator password manager and in
   `/etc/devkh-backup/restic-password` on the ECS host.
2. `DEVKH_MASTER_KEY`, retained separately from both OSS and the restic repository. It is
   required to decrypt application credentials restored from PostgreSQL.

Do not commit, paste, log, or attach either secret, `.env`, OSS AccessKey values, database
passwords, archive contents, or database dumps. The server files
`/etc/devkh-backup/backup.env` and `/etc/devkh-backup/restic-password` must be owned by
`root:root` with mode `0600`.

## Cloud Resource Boundary

Create a private OSS bucket in the selected Alibaba Cloud region. Keep public access blocking on
and do not enable website hosting or anonymous read/list access. Create a dedicated RAM user
named `devkh-backup-writer` with programmatic access only. Its policy is limited to this
bucket; backups are stored under the `devkh/` prefix. Do not use Alibaba Cloud root keys.

Record only the bucket name, region, endpoint hostname, RAM user name, and creation date in
this runbook. Do not record AccessKey values or repository passwords.

## Installation

Install a checksum-verified official restic release at `/usr/local/bin/restic`. Copy the
repository scripts to `/usr/local/lib/devkh-backup` mode `0700`, the systemd units to
`/etc/systemd/system`, and create these root-only directories:

```bash
install -d -m 0700 /usr/local/lib/devkh-backup /etc/devkh-backup /var/lib/devkh-backup
install -m 0700 scripts/backup/lib.sh scripts/backup/devkh-backup.sh scripts/backup/devkh-restore-drill.sh /usr/local/lib/devkh-backup/
install -m 0644 deployment/backup/*.service deployment/backup/*.timer /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/devkh-*.service /etc/systemd/system/devkh-*.timer
```

Create `/etc/devkh-backup/backup.env` from `deployment/backup/backup.env.example` and create
`/etc/devkh-backup/restic-password` with the independently retained restic password. Verify
file metadata without displaying contents:

`RESTIC_CACHE_DIR` must remain below `/var/lib/devkh-backup`; systemd permits that directory
while keeping home directories inaccessible to the backup services.

```bash
chmod 600 /etc/devkh-backup/backup.env /etc/devkh-backup/restic-password
chown root:root /etc/devkh-backup/backup.env /etc/devkh-backup/restic-password
stat -c '%a %U:%G %n' /etc/devkh-backup/backup.env /etc/devkh-backup/restic-password
```

Load the environment without printing it, initialize the repository once, and enable the
timers:

```bash
set -a; . /etc/devkh-backup/backup.env; set +a
restic init
systemctl daemon-reload
systemctl enable --now devkh-backup.timer devkh-restic-check.timer devkh-restore-drill.timer
systemctl list-timers 'devkh-*'
```

If a repository already exists, run `restic snapshots` instead of `restic init`.

## Verification

Run an initial backup, repository check, and isolated restore drill. The drill restores to a
temporary directory below `/var/lib/devkh-backup`, validates checksums and archive paths, restores
the dump into an ephemeral PostgreSQL container, verifies record counts and permission/release/artifact
integrity, and starts an ephemeral application container for `/api/health`. For source blobs it also
requires each `source_files.source_blob_id` to remain workspace-scoped, hash/size/generation-correct,
and `active` or `tombstoned`; a `trash` or `deleted` blob may not be referenced. It verifies each
referenced blob and snapshot view as a regular non-symlink file, checks SHA-256 and size, and requires
the view to share device and inode with its blob. Evidence schema version 3 records source blob
reference/content/hardlink counts, unique generation count, logical bytes, and physical bytes from
unique inode allocated blocks; physical bytes are never inferred from logical bytes. 成功时才会移除临时容器、网络和目录；
失败时保留恢复目录和临时资源供取证，并在 systemd journal 中记录保留路径，待值班人员确认后手动清理。清理过程中出现错误时，可能已有部分资源被删除；
日志中的恢复目录和剩余资源路径是后续检查的权威位置。它绝不停止生产应用、写入生产
Docker volume, or restores into the live database. It reads the current application image identifier
from Compose unless `RECOVERY_APP_IMAGE` explicitly identifies the recovery image.

```bash
systemctl start devkh-backup.service
systemctl start devkh-restic-check.service
systemctl start devkh-restore-drill.service
systemctl status --no-pager devkh-backup.service devkh-restic-check.service devkh-restore-drill.service
cat /var/lib/devkh-backup/status.json
journalctl -u devkh-backup.service -u devkh-restic-check.service -u devkh-restore-drill.service -n 100 --no-pager
```

The daily timer runs at 03:30 server-local time, the integrity check runs weekly, and the
restore drill runs monthly. The status JSON is intentionally secret-free; detailed failures
remain in the systemd journal.

## Full Restore

Restore only into an empty deployment running a compatible application version. Supply the
separately retained restic password and `DEVKH_MASTER_KEY`; do not reuse the production
environment file blindly.

1. Install Docker Compose, restic, and the matching application checkout on the recovery host.
2. Create empty `snapshot_data`, `repository_mirrors`, `uploaded_sources`, and `artifact_data` volumes.
3. Restore the selected restic snapshot into a staging directory and verify its manifest and
   checksums.
4. Start only PostgreSQL, restore `database.pgdump` with `pg_restore --clean --if-exists`,
   then unpack each volume archive into its corresponding empty Docker volume. Preserve hardlinks while
   unpacking `snapshots.tgz`; do not copy blobs or views separately.
5. Provide a securely reconstructed `.env` containing the retained `DEVKH_MASTER_KEY`, start
   the remaining services, and verify `/api/health` plus a representative source lookup.

Never restore onto the live deployment. If credentials or an OSS AccessKey may have been
exposed, revoke the RAM AccessKey in Alibaba Cloud before investigation, create a replacement
key, and rotate affected application credentials.
