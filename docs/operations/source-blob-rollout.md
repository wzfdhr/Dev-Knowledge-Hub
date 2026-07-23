# Source Blob Rollout

## Defaults

`DEVKH_SOURCE_STORAGE_MODE=legacy` remains the default. Source blob GC is disabled by default and is not enabled by this rollout. `shadow` and `active` require successful startup hardlink probing on `snapshot_data`; a failed probe keeps the deployment in `legacy` and requires investigation.

## Rollout Order

1. Deploy the expand migration and keep all workloads in `legacy`.
2. Run the backfill by workspace and snapshot in restartable batches. Each completed source file must reference an `active` generation with matching workspace, SHA-256, and byte size. Do not enable GC while any backfill is running.
3. Run an isolated restore drill. It must recover the single `snapshots.tgz` archive, validate every source blob reference and its snapshot hardlink view, and produce schema-version-3 recovery evidence.
4. Run the active preflight: successful hardlink probe, completed backfill for publishable snapshots, clean restore evidence, and no invalid blob references. Then enable `shadow` for the explicitly selected deployment and observe the existing release and restore checks.
5. Move to `active` only after the shadow observation window and explicit operational approval. FK17, including any GC enablement or contract migration, requires separate authorization.

## Stop And Roll Back

Stop rollout immediately on a hash/size mismatch, cross-workspace reference, invalid generation status, missing view, inode mismatch, or failed restore evidence. Do not generate or retain a success evidence file for that run. Keep the recovery fixture for investigation, leave GC disabled, and return the affected deployment to `legacy`; this stops new blob/view writes while preserving existing data and the four-volume backup consistency set. Repair or re-run backfill only after the failed preflight or recovery drill has a documented cause and a clean replacement drill.
