# FK17 source-blob seven-day observation runbook

## Purpose and boundary

This runbook prepares the evidence collection for FK17's source-blob contract.
It does **not** start an observation, deploy an image, run migration `0035`,
change `DEVKH_SOURCE_STORAGE_MODE`, enable GC, or modify production data.

Use the exact `main` commit selected by the release owner. A later commit,
including a documentation-only commit, is a different candidate and requires a
fresh record. Keep source storage in `shadow` throughout the observation.

## Before requesting observation authorization

Collect the following from a read-only production database session and retain
the sanitized result outside Git. Each count must be zero.

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

The same database snapshot must also drive a filesystem verification of every
referenced source blob and snapshot view using
`SourceBlobStore.verifySnapshotReference`. Retain failures verbatim enough for
diagnosis, but redact paths, identifiers, and content that should not leave the
production environment.

Before the window can begin, retain current strict schema-v3 recovery evidence
(less than 24 hours old), capacity headroom, and historic-release dependency
evidence. Confirm the selected application is forward-compatible, healthy, and
still using `DEVKH_SOURCE_STORAGE_MODE=shadow`.

## Separate authorization to start

The release owner must obtain a separate user authorization that identifies:

- the exact 40-character candidate commit;
- the selected deployment and observation scope;
- the storage mode `shadow`;
- the UTC start time; and
- the evidence location and operator.

Without this authorization, do not start a timer or create a success record.
The authorization to prepare or merge code is not authorization to inspect,
deploy, migrate, or observe production.

## Seven-day evidence contract

After the separately authorized start, retain continuous monitor output and
produce a canonical LF-terminated JSON file with this shape only when the
window has completed:

```json
{"schemaVersion":1,"operation":"source-blob-dual-read-observation","result":"passed","candidateCommit":"<40-character SHA>","startedAt":"<UTC ISO>","finishedAt":"<UTC ISO>","incidentCount":0}
```

`finishedAt - startedAt` must be at least seven full 24-hour days. All times are
UTC. `candidateCommit` must be read from `git rev-parse HEAD` for the fixed,
reviewed candidate immediately before the authorized observation begins. Put
this JSON, its monitor history, and all gate evidence in one immutable GitHub
Actions artifact; never commit it to the candidate branch.

An observation incident includes failed dual-read comparison, failed health or
recovery check, missing/invalid reference, unexpected storage-mode change, or
a gap in required monitoring. Set `result` to `failed` and retain diagnostics;
do not overwrite failed evidence with a retry.

## Stop conditions

Stop the observation and preserve the evidence if any of the following occurs:

- a non-zero preflight count or a hash, byte-size, workspace, generation, or
  active-state mismatch;
- a missing or inode-mismatched snapshot view or blob;
- expired/failed recovery evidence, insufficient capacity, or an unresolved
  historic-release dependency;
- any observation incident or monitoring gap;
- candidate SHA drift; or
- absent, revoked, or incomplete user authorization.

Do not execute `0035`, enable `active`, enable GC, delete legacy snapshots, or
publish a success artifact after a stop condition. Repair the cause, preserve
the failed record, and seek a new explicit authorization before a new window.

## Completion handoff

Seven clean days are necessary but not sufficient. Before the contract
migration may be considered, bind preflight, observation, capacity,
historic-release, recovery, and exact-commit approval evidence into the
manifest described in
[`source-blob-contract-evidence.md`](../releases/source-blob-contract-evidence.md).
Image publication, deployment, migration execution, and a later `active`
switch each require their own authorization.
