# Source Blob Contract Release Evidence

## Current Status

FK17 is implemented and tested locally only. The contract migration is **not authorized for merge, image publication, deployment, or production execution**. No production preflight, storage-mode change, or release action is recorded by this document.

## Immutable Release Identity

Record these values from the separately approved FK17 release candidate before any external action:

| Field | Required evidence |
| --- | --- |
| Commit | Exact FK17 commit SHA |
| Application image | Digest built only after this gate passes |
| Forward-compatible version | Version that reads `source_blob_id` and remains in `shadow` |
| Migration | `drizzle/0035_source_blobs_contract.sql` from the same commit |
| Approver | User identity and timestamp from the separate authorization |

## Required Gate Evidence

Every row must be backed by timestamped command output or an immutable artifact. A checkbox or environment value is not evidence by itself.

| Gate | Pass condition | Status |
| --- | --- | --- |
| Forward-compatible health | The candidate is healthy in `shadow` and all new source files receive valid blob references | Outstanding |
| Checkpoint backfill | `source_files.source_blob_id IS NULL` returns zero and every checkpoint is database-verifiable | Outstanding |
| Reference identity | Every reference matches blob workspace, SHA-256, byte size, positive generation, and active state | Outstanding |
| Active generation | At most one active generation exists for each workspace/hash | Outstanding |
| Snapshot view | Every referenced view and blob pass pinned-descriptor hash/size checks and share device/inode | Outstanding |
| Recovery | Strict schema-v3 JSON/NDJSON evidence passes without `--allow-legacy-v2` and is no older than 24 hours | Outstanding |
| Capacity | Available bytes meet the approved headroom for migration, rollback evidence, and retained historic data | Outstanding |
| Historic releases | All published release and rollback dependencies remain readable and are retained | Outstanding |
| Observation | Continuous dual-read production observation is at least seven full days | Outstanding |
| Authorization | User separately authorizes this exact commit and migration execution | Outstanding |

## Database Preflight

Run against a read-only production session first and retain complete output. All counts must be zero.

```sql
SELECT count(*) AS unbound_source_files
FROM source_files
WHERE source_blob_id IS NULL;

SELECT count(*) AS invalid_source_blob_references
FROM source_files file
LEFT JOIN source_blobs blob ON blob.id = file.source_blob_id
WHERE blob.id IS NULL
   OR blob.workspace_id <> file.workspace_id
   OR blob.content_hash <> file.content_hash
   OR blob.byte_size <> file.byte_size
   OR blob.generation < 1
   OR blob.status <> 'active'
   OR blob.fencing_token IS NOT NULL
   OR blob.tombstoned_at IS NOT NULL
   OR blob.trashed_at IS NOT NULL
   OR blob.deleted_at IS NOT NULL;

SELECT count(*) AS duplicate_active_identities
FROM (
  SELECT workspace_id, content_hash
  FROM source_blobs
  WHERE status = 'active'
  GROUP BY workspace_id, content_hash
  HAVING count(*) > 1
) duplicates;
```

The filesystem pass must call `SourceBlobStore.verifySnapshotReference` for every reference selected by the same database snapshot. Any inaccessible path, noncanonical snapshot path, writable/tampered file, hash or size mismatch, inactive generation, or device/inode mismatch blocks the release and preserves diagnostics.

## Release Interlock

The release entrypoint refuses to build a container containing `0035` unless all FK17 gate variables are exact, storage remains `shadow`, the observation timestamp is at least seven days old, and the strict recovery evidence path is absolute and fresh. Set those values only from reviewed evidence:

```text
DEVKH_SOURCE_BLOB_CONTRACT_AUTHORIZED=true
DEVKH_SOURCE_BLOB_FORWARD_COMPATIBLE_HEALTHY=true
DEVKH_SOURCE_BLOB_BACKFILL_COMPLETE=true
DEVKH_SOURCE_BLOB_ACTIVE_PREFLIGHT=passed
DEVKH_SOURCE_BLOB_DISK_CAPACITY_VALIDATED=true
DEVKH_SOURCE_BLOB_HISTORIC_RELEASES_VALIDATED=true
DEVKH_SOURCE_STORAGE_MODE=shadow
DEVKH_SOURCE_BLOB_DUAL_READ_STARTED_AT=<UTC ISO timestamp>
DEVKH_SOURCE_BLOB_RECOVERY_EVIDENCE_PATH=<absolute schema-v3 JSON path>
```

Only after the interlock, independent review, and explicit user authorization may the migration session receive `-c devkh.source_blob_contract_authorized=true`. The migrator wraps the authorization check, locked revalidation, composite foreign key, and `NOT NULL` change in one transaction. Any error rolls back the SQL and leaves the forward-compatible application in `shadow`.

## Post-Commit Boundary

After the SQL transaction commits, verify application health and reference creation before separately switching new writes to `active`. Do not delete legacy snapshot paths, historic releases, backup data, or rollback evidence in FK17. Rollback is limited to a forward-compatible application that recognizes `source_blob_id`; an old-schema client is prohibited.

## Failure Record

For any failed gate, retain: candidate commit, UTC start/finish times, failed check, sanitized command output, recovery evidence status, storage mode, and operator decision. Do not set the PostgreSQL authorization parameter, build/publish the application image, execute `0035`, or activate storage after a failure.
