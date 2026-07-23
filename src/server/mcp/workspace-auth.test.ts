import { describe, expect, test } from "vitest";

import { MemoryAppStore } from "../persistence/memory-store";
import {
  authenticateWorkspaceMcpTokenDetailed,
  hashWorkspaceMcpToken
} from "./workspace-auth";

describe("workspace MCP authentication", () => {
  test("binds tokens to the owner session and a maximum thirty-day expiry", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const plaintext = "dkhw_test-token";
    const token = await store.createWorkspaceMcpTokenWithAudit({
      workspaceId: setup!.workspace.id, userId: setup!.admin.id, name: "Codex workspace",
      tokenHash: hashWorkspaceMcpToken(plaintext), tokenPrefix: plaintext.slice(0, 12),
      scopes: ["workspace.patterns.read", "workspace.solutions.read"],
      sessionVersion: setup!.admin.sessionVersion
    }, setup!.admin.id);

    await expect(authenticateWorkspaceMcpTokenDetailed(store, plaintext))
      .resolves.toMatchObject({ token: { id: token.id }, failure: null });
    await expect(authenticateWorkspaceMcpTokenDetailed(store, plaintext, token.expiresAt))
      .resolves.toEqual({ token: null, failure: "WORKSPACE_TOKEN_EXPIRED" });
    await expect(store.createWorkspaceMcpTokenWithAudit({
      workspaceId: setup!.workspace.id, userId: setup!.admin.id, name: "Too long",
      tokenHash: "other", tokenPrefix: "dkhw_other", scopes: ["workspace.patterns.read"],
      sessionVersion: setup!.admin.sessionVersion,
      expiresAt: new Date(Date.now() + 31 * 24 * 60 * 60 * 1_000)
    }, setup!.admin.id)).rejects.toThrow("owner or expiry");
  });

  test("invalidates the token immediately when its owner session changes", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const member = await store.createTeamMember(setup!.workspace.id, {
      email: "member@example.com", passwordHash: "hash", role: "member"
    }, setup!.admin.id);
    const plaintext = "dkhw_member-token";
    await store.createWorkspaceMcpTokenWithAudit({
      workspaceId: setup!.workspace.id, userId: member!.id, name: "Member Codex",
      tokenHash: hashWorkspaceMcpToken(plaintext), tokenPrefix: plaintext.slice(0, 12),
      scopes: ["workspace.patterns.read"], sessionVersion: member!.sessionVersion
    }, member!.id);
    await store.resetTeamMemberPassword(setup!.workspace.id, member!.id, "new-hash", setup!.admin.id);

    await expect(authenticateWorkspaceMcpTokenDetailed(store, plaintext))
      .resolves.toEqual({ token: null, failure: "WORKSPACE_SESSION_CHANGED" });
  });

  test("allows only the owner to list, revoke, or rotate a workspace token", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const member = await store.createTeamMember(setup!.workspace.id, {
      email: "member@example.com", passwordHash: "hash", role: "member"
    }, setup!.admin.id);
    const token = await store.createWorkspaceMcpTokenWithAudit({
      workspaceId: setup!.workspace.id, userId: member!.id, name: "Member Codex",
      tokenHash: "hash-1", tokenPrefix: "dkhw_one", scopes: ["workspace.patterns.read"],
      sessionVersion: member!.sessionVersion
    }, member!.id);

    expect(await store.listWorkspaceMcpTokens(setup!.workspace.id, setup!.admin.id)).toEqual([]);
    await expect(store.revokeWorkspaceMcpTokenWithAudit(
      setup!.workspace.id, member!.id, token.id, setup!.admin.id
    )).resolves.toBeNull();
    await expect(store.rotateWorkspaceMcpTokenWithAudit(
      setup!.workspace.id, member!.id, token.id,
      { tokenHash: "hash-2", tokenPrefix: "dkhw_two" }, member!.id
    )).resolves.toMatchObject({ previous: { revokedAt: expect.any(Date) }, replacement: { userId: member!.id } });
  });
});
