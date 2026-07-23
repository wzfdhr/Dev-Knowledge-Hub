# Frontend Experience Decision Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Git-grounded, ACL-safe frontend engineering experience layer that gives Codex current-project constraints, applicable historical evidence, explicit exclusions, impact, and verification guidance without inventing team knowledge.

**Architecture:** Git or verified upload snapshots remain the source of project facts. The existing ten-stage pipeline produces a versioned frontend project profile and candidate implementation evidence; PostgreSQL stores only opaque groups, project/release evidence, reviewed decisions, outcomes, and append-only review events. A user-bound workspace MCP server computes an ACL-filtered solution context; the project MCP remains project-scoped.

**Tech Stack:** TypeScript, Fastify, PostgreSQL, Drizzle, pg-boss, Zod, React, TanStack Query, Vitest, Playwright, MCP TypeScript SDK.

## Global Constraints

- Start only after FK17 and FK18 have passed their own gates. FK17 retains the sole right to add `drizzle/0035_source_blobs_contract.sql`.
- All EX work is local or isolated staging work. No production access, `active` switch, CI webhook credential, new MCP scope issuance, or database contract deployment occurs without separate user authorization.
- Git is the authority for Git repositories. Upload snapshots are project facts, not automatically reusable team evidence.
- Facts, declared decisions, and verified outcomes are different evidence classes. LLM output may summarize but may not create any of them.
- Every workspace query applies current ACL before generating titles, Trust, counts, ranking, rejection reasons, cache entries, or recommendations.
- The existing ten pipeline stages remain unchanged. New frontend artifacts are emitted inside existing `synthesize`, `index`, `validate`, and `package` stages.
- Keep project MCP tokens project-scoped. Workspace solution planning uses a separate, user-bound workspace token with a 30-day maximum lifetime.
- Preserve all existing `knowledge-v1` and `frontend-v2` release contracts. Use forward-only migrations and update Drizzle schema, schema tests, PostgreSQL integration tests, backup/restore assertions, and delivery verification for every migration.
- A normal state such as `no_release`, `stale`, `unsupported`, or no matching experience is a typed response state, not a transport error.

---

## Planned File Structure

| Path | Responsibility |
|---|---|
| `src/shared/frontend-experience.ts` | Zod contracts for source provenance, project profile, evidence, lifecycle, applicability, outcome, and solution context. |
| `src/server/knowledge/frontend/project-profile.ts` | Deterministically derive `frontend-project-profile@1` from Frontend IR, graph, manifest, and existing analyzer results. |
| `src/server/knowledge/frontend/patterns.ts` | Extract only observable implementation candidates and convert published artifacts into evidence rows. |
| `src/server/knowledge/frontend/experience-lifecycle.ts` | Validate lifecycle transitions and recommendation eligibility. |
| `src/server/knowledge/frontend/experience-query.ts` | Perform ACL-safe hard filtering, projection, ranking, and rejection explanation. |
| `src/server/knowledge/frontend/experience-governance.ts` | Review decisions, outcome intake, revocation handling, and experience lint cases. |
| `src/server/mcp/workspace-auth.ts` | Authenticate the user-bound workspace MCP token and recheck member/session state. |
| `src/server/mcp/workspace-tools.ts` | Register `dkh_find_prior_implementations` and `dkh_plan_frontend_solution`. |
| `src/client/pages/workspace-experiences-page.tsx` | Browse and review workspace experiences. |
| `src/client/components/experience-review-panel.tsx` | Review, recommend, standardize, deprecate, supersede, and inspect evidence. |
| `src/client/components/experience-solution-context.tsx` | Render current facts, constraints, experiences, exclusions, unknowns, impact, and verification separately. |
| `evaluation/frontend/*experience*.jsonl` | Train and held-out applicability, abstention, revocation, source-kind, and leakage evaluation data. |

## Task 1: EX01 Freeze the Experience Addendum and Product States

**Files:**

- Create: `docs/operations/frontend-experience-kernel.md`
- Modify: `docs/superpowers/specs/2026-07-21-frontend-experience-decision-kernel-design.md`
- Modify: `docs/superpowers/plans/2026-07-18-frontend-knowledge-platform.md`
- Modify: `docs/product/frontend-capability-matrix.md`

**Interfaces:**

- Consumes: the approved decision-kernel design and the original FK17-FK37 plan.
- Produces: the canonical EX01-EX12 insertion point, five V1 experience categories, four source eligibility modes, and a UI state matrix used by later API/UI tasks.

- [ ] **Step 1: Amend the canonical documents**

Add the following exact delivery contract to the original plan immediately before FK19:

```md
## Experience Kernel Addendum (EX01-EX12)

EX01-EX12 execute after FK17 and FK18, before FK19. They provide source provenance,
project profiles, experience evidence, applicability, governance, workspace MCP planning,
product review flows, evaluation, and staging gates. FK19-FK22 consume these contracts.
```

Add a state table to `docs/operations/frontend-experience-kernel.md` covering `no_current_project`, `no_release`, `stale`, `unsupported`, `no_applicable_experience`, `evidence_revoked`, and `ready`. Each row must state whether current facts, historical references, recommendations, and actions are available.

- [ ] **Step 2: Record the product-state acceptance contract**

In `docs/operations/frontend-experience-kernel.md`, make the `no_release` row require a dedicated UI message, no displayed recommendation, current-project actions that remain allowed, and no generic empty-state fallback. Task 9 owns the UI/API test once `ExperienceSolutionContext` exists; EX01 must not introduce an untyped temporary endpoint or an intentionally failing test.

- [ ] **Step 3: Verify document consistency**

Run: `rg -n 'EX0[1-9]|EX1[0-2]|0035|0036|0037|0038' docs/superpowers/specs docs/superpowers/plans docs/operations`

Expected: FK17 remains the only task naming `0035_source_blobs_contract.sql`; EX work is inserted before FK19; no document promises production activation.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07-21-frontend-experience-decision-kernel-design.md docs/superpowers/plans/2026-07-18-frontend-knowledge-platform.md docs/product/frontend-capability-matrix.md docs/operations/frontend-experience-kernel.md
git commit -m "docs: define frontend experience kernel delivery"
```

## Task 2: EX02 Separate Git Commit Identity from Upload Content Versions

**Files:**

- Create: `drizzle/0036_frontend_experience_source_provenance.sql`
- Create: `src/server/source-provenance.ts`
- Create: `src/server/source-provenance.test.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/schema.test.ts`
- Modify: `src/db/migrate.test.ts`
- Modify: `src/server/persistence/store.ts`
- Modify: `src/server/persistence/memory-store.ts`
- Modify: `src/server/persistence/postgres-store.ts`
- Modify: `src/server/persistence/postgres-knowledge.integration.test.ts`
- Modify: `src/server/git/snapshot.ts`
- Modify: `src/server/git/snapshot.test.ts`
- Modify: `src/server/uploads/folder-import.ts`
- Modify: `src/server/uploads/folder-import.test.ts`
- Modify: `src/server/app.ts`
- Modify: `src/client/api/types.ts`
- Modify: `src/client/components/import-report.tsx`

**Interfaces:**

- Consumes: `SourceSnapshotRecord`, repository `kind`, and the finished FK17 source blob contract.
- Produces: `SourceProvenance`, `sourceProvenanceForSnapshot(snapshot, repository)`, and persisted `source_kind`, `git_commit_sha`, `content_version`, `attestation`, `linked_git_commit_sha`, and `remote_identity_digest` fields.

- [ ] **Step 1: Write the failing provenance tests**

```ts
test("keeps an upload content version out of gitCommitSha", () => {
  const provenance = sourceProvenanceForSnapshot(uploadSnapshot, uploadRepository);
  expect(provenance).toEqual({
    schemaVersion: 1,
    kind: "upload",
    gitCommitSha: null,
    contentVersion: uploadSnapshot.contentVersion,
    ref: "upload",
    attestation: "unverified"
  });
});

test("requires a matching content version before linking an upload to Git", () => {
  expect(() => linkUploadSnapshotToGit({ uploadSnapshot, gitSnapshotWithDifferentContent }))
    .toThrow("Upload content version does not match the Git snapshot");
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm test -- src/server/source-provenance.test.ts src/server/uploads/folder-import.test.ts src/server/git/snapshot.test.ts`

Expected: FAIL because `SourceSnapshotRecord` only exposes overloaded `commitSha`.

- [ ] **Step 3: Add the forward migration and typed helper**

The migration must add nullable provenance columns, backfill Git rows from `commit_sha`, backfill upload rows into `content_version`, and reject incompatible source kinds with CHECK constraints. It must not drop `commit_sha` in this release.

```ts
export function sourceProvenanceForSnapshot(
  snapshot: Pick<SourceSnapshotRecord, "commitSha" | "ref" | "sourceKind" | "gitCommitSha" | "contentVersion" | "attestation" | "linkedGitCommitSha" | "remoteIdentityDigest">,
  repository: Pick<RepositoryRecord, "kind">
): SourceProvenance {
  if (repository.kind === "git") {
    if (!snapshot.gitCommitSha || !snapshot.contentVersion) throw new Error("Git snapshot provenance is incomplete");
    return { schemaVersion: 1, kind: "git", gitCommitSha: snapshot.gitCommitSha, contentVersion: snapshot.contentVersion, ref: snapshot.ref, remoteIdentityDigest: snapshot.remoteIdentityDigest! };
  }
  if (!snapshot.contentVersion) throw new Error("Upload snapshot content version is missing");
  return { schemaVersion: 1, kind: "upload", gitCommitSha: null, contentVersion: snapshot.contentVersion, ref: "upload", attestation: snapshot.attestation ?? "unverified", ...(snapshot.linkedGitCommitSha ? { linkedGitCommitSha: snapshot.linkedGitCommitSha } : {}), ...(snapshot.remoteIdentityDigest ? { linkedRemoteIdentityDigest: snapshot.remoteIdentityDigest } : {}) };
}
```

`git/snapshot.ts` must calculate and persist both Git SHA and normalized content version. Folder import must persist `kind="upload"`, `contentVersion`, and `attestation="unverified"`. API DTOs must label uploads as “内容版本”, not “Git Commit”.

- [ ] **Step 4: Run schema and PostgreSQL integration verification**

Run: `npm test -- src/db/schema.test.ts src/db/migrate.test.ts src/server/source-provenance.test.ts src/server/persistence/postgres-knowledge.integration.test.ts`

Expected: PASS; migration supports legacy Git and upload snapshots, rejects a linked upload whose content digest differs, and leaves existing citations readable.

- [ ] **Step 5: Commit**

```bash
git add drizzle/0036_frontend_experience_source_provenance.sql src/db src/server/source-provenance.ts src/server/source-provenance.test.ts src/server/persistence src/server/git src/server/uploads src/server/app.ts src/client/api/types.ts src/client/components/import-report.tsx
git commit -m "feat: distinguish Git and upload source provenance"
```

## Task 3: EX03 Produce and Package the Frontend Project Profile

**Files:**

- Create: `src/shared/frontend-project-profile.ts`
- Create: `src/shared/frontend-project-profile.test.ts`
- Create: `src/server/knowledge/frontend/project-profile.ts`
- Create: `src/server/knowledge/frontend/project-profile.test.ts`
- Modify: `src/server/knowledge/frontend/compatibility.ts`
- Modify: `src/server/knowledge/frontend/compatibility.test.ts`
- Modify: `src/server/knowledge/frontend/shadow-stage.ts`
- Modify: `src/server/knowledge/frontend/frontend-mode-stage.test.ts`
- Modify: `src/server/knowledge/pipeline/package-stage.ts`
- Modify: `src/server/knowledge/pipeline/package-stage.test.ts`
- Modify: `src/server/knowledge/frontend/preview.ts`
- Modify: `src/server/knowledge/frontend/preview.test.ts`

**Interfaces:**

- Consumes: `FrontendIR`, Graph v2, analyzer manifest, `SourceProvenance`, and project manifest facts.
- Produces: `frontendProjectProfileSchema`, `deriveFrontendProjectProfile(input)`, artifact kind `frontend-project-profile`, schema version `1`, and a profile digest stored in the frontend package manifest.

- [ ] **Step 1: Write failing contract tests**

```ts
test("records known and unknown framework constraints without defaults", () => {
  const profile = deriveFrontendProjectProfile(fixture);
  expect(profile.framework).toEqual({ state: "known", value: { name: "react", version: "19.0.0", supported: true } });
  expect(profile.formLibrary).toEqual({ state: "unknown", reason: "unresolved" });
});

test("rejects a package that omits the project profile artifact", () => {
  expect(() => frontendPipelinePackageSchema.parse(packageWithoutProfile)).toThrow("frontend project profile");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/shared/frontend-project-profile.test.ts src/server/knowledge/frontend/project-profile.test.ts src/server/knowledge/frontend/compatibility.test.ts`

Expected: FAIL because no project-profile artifact is declared.

- [ ] **Step 3: Implement deterministic profile extraction**

Use the same `known | unknown(reason)` shape as Frontend IR. Infer only framework/version, rendering boundary, router, state, data, build, style, visualization, test, and workspace properties that existing analyzers cite. Do not inspect runtime configuration or execute project code.

```ts
export function deriveFrontendProjectProfile(input: ProjectProfileInput): FrontendProjectProfile {
  return frontendProjectProfileSchema.parse({
    schemaVersion: 1,
    snapshotId: input.ir.snapshotId,
    sourceProvenance: input.sourceProvenance,
    framework: frameworkFromManifest(input.manifest),
    rendering: renderingFromEntities(input.ir.entities),
    router: facetValue(input.ir.entities, "react-router"),
    state: facetValue(input.ir.entities, "state-data"),
    data: facetValue(input.ir.entities, "state-data"),
    tooling: toolingFromEntities(input.ir.entities),
    styles: facetValue(input.ir.entities, "styles"),
    visualizations: facetValue(input.ir.entities, "visualization"),
    tests: facetValue(input.ir.entities, "tooling-tests"),
    analyzerManifestDigest: input.analyzerManifestDigest
  });
}
```

Add profile output to the v2 synthesize manifest, require it in validation/package provenance, and expose it through the administrator preview only. Existing v1 packages remain unchanged.

- [ ] **Step 4: Run pipeline tests**

Run: `npm test -- src/server/knowledge/frontend/project-profile.test.ts src/server/knowledge/frontend/frontend-mode-stage.test.ts src/server/knowledge/pipeline/package-stage.test.ts src/server/knowledge/frontend/preview.test.ts`

Expected: PASS; the profile stays within the build/snapshot scope, is reproducible, and missing artifacts block only v2 packaging.

- [ ] **Step 5: Commit**

```bash
git add src/shared/frontend-project-profile.ts src/shared/frontend-project-profile.test.ts src/server/knowledge/frontend src/server/knowledge/pipeline/package-stage.ts src/server/knowledge/pipeline/package-stage.test.ts
git commit -m "feat: package frontend project profiles"
```

## Task 4: EX04 Persist Experience Evidence, Decisions, Outcomes, and Reviews

**Files:**

- Create: `drizzle/0037_frontend_experience_contracts.sql`
- Create: `src/shared/frontend-experience.ts`
- Create: `src/shared/frontend-experience.test.ts`
- Create: `src/server/knowledge/frontend/experience-lifecycle.ts`
- Create: `src/server/knowledge/frontend/experience-lifecycle.test.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/schema.test.ts`
- Modify: `src/db/migrate.test.ts`
- Modify: `src/server/persistence/store.ts`
- Modify: `src/server/persistence/memory-store.ts`
- Modify: `src/server/persistence/memory-store.test.ts`
- Modify: `src/server/persistence/postgres-store.ts`
- Modify: `src/server/persistence/postgres-store.test.ts`
- Modify: `src/server/persistence/postgres-knowledge.integration.test.ts`

**Interfaces:**

- Consumes: profile artifact digest and source provenance from Tasks 2-3.
- Produces: `FrontendExperience`, `ObservedPatternEvidence`, `DeclaredDecisionEvidence`, `VerifiedOutcomeEvidence`, `ExperienceReviewEvent`, `WorkspaceStandard`, and `ExperienceStore` methods.

- [ ] **Step 1: Write failing lifecycle and isolation tests**

```ts
test("only approved Git evidence can move a pattern from verified to recommended", () => {
  expect(() => transitionExperience(candidate, { to: "recommended", actorId: adminId, basis: [uploadEvidence.id] }))
    .toThrow("Recommended experience requires visible eligible evidence and an approved decision");
});

test("does not expose human-readable pattern text from an inaccessible project", async () => {
  await store.saveExperienceEvidence(secretProjectEvidence);
  expect(await store.listExperienceProjection({ workspaceId, userId: otherUserId, currentProjectId, query: "chart" }))
    .not.toContainEqual(expect.objectContaining({ title: expect.stringContaining("secret-symbol") }));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/shared/frontend-experience.test.ts src/server/knowledge/frontend/experience-lifecycle.test.ts src/server/persistence/memory-store.test.ts`

Expected: FAIL because experience records and ACL projections do not exist.

- [ ] **Step 3: Add typed contracts and schema constraints**

Use opaque `workspace_pattern_groups`; place every project/release/citation in `workspace_pattern_evidence`; store decisions, outcomes, review events, and standards separately. Every table needs `(id, workspace_id)` uniqueness and workspace-composite foreign keys. Add CHECK constraints for evidence type, lifecycle state, outcome authority, source eligibility, non-empty review basis, and no self-supersession.

```ts
export const EXPERIENCE_STATES = ["candidate", "verified", "recommended", "standard", "rejected", "deprecated"] as const;
export type ExperienceState = (typeof EXPERIENCE_STATES)[number];

export function transitionExperience(current: ExperienceState, next: ExperienceState): void {
  const allowed: Record<ExperienceState, readonly ExperienceState[]> = {
    candidate: ["verified", "rejected"],
    verified: ["recommended", "deprecated", "rejected"],
    recommended: ["standard", "deprecated"],
    standard: ["deprecated"],
    rejected: [],
    deprecated: []
  };
  if (!allowed[current].includes(next)) throw new Error(`Invalid experience transition: ${current} -> ${next}`);
}
```

`AppStore` receives narrowly named methods such as `saveObservedPatternEvidence`, `createExperienceDecisionWithAudit`, `recordExperienceOutcome`, `transitionExperienceWithAudit`, `listExperienceReviewEvents`, and `listExperienceProjection`. Do not expose raw pattern-group rows to API callers.

- [ ] **Step 4: Run migration and PostgreSQL integration tests**

Run: `npm test -- src/db/schema.test.ts src/db/migrate.test.ts src/shared/frontend-experience.test.ts src/server/knowledge/frontend/experience-lifecycle.test.ts src/server/persistence/postgres-knowledge.integration.test.ts`

Expected: PASS; cross-workspace joins, cross-release evidence, missing citations, invalid state transitions, invisible basis, and self-supersession are rejected.

- [ ] **Step 5: Commit**

```bash
git add drizzle/0037_frontend_experience_contracts.sql src/shared/frontend-experience.ts src/shared/frontend-experience.test.ts src/server/knowledge/frontend/experience-lifecycle.ts src/server/knowledge/frontend/experience-lifecycle.test.ts src/db src/server/persistence
git commit -m "feat: persist governed frontend experience evidence"
```

## Task 5: EX05 Extract Observable Candidates from Published Frontend Releases

**Files:**

- Create: `src/server/knowledge/frontend/patterns.ts`
- Create: `src/server/knowledge/frontend/patterns.test.ts`
- Create: `src/server/knowledge/frontend/search-intent.ts`
- Create: `src/server/knowledge/frontend/search-intent.test.ts`
- Modify: `src/server/knowledge/frontend/compatibility.ts`
- Modify: `src/server/knowledge/frontend/shadow-stage.ts`
- Modify: `src/server/knowledge/pipeline/index-stage.ts`
- Modify: `src/server/knowledge/pipeline/index-stage.test.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/knowledge/releases.test.ts`

**Interfaces:**

- Consumes: `frontend-project-profile@1`, Frontend IR, Graph v2, v2 release provenance, and provenance eligibility from Task 2.
- Produces: `frontend-pattern-candidates@1` package artifact and `indexPublishedFrontendPatternEvidence(input)`.

- [ ] **Step 1: Write failing extraction tests**

```ts
test("extracts an observable ECharts drilldown candidate without inventing a decision", () => {
  const candidates = extractObservedPatterns({ profile, graph, ir });
  expect(candidates).toContainEqual(expect.objectContaining({ capability: "chart_drilldown", evidenceType: "observed_fact" }));
  expect(candidates[0]).not.toHaveProperty("selectedApproach");
  expect(candidates[0].sourceRefs.length).toBeGreaterThan(0);
});

test("does not index an unverified upload as workspace evidence", async () => {
  await expect(indexPublishedFrontendPatternEvidence(unverifiedUploadRelease)).resolves.toEqual({ indexed: 0, reason: "SOURCE_NOT_ELIGIBLE" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/server/knowledge/frontend/patterns.test.ts src/server/knowledge/pipeline/index-stage.test.ts src/server/knowledge/releases.test.ts`

Expected: FAIL because candidate artifacts and publication indexing are absent.

- [ ] **Step 3: Implement deterministic extraction and publish-time indexing**

Derive candidates only from cited fact edges and profile facts. Normalize a signature from capability, framework family, implementation relation kinds, and static dependency facets; do not include names or source text from one project in the group key.

```ts
export function candidateGroupKey(candidate: ObservedPatternCandidate): string {
  return createHash("sha256").update(JSON.stringify({
    capability: candidate.capability,
    framework: candidate.frameworkFamily,
    relations: [...candidate.relationKinds].sort(),
    facets: [...candidate.staticFacetKeys].sort()
  })).digest("hex");
}
```

Emit the candidate artifact during `index`, validate source refs and profile digest, include the artifact in the v2 package, then index evidence only after a matching `frontend-v2` release is published. Re-publishing the same release must be idempotent.

- [ ] **Step 4: Run focused verification**

Run: `npm test -- src/server/knowledge/frontend/patterns.test.ts src/server/knowledge/frontend/search-intent.test.ts src/server/knowledge/pipeline/index-stage.test.ts src/server/knowledge/releases.test.ts`

Expected: PASS; candidates are deterministic, cited, release-scoped, and never infer decisions or outcomes.

- [ ] **Step 5: Commit**

```bash
git add src/server/knowledge/frontend/patterns.ts src/server/knowledge/frontend/patterns.test.ts src/server/knowledge/frontend/search-intent.ts src/server/knowledge/frontend/search-intent.test.ts src/server/knowledge/frontend/compatibility.ts src/server/knowledge/frontend/shadow-stage.ts src/server/knowledge/pipeline/index-stage.ts src/server/knowledge/pipeline/index-stage.test.ts src/server/app.ts src/server/knowledge/releases.test.ts
git commit -m "feat: derive published frontend pattern evidence"
```

## Task 6: EX06 Add Decisions, Standards, and Trusted Outcome Intake

**Files:**

- Create: `src/server/knowledge/frontend/experience-governance.ts`
- Create: `src/server/knowledge/frontend/experience-governance.test.ts`
- Create: `src/server/knowledge/frontend/outcome-verifier.ts`
- Create: `src/server/knowledge/frontend/outcome-verifier.test.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/app.test.ts`
- Modify: `src/server/persistence/store.ts`
- Modify: `src/server/persistence/memory-store.ts`
- Modify: `src/server/persistence/postgres-store.ts`
- Modify: `src/server/persistence/postgres-knowledge.integration.test.ts`

**Interfaces:**

- Consumes: persisted candidates and lifecycle validation from Tasks 4-5.
- Produces: administrator review routes, append-only decision/outcome events, a provider-neutral `CiOutcomeVerifier`, and review remediation cases.

- [ ] **Step 1: Write failing governance tests**

```ts
test("requires cited eligible evidence before approving a recommendation", async () => {
  await expect(governance.recommend({ experienceId, actorId, decision: missingBasis })).rejects
    .toThrow("Recommendation basis is incomplete or not visible");
});

test("accepts a signed outcome only when repository and source version match", () => {
  expect(() => verifySignedOutcome({ payload, signature, expectedRepositoryId, expectedSourceVersion })).not.toThrow();
  expect(() => verifySignedOutcome({ payload: { ...payload, sourceVersion: otherVersion }, signature, expectedRepositoryId, expectedSourceVersion }))
    .toThrow("CI outcome source version does not match");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/server/knowledge/frontend/experience-governance.test.ts src/server/knowledge/frontend/outcome-verifier.test.ts src/server/app.test.ts`

Expected: FAIL because governance routes and verifier do not exist.

- [ ] **Step 3: Implement review and outcome contracts**

Create administrator-only REST routes for decision creation, review transition, standard creation, deprecation, supersession, and manual outcome attestation. Each route uses Zod bounded strings, validates all cited evidence belongs to the workspace and is visible to the actor, and writes one audit event in the same persistence operation.

```ts
export interface CiOutcomeVerifier {
  verify(input: { rawBody: Buffer; signature: string; expectedRepositoryId: string; expectedSourceVersion: string }): VerifiedOutcomeEvidence;
}

export function appliesOutcomeToRecommendation(outcome: VerifiedOutcomeEvidence): boolean {
  return outcome.authority === "signed_ci" && (outcome.outcome === "failed" || outcome.outcome === "rolled_back");
}
```

Implement the verifier interface and test fake only. Do not configure a production webhook secret, provider URL, or public endpoint in this task; those require the separate user authorization named in the global constraints.

- [ ] **Step 4: Run governance tests**

Run: `npm test -- src/server/knowledge/frontend/experience-governance.test.ts src/server/knowledge/frontend/outcome-verifier.test.ts src/server/app.test.ts src/server/persistence/postgres-knowledge.integration.test.ts`

Expected: PASS; a negative signed outcome pauses only the affected evidence, user-reported feedback cannot promote trust, and every state change is audited.

- [ ] **Step 5: Commit**

```bash
git add src/server/knowledge/frontend/experience-governance.ts src/server/knowledge/frontend/experience-governance.test.ts src/server/knowledge/frontend/outcome-verifier.ts src/server/knowledge/frontend/outcome-verifier.test.ts src/server/app.ts src/server/app.test.ts src/server/persistence
git commit -m "feat: govern frontend experience decisions and outcomes"
```

## Task 7: EX07 Build ACL-Safe Applicability and Projection Queries

**Files:**

- Create: `src/server/knowledge/frontend/experience-query.ts`
- Create: `src/server/knowledge/frontend/experience-query.test.ts`
- Create: `src/server/knowledge/frontend/experience-projection-cache.ts`
- Create: `src/server/knowledge/frontend/experience-projection-cache.test.ts`
- Modify: `src/server/persistence/store.ts`
- Modify: `src/server/persistence/memory-store.ts`
- Modify: `src/server/persistence/postgres-store.ts`
- Modify: `src/server/persistence/postgres-knowledge.integration.test.ts`
- Modify: `src/server/knowledge/frontend/search-intent.ts`

**Interfaces:**

- Consumes: project profile, experience evidence, decisions, outcomes, project access, session version, and release visibility.
- Produces: `queryExperienceProjection(input)`, `ApplicabilityRejectionReason`, a bounded projection cache, and deterministic ranking.

- [ ] **Step 1: Write failing hard-filter and leakage tests**

```ts
test("rejects Vue evidence for a React project before text ranking", async () => {
  const result = await queryExperienceProjection({ currentProfile: reactProfile, query: "图表下钻", actor });
  expect(result.applicableExperiences.map((item) => item.id)).not.toContain(vueExperience.id);
  expect(result.rejectedExperiences).toContainEqual({ experienceId: vueExperience.id, reasons: ["FRAMEWORK_MISMATCH"] });
});

test("invalidates a cached projection when a release becomes inaccessible", async () => {
  await cache.getOrLoad(key, loadProjection);
  revokeProjectMembership();
  const next = await cache.getOrLoad(nextAclRevisionKey, loadProjection);
  expect(next.visibleReleaseIds).not.toContain(secretRelease.id);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/server/knowledge/frontend/experience-query.test.ts src/server/knowledge/frontend/experience-projection-cache.test.ts src/server/persistence/postgres-knowledge.integration.test.ts`

Expected: FAIL because no applicability query exists.

- [ ] **Step 3: Implement fixed-order filtering and ranking**

```ts
export async function queryExperienceProjection(input: ExperienceQueryInput): Promise<ExperienceQueryResult> {
  const visible = await input.store.listVisibleExperienceEvidence(input.workspaceId, input.userId, input.currentProjectId);
  const eligible = visible.filter((item) => sourceEligible(item.sourceProvenance) && recommendationEligible(item));
  const evaluated = eligible.map((item) => evaluateApplicability(item, input.currentProfile));
  return materializeExperienceProjection({
    applicable: evaluated.filter((item) => item.rejections.length === 0),
    rejected: evaluated.filter((item) => item.rejections.length > 0),
    rankingVersion: 1
  });
}
```

`evaluateApplicability` must apply ACL/current-project exclusion, source eligibility, lifecycle, release freshness, required predicates, forbidden predicates, and unknown-required predicates in that order. Only then rank by capability match, evidence quality, freshness, and verified outcome quality. Cache keys must include every field listed in the approved design.

- [ ] **Step 4: Run focused verification**

Run: `npm test -- src/server/knowledge/frontend/experience-query.test.ts src/server/knowledge/frontend/experience-projection-cache.test.ts src/server/persistence/postgres-knowledge.integration.test.ts`

Expected: PASS; inaccessible evidence affects neither projections nor counts/ranking/cache, and hard conflicts never appear in defaults.

- [ ] **Step 5: Commit**

```bash
git add src/server/knowledge/frontend/experience-query.ts src/server/knowledge/frontend/experience-query.test.ts src/server/knowledge/frontend/experience-projection-cache.ts src/server/knowledge/frontend/experience-projection-cache.test.ts src/server/knowledge/frontend/search-intent.ts src/server/persistence
git commit -m "feat: filter frontend experience by project applicability"
```

## Task 8: EX08 Add User-Bound Workspace MCP Planning

**Files:**

- Create: `drizzle/0038_workspace_mcp_tokens.sql`
- Create: `src/server/mcp/workspace-auth.ts`
- Create: `src/server/mcp/workspace-auth.test.ts`
- Create: `src/server/mcp/workspace-tools.ts`
- Create: `src/server/mcp/workspace-tools.test.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/mcp-access.test.ts`
- Modify: `src/server/persistence/store.ts`
- Modify: `src/server/persistence/memory-store.ts`
- Modify: `src/server/persistence/postgres-store.ts`
- Modify: `src/server/persistence/postgres-knowledge.integration.test.ts`
- Modify: `src/client/api/types.ts`
- Modify: `src/client/api/client.ts`
- Modify: `src/client/pages/system-settings-page.tsx`
- Modify: `src/client/pages/project-codex-page.tsx`
- Modify: `docs/operations/workspace-mcp.md`

**Interfaces:**

- Consumes: applicability query from Task 7 and project MCP contracts.
- Produces: `workspace_mcp_tokens`, `/mcp/workspace`, `dkh_find_prior_implementations`, `dkh_plan_frontend_solution`, and scope `workspace.patterns.read | workspace.solutions.read`.

- [ ] **Step 1: Write failing MCP contract tests**

```ts
test("returns typed no-release context instead of a transport error", async () => {
  const result = await callWorkspaceTool("dkh_plan_frontend_solution", { currentProjectId, task: "实现下钻页面" });
  expect(result.structuredContent).toMatchObject({ currentProject: { status: "no_release", releaseId: null }, applicableExperiences: [] });
});

test("requires currentProjectId and excludes it from prior evidence", async () => {
  await expect(callWorkspaceTool("dkh_find_prior_implementations", { query: "缓存" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  const result = await callWorkspaceTool("dkh_find_prior_implementations", { currentProjectId, query: "缓存" });
  expect(result.content[0]!.text).not.toContain(currentProjectPrivateSymbol);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/server/mcp/workspace-auth.test.ts src/server/mcp/workspace-tools.test.ts src/server/mcp-access.test.ts`

Expected: FAIL because workspace tokens and `/mcp/workspace` do not exist.

- [ ] **Step 3: Implement token and tool separation**

Store only token hash/prefix. Bind a workspace token to workspace user and current `sessionVersion`; allow only its owner to create, rotate, revoke, or list it; expire it at 30 days. Never add workspace scopes to `mcp_tokens`.

```ts
export const WORKSPACE_MCP_TOKEN_SCOPES = ["workspace.patterns.read", "workspace.solutions.read"] as const;

export function buildSolutionContext(input: WorkspaceSolutionInput): Promise<FrontendSolutionContext> {
  return resolveFrontendSolutionContext(input);
}
```

`dkh_plan_frontend_solution` calls the project-fact resolver and experience-query resolver in process with the authenticated workspace user, returning separate fields. It does not call an LLM and it does not combine project evidence into `priorProjectReferences`. Normal no-release/stale/unsupported/no-applicable states return structured content; access, token, citation, and malformed input failures return stable MCP errors.

- [ ] **Step 4: Run MCP, API, and PostgreSQL tests**

Run: `npm test -- src/server/mcp/workspace-auth.test.ts src/server/mcp/workspace-tools.test.ts src/server/mcp-access.test.ts src/server/persistence/postgres-knowledge.integration.test.ts`

Expected: PASS; expiration, session revocation, project ACL changes, missing current project, source.read scope separation, and current-project exclusion all behave correctly.

- [ ] **Step 5: Commit**

```bash
git add drizzle/0038_workspace_mcp_tokens.sql src/server/mcp src/server/app.ts src/server/mcp-access.test.ts src/server/persistence src/client/api src/client/pages/system-settings-page.tsx src/client/pages/project-codex-page.tsx docs/operations/workspace-mcp.md
git commit -m "feat: add workspace frontend solution MCP"
```

## Task 9: EX09 Deliver the Experience Library, Review Queue, and Solution Context UI

**Files:**

- Create: `src/client/pages/workspace-experiences-page.tsx`
- Create: `src/client/pages/workspace-experiences-page.test.tsx`
- Create: `src/client/components/experience-review-panel.tsx`
- Create: `src/client/components/experience-review-panel.test.tsx`
- Create: `src/client/components/experience-solution-context.tsx`
- Create: `src/client/components/experience-solution-context.test.tsx`
- Modify: `src/client/app.tsx`
- Modify: `src/client/api/types.ts`
- Modify: `src/client/api/client.ts`
- Modify: `src/client/styles.css`
- Modify: `src/client/responsive.css`
- Modify: `src/server/app.ts`
- Modify: `src/server/app.test.ts`

**Interfaces:**

- Consumes: REST DTOs for experience projections/reviews and `FrontendSolutionContext` from Task 8.
- Produces: reader-safe experience browsing, administrator-only review mutations, and a stable visual partition of solution context.

- [ ] **Step 1: Write failing UI tests**

```tsx
test("keeps current facts, experience references, exclusions, and unknowns separate", async () => {
  render(<ExperienceSolutionContext context={fixtureContext} />);
  expect(screen.getByRole("region", { name: "当前项目事实" })).toHaveTextContent("React Router");
  expect(screen.getByRole("region", { name: "历史工程经验" })).toHaveTextContent("ECharts 下钻");
  expect(screen.getByRole("region", { name: "已排除方案" })).toHaveTextContent("Vue 框架不匹配");
  expect(screen.getByRole("region", { name: "待确认条件" })).toHaveTextContent("图表数据量");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/client/pages/workspace-experiences-page.test.tsx src/client/components/experience-review-panel.test.tsx src/client/components/experience-solution-context.test.tsx src/client/app.test.tsx`

Expected: FAIL because components, routes, and API types do not exist.

- [ ] **Step 3: Implement REST and React surfaces**

Add REST endpoints that use `requireProjectRole("reader")` for current-project facts, workspace member access for projections, and workspace administrator access for review mutations. Return explicit state rather than silently falling back to generic search.

Render one unframed page band per concept; do not nest cards. Review actions use existing command buttons and Lucide icons, require a non-empty reason, and show citations/release/source-kind beside every evidence row. Reader/member users may browse allowed evidence but never see review mutation controls.

- [ ] **Step 4: Run UI and route verification**

Run: `npm test -- src/client/pages/workspace-experiences-page.test.tsx src/client/components/experience-review-panel.test.tsx src/client/components/experience-solution-context.test.tsx src/client/app.test.tsx src/server/app.test.ts`

Expected: PASS; mobile 390px states do not overflow, reader controls are absent, admin review requires reasons, and no-release state has no recommendation.

- [ ] **Step 5: Commit**

```bash
git add src/client/pages/workspace-experiences-page.tsx src/client/pages/workspace-experiences-page.test.tsx src/client/components/experience-review-panel.tsx src/client/components/experience-review-panel.test.tsx src/client/components/experience-solution-context.tsx src/client/components/experience-solution-context.test.tsx src/client/app.tsx src/client/api src/client/styles.css src/client/responsive.css src/server/app.ts src/server/app.test.ts
git commit -m "feat: deliver frontend experience review workspace"
```

## Task 10: EX10 Connect Feedback, Experience Lint, and Remediation

**Files:**

- Create: `src/server/knowledge/frontend/experience-lint.ts`
- Create: `src/server/knowledge/frontend/experience-lint.test.ts`
- Modify: `src/server/knowledge/frontend/experience-governance.ts`
- Modify: `src/server/knowledge/frontend/experience-governance.test.ts`
- Modify: `src/server/knowledge/quality-assessment.ts`
- Modify: `src/server/knowledge/quality-assessment.test.ts`
- Modify: `src/server/app.ts`
- Modify: `src/client/pages/feedback-page.tsx`
- Modify: `src/client/components/quality-governance-panel.tsx`

**Interfaces:**

- Consumes: review events, outcome events, existing feedback/remediation state machines.
- Produces: `ExperienceLintIssue[]`, review queue creation, and safe negative-feedback handling.

- [ ] **Step 1: Write failing lint tests**

```ts
test("opens a high-severity review when signed CI reports rollback", () => {
  const issues = lintExperience({ experience, outcomes: [signedRollback] });
  expect(issues).toContainEqual(expect.objectContaining({ rule: "EXPERIENCE_SIGNED_OUTCOME_FAILED", severity: "error" }));
});

test("flags a recommended experience whose approval basis is no longer visible", () => {
  expect(lintExperience({ experience: hiddenBasisExperience, outcomes: [] }))
    .toContainEqual(expect.objectContaining({ rule: "EXPERIENCE_APPROVAL_BASIS_REVOKED" }));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/server/knowledge/frontend/experience-lint.test.ts src/server/knowledge/frontend/experience-governance.test.ts src/server/knowledge/quality-assessment.test.ts`

Expected: FAIL because experience lint rules are absent.

- [ ] **Step 3: Implement bounded lint rules and queue behavior**

Implement rules for missing citations, invisible approval basis, contradictory applicability, expired framework support, mismatched outcome source version, deprecated recommendation, self/cyclic supersession, and signed failure/rollback. High-severity signed outcomes pause only the affected evidence; user feedback creates a review candidate and cannot directly change lifecycle state.

```ts
export function lintExperience(input: ExperienceLintInput): ExperienceLintIssue[] {
  const issues: ExperienceLintIssue[] = [];
  if (input.experience.state === "recommended" && !input.approvalBasisVisible) issues.push(issue("EXPERIENCE_APPROVAL_BASIS_REVOKED", "error"));
  if (input.outcomes.some((outcome) => outcome.authority === "signed_ci" && ["failed", "rolled_back"].includes(outcome.outcome))) {
    issues.push(issue("EXPERIENCE_SIGNED_OUTCOME_FAILED", "error"));
  }
  return issues;
}
```

- [ ] **Step 4: Run focused verification**

Run: `npm test -- src/server/knowledge/frontend/experience-lint.test.ts src/server/knowledge/frontend/experience-governance.test.ts src/server/knowledge/quality-assessment.test.ts src/server/app.test.ts`

Expected: PASS; negative events remain auditable, no automatic content rewrite occurs, and paused evidence no longer enters defaults.

- [ ] **Step 5: Commit**

```bash
git add src/server/knowledge/frontend/experience-lint.ts src/server/knowledge/frontend/experience-lint.test.ts src/server/knowledge/frontend/experience-governance.ts src/server/knowledge/frontend/experience-governance.test.ts src/server/knowledge/quality-assessment.ts src/server/knowledge/quality-assessment.test.ts src/server/app.ts src/client/pages/feedback-page.tsx src/client/components/quality-governance-panel.tsx
git commit -m "feat: govern frontend experience feedback"
```

## Task 11: EX11 Add Experience Evaluation and Acceptance Gates

**Files:**

- Create: `evaluation/frontend/train/experience-react-routing.jsonl`
- Create: `evaluation/frontend/train/experience-state-api.jsonl`
- Create: `evaluation/frontend/train/experience-forms-auth.jsonl`
- Create: `evaluation/frontend/train/experience-charts.jsonl`
- Create: `evaluation/frontend/train/experience-impact-testing.jsonl`
- Create: `evaluation/frontend/held-out/experience-react-routing.jsonl`
- Create: `evaluation/frontend/held-out/experience-state-api.jsonl`
- Create: `evaluation/frontend/held-out/experience-forms-auth.jsonl`
- Create: `evaluation/frontend/held-out/experience-charts.jsonl`
- Create: `evaluation/frontend/held-out/experience-impact-testing.jsonl`
- Create: `acceptance/frontend-experience-solution.acceptance.test.ts`
- Create: `acceptance/frontend-experience-revocation.acceptance.test.ts`
- Create: `acceptance/frontend-experience-source-provenance.acceptance.test.ts`
- Modify: `scripts/evaluate-frontend-knowledge.mjs`
- Modify: `src/server/knowledge/frontend/evaluation.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: `FrontendSolutionContext`, evaluation records, and all EX contracts.
- Produces: `npm run evaluate:frontend-experience` and strict held-out gates.

- [ ] **Step 1: Write failing evaluation parser tests**

```ts
test("fails when a held-out experience case lacks expected abstention or rejection labels", async () => {
  await expect(loadExperienceEvaluationFixture(incompleteFixture)).rejects
    .toThrow("Experience evaluation case requires expectedDecision");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/server/knowledge/frontend/evaluation.test.ts`

Expected: FAIL because the evaluator does not know experience labels.

- [ ] **Step 3: Extend the evaluator and fixtures**

Each JSONL case must include `currentProjectProfile`, visible/invisible evidence ids, query, expected recommendation ids, expected rejection reason codes, expected unknown keys, and whether abstention is required. Do not derive held-out fixtures from analyzer fixtures or approval data.

```js
const thresholds = {
  sourceProvenanceAccuracy: 1,
  hardConflictRecommendationRate: 0,
  revokedEvidenceRecommendationRate: 0,
  recommendationApplicabilityPrecision: 0.95,
  requiredUnknownAbstentionRecall: 0.95,
  currentProjectPriorLeakRate: 0,
  responsePartitionValidity: 1
};
```

Add at least 12 train and 8 held-out cases for each V1 capability. Ensure at least 40% Chinese and at least 25% negative cases across hard conflict, unknown, no result, source ineligibility, and unauthorized evidence.

- [ ] **Step 4: Run evaluator and acceptance tests**

Run: `npm test -- src/server/knowledge/frontend/evaluation.test.ts acceptance/frontend-experience-solution.acceptance.test.ts acceptance/frontend-experience-revocation.acceptance.test.ts acceptance/frontend-experience-source-provenance.acceptance.test.ts && npm run evaluate:frontend-experience`

Expected: PASS only when every zero-tolerance leakage/conflict metric is zero and all numeric thresholds are met.

- [ ] **Step 5: Commit**

```bash
git add evaluation/frontend acceptance scripts/evaluate-frontend-knowledge.mjs src/server/knowledge/frontend/evaluation.test.ts package.json .github/workflows/ci.yml
git commit -m "test: gate frontend experience decisions"
```

## Task 12: EX12 Verify Recovery, Staging Rollout, and V1 Trial Handoff

**Files:**

- Create: `docs/operations/frontend-experience-kernel-rollout.md`
- Create: `docs/releases/frontend-experience-kernel-staging-evidence.md`
- Create: `scripts/backup/validate-experience-recovery.mjs`
- Create: `scripts/backup/validate-experience-recovery.test.mjs`
- Modify: `scripts/backup/devkh-backup.sh`
- Modify: `scripts/backup/devkh-restore-drill.sh`
- Modify: `scripts/backup/validate-recovery-evidence.mjs`
- Modify: `scripts/backup/backup.test.mjs`
- Modify: `scripts/verify-delivery.mjs`
- Modify: `docs/operations/frontend-v1-trial.md`
- Modify: `docs/superpowers/plans/2026-07-18-frontend-knowledge-platform.md`

**Interfaces:**

- Consumes: every EX artifact/table and the original V1 Trial gates.
- Produces: isolated staging evidence, recovery validation, rollback contract, and an updated handoff to FK19-FK22/FK23.

- [ ] **Step 1: Write failing recovery validation tests**

```js
test("rejects recovery evidence when an experience review basis references a missing release", async () => {
  const result = await validateExperienceRecoveryEvidence({ restoredDatabase, restoredArtifacts });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /experience review basis release missing/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/backup/validate-experience-recovery.test.mjs`

Expected: FAIL because backup validation does not inspect experience tables or profile artifacts.

- [ ] **Step 3: Implement recovery and staging gates**

Validate that restored source provenance, project profiles, pattern evidence, decisions, outcomes, review events, standards, artifact digests, release links, and opaque audit records agree. The rollback operation disables `/mcp/workspace` solution planning and default recommendations, preserving project MCP, immutable releases, review history, and recovery evidence.

Staging must execute all five approved golden flows, desktop/mobile UI checks, workspace token expiry/revocation, current-project exclusion, upload eligibility, missing-profile abstention, signed-outcome pause, restore drill, and P95 measurements. It must not issue production tokens or modify `hub.starking.icu`.

- [ ] **Step 4: Run the full delivery gate**

Run:

```bash
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run acceptance
npm run evaluate:knowledge
npm run evaluate:frontend
npm run evaluate:frontend-experience
npm run build
npm run test:e2e
npm run test:backup
npm run delivery:verify
```

Expected: every command exits `0`; staging evidence is complete; no production action has occurred.

- [ ] **Step 5: Commit**

```bash
git add docs/operations/frontend-experience-kernel-rollout.md docs/releases/frontend-experience-kernel-staging-evidence.md scripts/backup scripts/verify-delivery.mjs docs/operations/frontend-v1-trial.md docs/superpowers/plans/2026-07-18-frontend-knowledge-platform.md
git commit -m "test: verify frontend experience kernel staging gate"
```

## Plan Self-Review

### Spec Coverage

- Git/upload source identity and eligibility: Tasks 1-2.
- Project-derived profile without a new pipeline stage: Task 3.
- Separate facts, decisions, and outcomes with audited lifecycle: Tasks 4 and 6.
- Observable-only candidate extraction: Task 5.
- ACL-first applicability, source eligibility, hard conflicts, unknowns, and cache invalidation: Task 7.
- Independent workspace MCP token and structured solution context: Task 8.
- Cold start, review workflow, separation UI, and mobile/role controls: Tasks 1 and 9.
- Feedback, signed-result pause, lint, and remediation: Tasks 6 and 10.
- Quantitative applicability, abstention, leakage, and partition gates: Task 11.
- Backup, restore, staging, rollback, and original V1 Trial handoff: Task 12.

### Placeholder Scan

The plan contains no unresolved placeholders or generic error-handling instructions. Deferred production CI webhook setup is an explicit authorization boundary, not missing behavior: Task 6 implements the verifier contract and manual path without creating a production integration.

### Type Consistency

- `SourceProvenance` is introduced in Task 2 and consumed by Tasks 3, 5, and 7.
- `FrontendProjectProfile` is introduced in Task 3 and consumed by Tasks 4, 5, 7, 8, and 11.
- Experience evidence/lifecycle types are introduced in Task 4 and consumed by Tasks 5-12.
- `FrontendSolutionContext` is defined in the approved design and materialized in Task 8 before Task 9 and Task 11 consume it.
- Migration order is `0035` FK17, `0036` source provenance, `0037` experience contracts, `0038` workspace MCP tokens; no task reuses a migration identifier.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-21-frontend-experience-decision-kernel.md`.

1. **Subagent-Driven (recommended):** Dispatch a fresh implementer and two-stage review for each EX task.
2. **Inline Execution:** Execute this plan in the current session with checkpoint reviews after each task.
