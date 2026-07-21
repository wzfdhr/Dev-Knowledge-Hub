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

The gate manifest cannot be committed inside the candidate because embedding the candidate SHA would change that SHA. Generate it only after the candidate commit is fixed, place it and every referenced JSON/NDJSON file in one immutable GitHub Actions artifact, and record the artifact workflow run ID, artifact name, manifest basename, and manifest SHA-256 in the separately authorized `phase-merge` dispatch.

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

## Machine-Readable Gate

The canonical LF-terminated gate manifest has this exact shape. Each reference is a basename in the same immutable artifact and its digest is the SHA-256 of canonical LF-terminated JSON bytes.

```json
{"schemaVersion":1,"kind":"devkh-source-blob-contract-gate","candidateCommit":"<40 lowercase hex>","createdAt":"<UTC ISO>","references":{"preflight":{"file":"preflight.json","sha256":"<64 lowercase hex>"},"observation":{"file":"observation.json","sha256":"<64 lowercase hex>"},"capacity":{"file":"capacity.json","sha256":"<64 lowercase hex>"},"historicReleases":{"file":"historic-releases.json","sha256":"<64 lowercase hex>"},"approval":{"file":"approval.json","sha256":"<64 lowercase hex>"},"recovery":{"file":"recovery.json","sha256":"<64 lowercase hex>"}}}
```

The verifier opens the manifest and references with no-follow semantics, requires canonical JSON and exact fields, and checks every digest before interpreting evidence. The five FK17-specific evidence files must bind to the same candidate commit and prove:

- `preflight`: zero unbound/invalid/duplicate-active records and at least one pinned hash/inode snapshot reference.
- `observation`: a continuous interval of at least seven full days with zero incidents.
- `capacity`: decimal-string available and required byte counts with available capacity at least the required headroom.
- `historicReleases`: at least one retained release and zero unresolved dependencies.
- `approval`: `result=approved`, the exact candidate, the dispatching repository owner, timestamp, and non-empty authorization ID.

`recovery` must be the existing strict schema-v3 evidence with its referenced source-blob NDJSON sidecar in the same bundle. It is revalidated without `--allow-legacy-v2` and must be no older than 24 hours.

## Release Interlock

The `phase-merge` dispatch provides the approved head/base, immutable artifact run ID and name, manifest basename, and reviewed manifest SHA-256. The owner-approved `container-smoke` job downloads that exact artifact. `scripts/release-verify.mjs` independently compares the checked-out HEAD, manifest candidate, approver, manifest digest, all reference digests, and semantic gate facts before any image build.

Container verification starts only PostgreSQL and the parser, runs the profiled `contract-migrate` service, and starts the normal application only after that service exits successfully. Only `contract-migrate` receives `PGOPTIONS=-c devkh.source_blob_contract_authorized=true`; the app receives no authorization setting. The migrator wraps the authorization check, locked revalidation, composite foreign key, and `NOT NULL` change in one transaction. Any error rolls back SQL and prevents app startup. Once an approved base already contains `0035`, the external gate manifest is no longer required for later candidates, but fresh container databases still use the explicit migration-only service before app startup.

## Post-Commit Boundary

After the SQL transaction commits, verify application health and reference creation before separately switching new writes to `active`. Do not delete legacy snapshot paths, historic releases, backup data, or rollback evidence in FK17. Rollback is limited to a forward-compatible application that recognizes `source_blob_id`; an old-schema client is prohibited.

## Failure Record

For any failed gate, retain: candidate commit, UTC start/finish times, failed check, sanitized command output, recovery evidence status, storage mode, and operator decision. Do not set the PostgreSQL authorization parameter, build/publish the application image, execute `0035`, or activate storage after a failure.
