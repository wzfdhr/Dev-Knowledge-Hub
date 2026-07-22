import { randomUUID } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import type { ReleaseRecord } from "./store";
import { MemoryAppStore } from "./memory-store";
import { PostgresAppStore } from "./postgres-store";
import { queryExperienceProjection } from "../knowledge/frontend/experience-query";

function release(input: {
  workspaceId: string; repositoryId: string; snapshotId: string; id?: string;
}): ReleaseRecord {
  return {
    id: input.id ?? randomUUID(), workspaceId: input.workspaceId, repositoryId: input.repositoryId,
    buildId: randomUUID(), snapshotId: input.snapshotId, version: "frontend-v2.0.0",
    kernelMode: "pipeline", packageArtifactId: randomUUID(), releaseArtifactFamily: "frontend-v2",
    packageStageRunId: randomUUID(), frontendIrSchemaVersion: 2, frontendGraphSchemaVersion: 2,
    analyzerManifestDigest: "a".repeat(64), createdAt: new Date(), publishedAt: new Date()
  };
}

describe("MemoryAppStore frontend experience", () => {
  test("persists eligible review basis and append-only lifecycle events", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const [project] = await store.listProjects(setup!.workspace.id);
    const repository = await store.createRepository(
      setup!.workspace.id, { kind: "git", name: "Frontend", url: "https://example.test/frontend.git" }, project!.id
    );
    const sourceRelease = release({
      workspaceId: setup!.workspace.id, repositoryId: repository!.id, snapshotId: randomUUID()
    });
    store.releases.push(sourceRelease);
    const patternGroupId = randomUUID();
    const evidence = await store.saveObservedPatternEvidence({
      id: randomUUID(), workspaceId: setup!.workspace.id, patternGroupId,
      projectId: project!.id, releaseId: sourceRelease.id, snapshotId: sourceRelease.snapshotId,
      capability: "forms", sourceEligibility: "git", title: "Cited form boundary",
      observedFact: "Uses a schema at the submit boundary", profileDigest: "b".repeat(64),
      contentVersion: "content-1", citations: [{
        snapshotId: sourceRelease.snapshotId, path: "src/form.tsx", startLine: 1, endLine: 3,
        blobHash: "c".repeat(64)
      }]
    });
    const unverified: Record<string, unknown> = {
      ...evidence,
      id: randomUUID(),
      sourceEligibility: "unverified_upload"
    };
    delete unverified.revokedAt;
    delete unverified.createdAt;
    await expect(store.saveObservedPatternEvidence(
      unverified as Parameters<typeof store.saveObservedPatternEvidence>[0]
    )).rejects.toThrow("Unverified upload evidence");
    await store.transitionExperienceWithAudit({
      workspaceId: setup!.workspace.id, patternGroupId, to: "verified", actorId: setup!.admin.id,
      reason: "citation reviewed", basisEvidenceIds: [evidence.id], decisionId: null
    });
    const decision = await store.createExperienceDecisionWithAudit({
      id: randomUUID(), workspaceId: setup!.workspace.id, patternGroupId, actorId: setup!.admin.id,
      decision: "approve", reason: "eligible reusable implementation", basisEvidenceIds: [evidence.id],
      applicability: { required: [], forbidden: [], preferred: [], unsupportedWhenUnknown: [] }
    });
    await store.transitionExperienceWithAudit({
      workspaceId: setup!.workspace.id, patternGroupId, to: "recommended", actorId: setup!.admin.id,
      reason: "approved for reuse", basisEvidenceIds: [evidence.id], decisionId: decision.id
    });

    expect(await store.listExperienceReviewEvents(setup!.workspace.id, patternGroupId)).toEqual([
      expect.objectContaining({ fromState: "candidate", toState: "verified" }),
      expect.objectContaining({ fromState: "verified", toState: "recommended", decisionId: decision.id })
    ]);
  });

  test("does not expose readable evidence from an inaccessible project", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const [visibleProject] = await store.listProjects(setup!.workspace.id);
    const secretProject = await store.createProject(
      setup!.workspace.id, { name: "Secret", slug: "secret" }, setup!.admin.id
    );
    const currentProject = await store.createProject(
      setup!.workspace.id, { name: "Current", slug: "current" }, setup!.admin.id
    );
    const reader = await store.createTeamMember(setup!.workspace.id, {
      email: "reader@example.com", passwordHash: "hash", role: "reader"
    }, setup!.admin.id);
    await store.addProjectMember(
      setup!.workspace.id, visibleProject!.id, reader!.id, "reader", setup!.admin.id
    );
    await store.addProjectMember(
      setup!.workspace.id, currentProject!.id, reader!.id, "reader", setup!.admin.id
    );
    const visibleRepository = await store.createRepository(
      setup!.workspace.id, { kind: "upload", name: "Visible" }, visibleProject!.id
    );
    const secretRepository = await store.createRepository(
      setup!.workspace.id, { kind: "upload", name: "Secret" }, secretProject!.id
    );
    const visibleRelease = release({
      workspaceId: setup!.workspace.id, repositoryId: visibleRepository!.id, snapshotId: randomUUID()
    });
    const secretRelease = release({
      workspaceId: setup!.workspace.id, repositoryId: secretRepository!.id, snapshotId: randomUUID()
    });
    store.releases.push(visibleRelease, secretRelease);
    const groupId = randomUUID();
    const save = (projectId: string, sourceRelease: ReleaseRecord, title: string) =>
      store.saveObservedPatternEvidence({
        id: randomUUID(), workspaceId: setup!.workspace.id, patternGroupId: groupId,
        projectId, releaseId: sourceRelease.id, snapshotId: sourceRelease.snapshotId,
        capability: "visualization", sourceEligibility: "git_linked", title,
        observedFact: `${title} observed fact`, profileDigest: "b".repeat(64),
        contentVersion: "content-1", citations: [{
          snapshotId: sourceRelease.snapshotId, path: "src/chart.tsx", startLine: 1, endLine: 2,
          blobHash: "c".repeat(64)
        }]
      });
    const visibleEvidence = await save(visibleProject!.id, visibleRelease, "Visible chart pattern");
    const secretEvidence = await save(secretProject!.id, secretRelease, "secret-symbol chart pattern");
    await store.transitionExperienceWithAudit({
      workspaceId: setup!.workspace.id, patternGroupId: groupId, to: "verified",
      actorId: setup!.admin.id, reason: "visible basis", basisEvidenceIds: [visibleEvidence.id],
      decisionId: null
    });
    const visibleDecision = await store.createExperienceDecisionWithAudit({
      id: randomUUID(), workspaceId: setup!.workspace.id, patternGroupId: groupId,
      actorId: setup!.admin.id, decision: "approve", reason: "visible approval",
      basisEvidenceIds: [visibleEvidence.id],
      applicability: { required: [], forbidden: [], preferred: [], unsupportedWhenUnknown: [] }
    });
    await store.transitionExperienceWithAudit({
      workspaceId: setup!.workspace.id, patternGroupId: groupId, to: "recommended",
      actorId: setup!.admin.id, reason: "visible recommendation",
      basisEvidenceIds: [visibleEvidence.id], decisionId: visibleDecision.id
    });
    await store.transitionExperienceWithAudit({
      workspaceId: setup!.workspace.id, patternGroupId: groupId, to: "deprecated",
      actorId: setup!.admin.id, reason: "secret-only supersession",
      basisEvidenceIds: [secretEvidence.id], decisionId: null, supersededById: null
    });
    await store.recordExperienceOutcome({
      id: randomUUID(), workspaceId: setup!.workspace.id, patternGroupId: groupId,
      evidenceId: secretEvidence.id, authority: "signed_ci", outcome: "failed",
      sourceVersion: "content-1", checks: [], reportDigest: null, recordedBy: setup!.admin.id
    });

    const projection = await store.listExperienceProjection({
      workspaceId: setup!.workspace.id,
      userId: reader!.id,
      currentProjectId: currentProject!.id,
      query: "chart"
    });

    expect(JSON.stringify(projection)).not.toContain("secret-symbol");
    expect(projection).toEqual([expect.objectContaining({
      title: "Visible chart pattern", evidenceCount: 1
    })]);
    const candidates = await store.listVisibleExperienceCandidates({
      workspaceId: setup!.workspace.id, userId: reader!.id, currentProjectId: currentProject!.id
    });
    expect(JSON.stringify(candidates)).not.toContain("secret-symbol");
    expect(candidates[0]?.evidence).toHaveLength(1);
    const applicable = await queryExperienceProjection({
      store, workspaceId: setup!.workspace.id, userId: reader!.id,
      currentProjectId: currentProject!.id,
      currentProfile: { profileDigest: "d".repeat(64) } as never,
      query: "chart"
    });
    expect(applicable.applicableExperiences).toEqual([
      expect.objectContaining({ id: groupId, title: "Visible chart pattern", evidenceCount: 1 })
    ]);
    expect(JSON.stringify(applicable)).not.toContain("secret-symbol");
  });

  test("pauses only evidence with a matching trusted negative outcome", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const [sourceProject] = await store.listProjects(setup!.workspace.id);
    const currentProject = await store.createProject(
      setup!.workspace.id, { name: "Current", slug: "current" }, setup!.admin.id
    );
    const repository = await store.createRepository(
      setup!.workspace.id, { kind: "git", name: "Source", url: "https://example.test/source.git" },
      sourceProject!.id
    );
    const sourceRelease = release({
      workspaceId: setup!.workspace.id, repositoryId: repository!.id, snapshotId: randomUUID()
    });
    store.releases.push(sourceRelease);
    const patternGroupId = randomUUID();
    const evidence = await store.saveObservedPatternEvidence({
      id: randomUUID(), workspaceId: setup!.workspace.id, patternGroupId,
      projectId: sourceProject!.id, releaseId: sourceRelease.id, snapshotId: sourceRelease.snapshotId,
      capability: "forms", sourceEligibility: "git", title: "Cited validation",
      observedFact: "Validates before submit", profileDigest: "b".repeat(64),
      contentVersion: "content-v1", citations: [{
        snapshotId: sourceRelease.snapshotId, path: "src/form.tsx", startLine: 1, endLine: 2,
        blobHash: "c".repeat(64)
      }]
    });
    const projection = () => store.listExperienceProjection({
      workspaceId: setup!.workspace.id, userId: setup!.admin.id,
      currentProjectId: currentProject!.id, query: "validation"
    });

    expect(await projection()).toHaveLength(1);
    await expect(store.recordExperienceOutcome({
      id: randomUUID(), workspaceId: setup!.workspace.id, patternGroupId,
      evidenceId: evidence.id, authority: "signed_ci", outcome: "failed",
      sourceVersion: "other-version", checks: [], reportDigest: null, recordedBy: setup!.admin.id
    })).rejects.toThrow("source version does not match");
    await store.recordExperienceOutcome({
      id: randomUUID(), workspaceId: setup!.workspace.id, patternGroupId,
      evidenceId: evidence.id, authority: "user_reported", outcome: "rolled_back",
      sourceVersion: "content-v1", checks: [], reportDigest: null, recordedBy: setup!.admin.id
    });
    expect(await projection()).toHaveLength(1);
    await store.recordExperienceOutcome({
      id: randomUUID(), workspaceId: setup!.workspace.id, patternGroupId,
      evidenceId: evidence.id, authority: "signed_ci", outcome: "failed",
      sourceVersion: "content-v1", checks: [], reportDigest: null, recordedBy: setup!.admin.id
    });
    expect(await projection()).toHaveLength(0);
  });
});

describe("PostgresAppStore frontend experience", () => {
  test("loads candidate details only through live ACL-filtered evidence", async () => {
    const query = vi.fn(async (sqlText: string) => {
      if (sqlText.includes("FROM workspace_pattern_groups pattern")) return { rows: [{
        experience_id: "group-1", capability: "forms", state: "recommended",
        superseded_by_id: null, evidence_id: "evidence-1", project_id: "prior-project",
        release_id: "release-1", source_eligibility: "git", title: "Visible form",
        observed_fact: "Visible cited fact", content_version: "content-v1", citations: [],
        release_published_at: new Date(), fresh: true
      }] };
      return { rows: [] };
    });
    const store = new PostgresAppStore({ query } as never);

    const candidates = await store.listVisibleExperienceCandidates({
      workspaceId: "workspace-1", userId: "user-1", currentProjectId: "current-project"
    });

    expect(candidates).toEqual([expect.objectContaining({
      experienceId: "group-1",
      evidence: [expect.objectContaining({ title: "Visible form", fresh: true })]
    })]);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("JOIN workspace_members");
    expect(sql).toContain("LEFT JOIN project_members");
    expect(sql).toContain("evidence.project_id <> $3");
    expect(sql).toContain("evidence.revoked_at IS NULL");
    expect(sql).toContain("release.published_at IS NOT NULL");
  });

  test("builds projections only from live per-user project ACL joins", async () => {
    const query = vi.fn(async (sqlText: string, values?: unknown[]) => {
      void sqlText;
      void values;
      return { rows: [{
        experience_id: "group-1", capability: "forms", state: "verified",
        title: "Visible form pattern", observed_facts: ["Visible fact"], evidence_count: "1"
      }] };
    });
    const store = new PostgresAppStore({ query } as never);

    await expect(store.listExperienceProjection({
      workspaceId: "workspace-1", userId: "user-1", currentProjectId: "project-1", query: "form"
    })).resolves.toEqual([{
      experienceId: "group-1", capability: "forms", state: "verified",
      title: "Visible form pattern", observedFacts: ["Visible fact"], evidenceCount: 1
    }]);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("JOIN workspace_members");
    expect(sql).toContain("LEFT JOIN project_members");
    expect(sql).toContain("evidence.project_id <> $3");
    expect(sql).toContain("evidence.revoked_at IS NULL");
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("workspace_outcomes");
  });
});
