# Encrypted Offsite Backup Design

**Date:** 2026-07-13
**Status:** Approved design, pending implementation plan and cloud-resource authorization

## Goal

Give the private Dev Knowledge Hub deployment a recoverable, encrypted off-host backup
system suitable for a 2-10 person team. The system must preserve one application-consistent
set of data, survive loss of the ECS host, and provide regular evidence that the backup can
be read and restored.

## Scope

- Back up the production PostgreSQL database plus the `snapshot_data`,
  `repository_mirrors`, and `upload_staging` Docker volumes as one set.
- Encrypt and authenticate data before it leaves the ECS host.
- Store backups in a private Alibaba Cloud OSS bucket in a region other than the current
  ECS region.
- Retain daily recovery points for 30 days and monthly recovery points for 12 months.
- Automate backup, repository integrity checks, and a non-destructive restore drill.
- Provide an operator runbook and a local status record that does not expose secrets.

## Non-goals

- Changing the app's source-at-rest encryption model.
- Backing up `.env`, database passwords, API keys, MCP tokens, session secrets, or
  `DEVKH_MASTER_KEY` into the backup repository.
- Replacing the existing Tailscale-only access design.
- Creating an application dashboard or alerting integration in this iteration.
- Using ECS disk snapshots as the primary recovery mechanism.

## Chosen Architecture

### Storage and encryption

The server will use `restic` with Alibaba OSS through its S3-compatible endpoint. Restic
encrypts and authenticates repository data on the server before upload; OSS receives only
encrypted repository objects. The OSS bucket will be private, in a different region from
the ECS host, with no public website or anonymous-read configuration.

The implementation will create a dedicated RAM identity whose permissions are restricted to
this one backup bucket and its objects. Its access key and the S3 endpoint configuration
will live in a root-owned, mode `0600` environment file outside the application repository.
They must never be logged, committed, placed in a systemd unit, or copied into chat.

Before implementation creates a paid cloud resource, the operator must explicitly confirm
the OSS service activation, selected region, bucket creation, and RAM access key creation.

### Recovery keys

Two independent secrets are required for a complete recovery:

1. The restic repository password decrypts the offsite backup repository. It will be read
   by the scheduled job from a root-only file and must also be stored by the operator in an
   independent password manager or offline secure record. Loss of this password makes the
   encrypted repository unrecoverable.
2. `DEVKH_MASTER_KEY` decrypts application credentials stored in PostgreSQL. It remains
   outside OSS and must be retained independently in the operator's secure secret store.

The backup service must fail closed when either required local backup configuration value is
missing. It must not fall back to an unencrypted archive, a default password, or another
storage destination.

## Backup Data Flow

1. A root-only temporary staging directory is created on the ECS host.
2. The `app` Compose service is stopped while PostgreSQL remains running. A shell trap must
   restart the app service whenever the backup command exits, including on error or signal.
3. PostgreSQL is exported using `pg_dump` custom format. The three named application
   volumes are archived into separate files. A manifest records the backup-set format,
   timestamp, the deployed Git revision, filenames, sizes, and SHA-256 checksums.
4. The app service is restarted before remote upload begins, minimizing the application
   maintenance window.
5. Restic backs up the staged set and tags the snapshot with its purpose (`daily` and,
   when scheduled, `monthly`). Only after a successful restic snapshot is the retention
   policy applied: keep 30 daily and 12 monthly snapshots, then prune unreferenced data.
6. The staging directory is removed on successful completion and cleaned on the next run
   after failures. It is never treated as a durable backup location.

The backup job does not include `.env`. Deployment configuration may be captured only if it
is verified not to contain secrets; the recovery runbook will reconstruct secret values from
the two separately retained secret records.

## Scheduling and Health Evidence

- A systemd service performs the backup once per day at a fixed server-local time, with a
  persistent timer so a missed run is performed after a reboot.
- A repository check runs weekly.
- A restore drill runs monthly against the newest completed snapshot in a separate
  root-only temporary directory. It restores data without overwriting Docker volumes or the
  live database, validates the manifest checksums, verifies each volume archive can be
  listed, and runs `pg_restore --list` against the database dump.
- The service writes a non-secret JSON status record containing start/end times, result,
  snapshot identifier, duration, verified snapshot identifier, and a sanitized error class.
  Full operational detail remains in the systemd journal.

Any failure leaves the previous restic snapshots untouched, returns a non-zero service exit
code, and records failure status. Retention and pruning never run after a failed upload.

## Restore Procedure

The runbook will require a separate, empty deployment using the compatible application
version. The operator supplies the separately retained `DEVKH_MASTER_KEY` and restic
repository password, restores a chosen snapshot into a staging directory, verifies the
manifest, starts PostgreSQL, restores the custom-format dump, restores all three volumes,
then starts the remaining Compose services. Application health and a representative source
lookup are checked before declaring recovery complete.

The first implementation acceptance test includes a drill of this procedure into an
isolated target. It must not alter the live database, Docker volumes, `.env`, Tailscale
configuration, or public network exposure.

## Security Boundaries

- Tailscale protects traffic and access to the application. It is not the offsite backup
  encryption mechanism.
- Existing provider and Git credentials are encrypted at rest in the database with
  `DEVKH_MASTER_KEY`; the new backup adds a separate encrypted transport/storage layer.
- Bucket access is limited to a dedicated least-privilege RAM identity; no root cloud keys
  are used by scheduled jobs.
- Backup logs, manifests, status records, tests, and documentation must never emit secret
  values, archive content, database rows, or object credentials.

## Acceptance Criteria

1. An automated daily backup produces a restic snapshot containing a matching database dump
   and all three application data-volume archives.
2. OSS contains only data written through the dedicated private bucket and encrypted restic
   repository format; no backup data can be anonymously read.
3. The timer and service report a successful run, and a weekly `restic check` completes.
4. The retention policy leaves no more than 30 daily and 12 monthly retained recovery points
   once sufficient history exists.
5. A monthly non-destructive drill restores a snapshot, verifies checksums and archive
   readability, and validates the PostgreSQL dump with `pg_restore --list`.
6. A documented full restore can recover an isolated deployment without changing the live
   one.
7. No secrets, `.env` contents, or plaintext backup artifacts are committed to this
   repository, uploaded as an unencrypted OSS object, or written to service logs.

## Verification Strategy

- Unit-test the backup metadata and status serialization with secret-free fixtures.
- Test shell orchestration with mocked `docker`, `restic`, and PostgreSQL command wrappers
  to prove app restart-on-failure and no-prune-after-failure behavior.
- Validate systemd unit and timer syntax before installation.
- On the server, run an initial backup followed by `restic check`, then run the isolated
  restore drill and inspect the resulting status record and journal.
- Record only timestamps, snapshot IDs, checksums, and pass/fail results as evidence.

## Operational Decisions Still Requiring Action-Time Consent

- Activate Alibaba Cloud OSS, if it remains inactive.
- Select the non-Hangzhou OSS region and create the private bucket.
- Create the dedicated RAM identity and access key.
- Install the verified restic release and systemd units on the production ECS host.
- Generate and store the restic recovery password in both the server's root-only file and
  the operator's independent secure record.
