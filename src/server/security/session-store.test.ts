import { describe, expect, test } from "vitest";

import { MemorySessionStore, PostgresSessionStore } from "./session-store";

describe("session stores", () => {
  test("returns an active session with its workspace and rejects expiry or revocation", async () => {
    const store = new MemorySessionStore();
    const now = new Date("2026-07-14T00:00:00.000Z");
    await store.create({
      idHash: "a".repeat(64),
      userId: "admin-1",
      workspaceId: "workspace-1",
      csrfSecretHash: "b".repeat(64),
      sessionVersion: 1,
      expiresAt: new Date(now.getTime() + 60_000),
      revokedAt: null
    });

    await expect(store.findActive("a".repeat(64), now)).resolves.toMatchObject({
      userId: "admin-1",
      workspaceId: "workspace-1"
    });
    await store.revoke("a".repeat(64), now);
    await expect(store.findActive("a".repeat(64), now)).resolves.toBeNull();
  });

  test("persists the workspace binding with an opaque session record", async () => {
    const query = async (sql: string, values: unknown[]) => {
      expect(sql).toContain("workspace_id");
      expect(values).toContain("workspace-1");
      return { rows: [] };
    };
    const store = new PostgresSessionStore({ query } as never);

    await store.create({
      idHash: "a".repeat(64),
      userId: "admin-1",
      workspaceId: "workspace-1",
      csrfSecretHash: "b".repeat(64),
      sessionVersion: 1,
      expiresAt: new Date("2026-07-14T01:00:00.000Z"),
      revokedAt: null
    });
  });
});
