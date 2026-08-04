# Pipeline Release Rollback

This is the rollback contingency for F05 and later, after a pipeline release has been formally activated. `DEVKH_KNOWLEDGE_KERNEL_MODE=active` enables the staged pipeline worker for future builds, but it does not publish a release automatically: the existing draft-and-publish review boundary remains mandatory. The operation does not delete releases, builds, database rows, snapshots, or artifacts.

1. Set `DEVKH_KNOWLEDGE_KERNEL_MODE=shadow` in the service environment and restart the application. This changes only the mode for future builds; published releases retain their own immutable provenance.
2. Identify a previously published legacy release from the affected project. Do not use an unpublished release or a release with `kernelMode: "pipeline"`.
3. As a workspace administrator, call `POST /api/releases/:id/rollback` with the legacy release ID. The operation atomically updates the project repository's `current` channel and records `release.rolled_back` with the previous release ID.
4. Read `GET /api/releases/current` for the same project and verify the returned release ID is the selected legacy release. Verify normal knowledge search and source citations against that release.
5. Preserve the affected pipeline artifacts and comparison output for investigation. Do not edit release provenance or delete the new release as part of rollback.

The endpoint is idempotent for the already current target: it leaves the channel unchanged and does not add a duplicate audit record. It returns `409 ROLLBACK_NOT_ALLOWED` when the target is not a published legacy release. Unexpected persistence failures return `500 ROLLBACK_FAILED` without exposing internal details. Only a workspace administrator can invoke it; project administrators and other members receive `403 FORBIDDEN`.
