# Source Blob Rollout

## Defaults

`DEVKH_SOURCE_STORAGE_MODE=legacy` remains the default. Source blob GC is disabled by default and is not enabled by this rollout. `shadow` and `active` require successful startup hardlink probing on `snapshot_data`; a failed probe keeps the deployment in `legacy` and requires investigation.

## Rollout Order

1. Deploy the expand migration and keep all workloads in `legacy`.
2. Run the backfill by workspace and snapshot in restartable batches. Each completed source file must reference an `active` generation with matching workspace, SHA-256, and byte size. Do not enable GC while any backfill is running.
3. Run an isolated restore drill. It must recover the single `snapshots.tgz` archive, validate every source blob reference and its snapshot hardlink view, and produce schema-version-3 recovery evidence.
4. Run the active preflight: successful hardlink probe, completed backfill for publishable snapshots, clean restore evidence, and no invalid blob references. Then enable `shadow` for the explicitly selected deployment and observe the existing release and restore checks.
5. Move to `active` only after the shadow observation window and explicit operational approval. FK17, including any GC enablement or contract migration, requires separate authorization.

## FK17 Contract Gate

`drizzle/0035_source_blobs_contract.sql` is a separately authorized release boundary. Its introduction relative to the approved base makes container release verification fail closed until an immutable GitHub Actions artifact provides a canonical manifest bound to the exact candidate commit. The manifest SHA-256 and every referenced preflight, observation, capacity, historic-release, approval, and strict schema-v3 recovery document are verified before an image build. Caller booleans and timestamps are not accepted as gate evidence. Record the artifact identity and evidence format in `docs/releases/source-blob-contract-evidence.md`.

The approved container path starts PostgreSQL and the parser first, then explicitly invokes the profiled `contract-migrate` service. That temporary service alone sets the PostgreSQL custom parameter `devkh.source_blob_contract_authorized=true`. The normal app starts only after migration success and never receives the authorization parameter. The migrator performs the authorization check, table lock, zero-null and identity/state revalidation, composite identity foreign key, and `source_blob_id NOT NULL` change in its existing single transaction. It does not change `DEVKH_SOURCE_STORAGE_MODE`, remove legacy data, enable GC, or delete historic release and rollback dependencies.

After SQL commit, verify the forward-compatible application again and switch new writes to `active` only as a separate approved operation. From that point, rollback may use only an application version that recognizes `source_blob_id`; an old-schema client is not a valid rollback target.

## Stop And Roll Back

Stop rollout immediately on a hash/size mismatch, cross-workspace reference, invalid generation status, missing view, inode mismatch, expired or failed restore evidence, insufficient capacity, unverified historic dependency, or missing authorization. Before `0035` commits, do not generate or retain a success evidence file for that run; keep the recovery fixture for investigation, leave GC disabled, and preserve dual-read/dual-write `shadow`. Repair or re-run backfill only after the failed preflight or recovery drill has a documented cause and a clean replacement drill. After `0035` commits, do not return to `legacy` or an old-schema client; hold `active` changes and roll forward with a compatible application while preserving all retained data and diagnostics.
