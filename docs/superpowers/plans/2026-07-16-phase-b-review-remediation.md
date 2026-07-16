# Phase B Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` task-by-task. Each implementation task uses a failing test before its production change.

**Goal:** Resolve the Phase B development, test, and product review findings without changing the pre-F05 legacy release contract.

**Architecture:** Stage-run output references, rather than an artifact's first-producer build ID, establish reuse ownership. Legacy build state remains the formal product state, while shadow state is exposed independently to authorized administrators. PostgreSQL integration tests exercise the same pipeline worker and persistence code used in CI containers.

**Tech Stack:** TypeScript, Fastify, React, Vitest, Playwright, PostgreSQL, pg-boss.

## Global Constraints

- `legacy` remains the only formal release/read path until F05; `active` is rejected.
- No production deployment, no change to `docker-compose.override.yml`, and no new UI library.
- Cache reuse remains constrained to the same workspace, project, snapshot, stage, kind, and input digest.
- Optional LLM execution remains explicit per manual build; final caller role follows the user-selected policy.

---

### Task 1: Cache Ownership and Search Isolation

**Files:** `src/server/knowledge/pipeline/*-stage.ts`, `src/server/persistence/{store,memory-store,postgres-store}.ts`, pipeline unit/integration tests.

- [ ] Add a failing second-build reuse test: an artifact created by build A is referenced through build B's stage run and all downstream stages complete.
- [ ] Change upstream-manifest validation to require workspace/project/snapshot/stage/kind, not producer `buildId`; retain `output_manifest_ids` as the consuming build's authority.
- [ ] Permit pipeline search rows to cite a reused artifact while preserving the indexing build's workspace/project/snapshot scope.
- [ ] Verify same-project reuse, cross-project rejection, source-artifact loss regeneration, and audit recording; commit `fix(pipeline): preserve stage-run ownership for cached artifacts`.

### Task 2: Legacy/Shadow State and Cancellation

**Files:** `src/server/app.ts`, `src/server/knowledge/pipeline/{contracts,worker}.ts`, `src/server/persistence/{store,memory-store,postgres-store}.ts`, migration, API tests.

- [ ] Write failing API tests showing a failed shadow stage leaves `legacyStatus` at the persisted legacy build state and exposes a separate pipeline summary.
- [ ] Add durable pipeline cancellation independent of the legacy build's terminal state; queued/running stage runs become cancelled and cannot create a downstream run.
- [ ] Keep `/api/builds/:id/stages` reader-authorized and return `legacyStatus`, `pipelineStatus`, and stage runs separately.
- [ ] Verify duplicate/tampered jobs, cancellation, stale recovery, and delivery-failure reconciliation; commit `fix(pipeline): isolate shadow state from legacy builds`.

### Task 3: Release Provenance Immutability

**Files:** new Drizzle migration, release provenance tests, PostgreSQL integration tests.

- [ ] Write a failing real-PostgreSQL test that attempts to change an existing release's `kernel_mode` or `package_artifact_id`.
- [ ] Add a trigger guard that permits ordinary release updates but rejects provenance changes after insert.
- [ ] Verify legacy release reads/channel pointers are unchanged after a shadow pipeline completes; commit `fix(releases): make pipeline provenance immutable`.

### Task 4: Shadow Administration and Preview

**Files:** `src/client/api/{client,types}.ts`, `src/client/pages/project-versions-page.tsx`, `src/client/pages/knowledge-page.tsx`, component tests and Playwright flow.

- [ ] Write failing client tests for a separate shadow status panel and for a failed pre-lint stage being visible in quality analysis.
- [ ] Request `/api/builds/:id/stages` for selected builds, render a concise administrator-only pipeline status with stage failure/error and a no-release-impact message.
- [ ] Surface `kernelMode` in release records and preserve legacy page/release browsing behavior.
- [ ] Verify desktop/mobile layout and a failed shadow stage; commit `feat(pipeline): expose safe shadow status preview`.

### Task 5: Optional LLM Consent

**Files:** `src/server/knowledge/build-service.ts`, `src/server/app.ts`, persistence stores, `src/client/api/*`, build UI and tests.

- [ ] Write failing tests proving non-opt-in legacy and shadow builds never construct an enhancer, opt-in manual builds do, and enhancer failure falls back deterministically.
- [ ] Apply the user-selected authorization policy to `allowLlm`, reject implicit/background use, and include the value in every PostgreSQL build projection/deduplication path.
- [ ] Add an explicit manual-build control and audit-visible build option; commit `feat(builds): require explicit LLM consent`.

### Task 6: PostgreSQL Container Evidence

**Files:** PostgreSQL integration tests, `scripts/release-verify.mjs`, CI workflow only if needed for the existing integration profile.

- [ ] Add a representative multi-file snapshot integration suite covering ten stages, concurrent same-snapshot builds, cross-project rejection, stale/retry/cancel, queue compensation, cache reuse, and unchanged legacy release reads.
- [ ] Add executable backfill coverage for batches of 500, missing snapshots, idempotence, and the private report file.
- [ ] Invoke the integration profile from `release:verify -- --scope verify` and preserve failure artifacts/exit status.
- [ ] Commit `test(pipeline): verify shadow pipeline with PostgreSQL`.

### Task 7: Phase B Reverification

**Files:** PR #4 review record.

- [ ] Run unit, typecheck, lint, build, acceptance, E2E, PostgreSQL/Docker integration, `verify`, and `container-smoke`.
- [ ] Repeat independent development-manager review, test-manager test review, and product-manager browser acceptance.
- [ ] Post four segmented findings to Draft PR #4, request user confirmation, then and only then perform the merge commit.
