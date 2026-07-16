import { describe, expect, test } from "vitest";

import type { LintIssue } from "../../shared/api-contracts.js";
import { MemoryAppStore } from "./memory-store.js";

function issue(buildId: string): LintIssue {
  return {
    id: "lint-coverage",
    buildId,
    rule: "KNOWLEDGE_LOW_COVERAGE",
    severity: "warning",
    targetKind: "knowledge",
    targetId: "knowledge-overview",
    message: "Knowledge coverage is low",
    sourceRefs: [],
    remediationState: "open"
  };
}

describe("remediation persistence", () => {
  test("keeps remediation cases within their workspace", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const project = (await store.listProjects(setup!.workspace.id))[0];
    const repository = await store.createRepository(
      setup!.workspace.id, { kind: "upload", name: "Source" }, project.id
    );
    const sourceBuild = await store.createBuild({
      workspaceId: setup!.workspace.id, repositoryId: repository!.id, snapshotId: "source-snapshot",
      snapshotPath: "/tmp/source-snapshot", commitSha: "a".repeat(40)
    });

    const remediation = await store.createRemediation({
      workspaceId: setup!.workspace.id,
      projectId: project.id,
      repositoryId: repository!.id,
      sourceBuildId: sourceBuild.build.id,
      issue: issue(sourceBuild.build.id)
    });

    await expect(store.getRemediation("other-workspace", remediation.id)).resolves.toBeNull();
    await expect(store.listRemediations("other-workspace", project.id)).resolves.toEqual([]);
    await expect(store.getRemediation(setup!.workspace.id, remediation.id)).resolves.toMatchObject({
      id: remediation.id,
      state: "open",
      projectId: project.id
    });

    const replay = await store.createRemediation({
      workspaceId: setup!.workspace.id,
      projectId: project.id,
      repositoryId: repository!.id,
      sourceBuildId: sourceBuild.build.id,
      issue: issue(sourceBuild.build.id)
    });
    expect(replay.id).toBe(remediation.id);
    await expect(store.listRemediations(setup!.workspace.id, project.id)).resolves.toHaveLength(1);

    await expect(store.transitionRemediationWithAudit(
      setup!.workspace.id, remediation.id, "dismissed", setup!.admin.id
    )).rejects.toThrow("Dismissal reason is required");
    const dismissed = await store.transitionRemediationWithAudit(
      setup!.workspace.id, remediation.id, "dismissed", setup!.admin.id, "The warning duplicates an accepted policy exception"
    );
    const repeatedDismissal = await store.transitionRemediationWithAudit(
      setup!.workspace.id, remediation.id, "dismissed", setup!.admin.id, "The warning duplicates an accepted policy exception"
    );
    expect(repeatedDismissal).toEqual(dismissed);
    await expect(store.listRemediationEvents(setup!.workspace.id, remediation.id)).resolves.toEqual([
      expect.objectContaining({ toState: "dismissed", reason: "The warning duplicates an accepted policy exception" })
    ]);
    expect(store.auditEvents.filter((event) => event.resourceId === remediation.id)).toHaveLength(1);
  });

  test("starts an accepted case as an auditable remediation build without publishing", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const project = (await store.listProjects(setup!.workspace.id))[0];
    const repository = await store.createRepository(
      setup!.workspace.id, { kind: "upload", name: "Source" }, project.id
    );
    const sourceBuild = await store.createBuild({
      workspaceId: setup!.workspace.id, repositoryId: repository!.id, snapshotId: "source-snapshot",
      snapshotPath: "/tmp/source-snapshot", commitSha: "a".repeat(40)
    });
    const remediation = await store.createRemediation({
      workspaceId: setup!.workspace.id,
      projectId: project.id,
      repositoryId: repository!.id,
      sourceBuildId: sourceBuild.build.id,
      issue: issue(sourceBuild.build.id)
    });
    await store.transitionRemediationWithAudit(
      setup!.workspace.id, remediation.id, "accepted", setup!.admin.id
    );

    const result = await store.requestRemediationBuildWithAudit({
      workspaceId: setup!.workspace.id,
      remediationId: remediation.id,
      actorId: setup!.admin.id,
      build: {
        workspaceId: setup!.workspace.id,
        repositoryId: repository!.id,
        snapshotId: "snapshot-1",
        snapshotPath: "/tmp/snapshot-1",
        commitSha: "a".repeat(40)
      }
    });

    expect(result.build.purpose).toEqual({
      kind: "remediation",
      feedbackIds: [],
      feedbackContext: [],
      remediationContext: [expect.objectContaining({
        remediationId: remediation.id,
        issueId: "lint-coverage",
        sourceRefs: []
      })]
    });
    await expect(store.getRemediation(setup!.workspace.id, remediation.id)).resolves.toMatchObject({
      state: "rebuilding",
      rebuildBuildId: result.build.id
    });
    await expect(store.listRemediationEvents(setup!.workspace.id, remediation.id)).resolves.toEqual([
      expect.objectContaining({ fromState: "open", toState: "accepted" }),
      expect.objectContaining({ fromState: "accepted", toState: "rebuilding" })
    ]);
    expect(store.releases).toEqual([]);
    expect(store.auditEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "remediation.transitioned", resourceId: remediation.id }),
      expect.objectContaining({ action: "remediation.rebuild_requested", resourceId: remediation.id })
    ]));
  });
});
