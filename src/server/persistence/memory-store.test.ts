import { describe, expect, test } from "vitest";

import { MemoryAppStore } from "./memory-store";

describe("MemoryAppStore project members", () => {
  test("requires explicit project membership while preserving workspace administrator access", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const project = (await store.listProjects(setup!.workspace.id))[0];
    const reader = await store.createTeamMember(setup!.workspace.id, {
      email: "reader@example.com", passwordHash: "hash", role: "reader"
    }, setup!.admin.id);

    expect(await store.projectAccess(setup!.workspace.id, project.id, reader!.id)).toBeNull();
    expect(await store.projectAccess(setup!.workspace.id, project.id, setup!.admin.id))
      .toMatchObject({ role: "admin" });

    const membership = await store.addProjectMember(
      setup!.workspace.id, project.id, reader!.id, "reader", setup!.admin.id
    );
    expect(membership).toMatchObject({ email: "reader@example.com", role: "reader" });
    expect(await store.projectAccess(setup!.workspace.id, project.id, reader!.id))
      .toMatchObject({ role: "reader" });
  });

  test("does not allow the last project administrator to be removed or downgraded", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const project = (await store.listProjects(setup!.workspace.id))[0];

    await expect(store.updateProjectMemberRole(
      setup!.workspace.id, project.id, setup!.admin.id, "member", setup!.admin.id
    )).rejects.toThrow("A project must retain at least one administrator");
    await expect(store.removeProjectMember(
      setup!.workspace.id, project.id, setup!.admin.id, setup!.admin.id
    )).rejects.toThrow("A project must retain at least one administrator");
  });

  test("removes only failed or cancelled import reports older than the retention cutoff", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const project = (await store.listProjects(setup!.workspace.id))[0];
    const repository = await store.createRepositoryWithAudit(
      setup!.workspace.id, { kind: "upload", name: "Source" }, setup!.admin.id, project.id
    );
    const create = () => store.createImportReport({
      workspaceId: setup!.workspace.id,
      projectId: project.id,
      repositoryId: repository!.id,
      actorId: setup!.admin.id,
      sourceKind: "upload"
    });
    const failed = await create();
    const cancelled = await create();
    const succeeded = await create();
    await store.finishImportReport(setup!.workspace.id, failed.id, {
      status: "failed", collectedFileCount: 0, collectedTextBytes: 0,
      ignored: { total: 0, reasons: {} }, snapshotId: null, failureCode: "UPLOAD_FAILED"
    });
    await store.finishImportReport(setup!.workspace.id, cancelled.id, {
      status: "cancelled", collectedFileCount: 0, collectedTextBytes: 0,
      ignored: { total: 0, reasons: {} }, snapshotId: null, failureCode: "CANCELLED"
    });
    await store.finishImportReport(setup!.workspace.id, succeeded.id, {
      status: "succeeded", collectedFileCount: 1, collectedTextBytes: 4,
      ignored: { total: 0, reasons: {} }, snapshotId: "snapshot", failureCode: null
    });
    for (const report of store.importReports) report.finishedAt = new Date("2026-01-01T00:00:00.000Z");

    const deleted = await (store as unknown as {
      deleteExpiredImportReports(cutoff: Date): Promise<number>;
    }).deleteExpiredImportReports(new Date("2026-04-01T00:00:00.000Z"));

    expect(deleted).toBe(2);
    expect(store.importReports.map((report) => report.id)).toEqual([succeeded.id]);
  });

  test("summarizes added, modified, and deleted files against the preceding snapshot", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const repository = await store.createRepository(setup!.workspace.id, { kind: "upload", name: "Source" });
    const create = async (id: string, files: Array<[string, string]>) => store.createSnapshot({
      snapshot: { id, workspaceId: setup!.workspace.id, repositoryId: repository!.id, commitSha: id.padEnd(40, "0"), ref: id, remoteUrl: null, commitTimestamp: new Date(id === "first" ? "2026-01-01" : "2026-01-02"), storagePath: `/tmp/${id}` },
      files: files.map(([path, content], index) => ({ id: `${id}-${index}`, workspaceId: setup!.workspace.id, snapshotId: id, path, byteSize: content.length, contentHash: content, language: "typescript" }))
    });
    await create("first", [["src/kept.ts", "one"], ["src/deleted.ts", "old"]]);
    await create("second", [["src/kept.ts", "two"], ["src/added.ts", "new"]]);

    const summary = await (store as unknown as { snapshotChangeSummary(workspaceId: string, repositoryId: string, snapshotId: string): Promise<unknown> }).snapshotChangeSummary(setup!.workspace.id, repository!.id, "second");

    expect(summary).toMatchObject({ added: ["src/added.ts"], modified: ["src/kept.ts"], deleted: ["src/deleted.ts"], requiresBuild: true });
  });

  test("rotates an MCP token atomically and records an audit event without plaintext", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const project = (await store.listProjects(setup!.workspace.id))[0];
    const previous = await store.createMcpToken({
      workspaceId: setup!.workspace.id,
      projectId: project.id,
      name: "Codex",
      tokenHash: "old-hash",
      tokenPrefix: "dkh_old"
    });
    const rotate = store as unknown as {
      rotateMcpTokenWithAudit(
        workspaceId: string,
        tokenId: string,
        replacement: { tokenHash: string; tokenPrefix: string },
        actorId: string
      ): Promise<{ previous: typeof previous; replacement: typeof previous } | null>;
    };

    const rotation = await rotate.rotateMcpTokenWithAudit(
      setup!.workspace.id, previous.id, { tokenHash: "new-hash", tokenPrefix: "dkh_new" }, setup!.admin.id
    );

    expect(rotation).toMatchObject({
      previous: { id: previous.id, revokedAt: expect.any(Date) },
      replacement: { projectId: project.id, name: "Codex", tokenHash: "new-hash", tokenPrefix: "dkh_new", revokedAt: null }
    });
    const activity = await store.listProjectActivity(setup!.workspace.id, project.id);
    expect(activity.find((event) => event.action === "mcp_token.rotated")).toMatchObject({
      resourceId: previous.id,
      metadata: { replacementTokenId: rotation!.replacement.id }
    });
  });
});
