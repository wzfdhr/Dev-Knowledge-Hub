import { describe, expect, test, vi } from "vitest";

import { MemoryAppStore } from "./memory-store";

describe("frontend rollout persistence", () => {
  test("rejects a project administrator who is not a workspace administrator", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const project = (await store.listProjects(setup!.workspace.id))[0]!;
    const member = await store.createTeamMember(
      setup!.workspace.id,
      { email: "project-admin@example.com", passwordHash: "hash", role: "member" },
      setup!.admin.id
    );
    await store.addProjectMember(
      setup!.workspace.id, project.id, member!.id, "admin", setup!.admin.id
    );

    await expect(store.setProjectFrontendRollout({
      workspaceId: setup!.workspace.id,
      projectId: project.id,
      mode: "shadow",
      reason: "Project role must not grant rollout control",
      actorId: member!.id
    })).resolves.toBeNull();
    await expect(store.getProjectFrontendRollout(setup!.workspace.id, project.id)).resolves.toBeNull();
  });

  test("rolls back the override when its audit event cannot be written", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const project = (await store.listProjects(setup!.workspace.id))[0]!;
    vi.spyOn(store, "recordAudit").mockRejectedValueOnce(new Error("audit unavailable"));

    await expect(store.setProjectFrontendRollout({
      workspaceId: setup!.workspace.id,
      projectId: project.id,
      mode: "shadow",
      reason: "Run a controlled shadow comparison",
      actorId: setup!.admin.id
    })).rejects.toThrow("audit unavailable");
    await expect(store.getProjectFrontendRollout(setup!.workspace.id, project.id)).resolves.toBeNull();
  });
});
