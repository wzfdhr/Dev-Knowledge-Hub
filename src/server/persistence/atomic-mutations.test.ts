import { describe, expect, test } from "vitest";

import { buildServer } from "../app";
import { MemoryAppStore } from "./memory-store";
import type { AuditEventInput, CreateSnapshotInput } from "./store";

class FailingAuditStore extends MemoryAppStore {
  failedAction: string | null = null;

  override async recordAudit(event: AuditEventInput): Promise<void> {
    await super.recordAudit(event);
    if (event.action === this.failedAction) throw new Error("audit unavailable");
  }
}

describe("core mutation audit atomicity", () => {
  test("rolls back initial setup when its audit insert fails", async () => {
    const store = new FailingAuditStore();
    store.failedAction = "setup.completed";

    await expect(store.createInitialSetup("admin@example.com", "hash"))
      .rejects.toThrow("audit unavailable");

    await expect(store.isSetupComplete()).resolves.toBe(false);
    await expect(store.defaultWorkspace()).resolves.toBeNull();
    expect(store.auditEvents).toEqual([]);
  });

  test("rolls back repository metadata and credentials when its audit insert fails", async () => {
    const store = new FailingAuditStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    store.failedAction = "repository.connected";

    await expect(store.createRepositoryWithAudit(setup!.workspace.id, {
      kind: "git",
      name: "Private",
      url: "https://example.com/private.git",
      encryptedToken: "encrypted-token"
    }, setup!.admin.id)).rejects.toThrow("audit unavailable");

    await expect(store.currentRepository(setup!.workspace.id)).resolves.toBeNull();
    expect(store.encryptedCredentials).toEqual([]);
    expect(store.auditEvents.filter((event) => event.action === "repository.connected"))
      .toEqual([]);
  });

  test("rolls back a snapshot and its files when the sync audit insert fails", async () => {
    const store = new FailingAuditStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const repository = await store.createRepository(setup!.workspace.id, {
      kind: "local",
      name: "Fixture",
      path: "/fixture"
    });
    const input: CreateSnapshotInput = {
      snapshot: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        workspaceId: setup!.workspace.id,
        repositoryId: repository!.id,
        commitSha: "a".repeat(40),
        ref: "main",
        remoteUrl: null,
        commitTimestamp: new Date("2026-07-11T00:00:00Z"),
        storagePath: "/data/snapshot/files"
      },
      files: [{
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        workspaceId: setup!.workspace.id,
        snapshotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        path: "src/index.ts",
        byteSize: 12,
        contentHash: "b".repeat(64),
        language: "typescript"
      }]
    };
    store.failedAction = "repository.sync_succeeded";

    await expect(store.createSnapshotWithAudit(input, setup!.admin.id))
      .rejects.toThrow("audit unavailable");

    expect(store.sourceSnapshots).toEqual([]);
    expect(store.sourceFiles).toEqual([]);
    expect(store.auditEvents.filter((event) => event.action === "repository.sync_succeeded"))
      .toEqual([]);
  });
});

describe("login auditing", () => {
  test("keeps successful and failed login outcomes independent from audit availability", async () => {
    const store = new FailingAuditStore();
    const app = buildServer({
      store,
      masterKey: Buffer.alloc(32, 4).toString("base64"),
      sessionSecret: "atomic-login-session-secret",
      dataDir: "/tmp/devkh-atomic-login",
      nodeEnv: "test"
    });
    await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });

    store.failedAction = "session.login_succeeded";
    const successful = await app.inject({
      method: "POST",
      url: "/api/session",
      payload: { email: "admin@example.com", password: "correct horse battery staple" }
    });
    expect(successful.statusCode).toBe(200);
    expect(successful.json()).toMatchObject({ authenticated: true });

    store.failedAction = "session.login_failed";
    const failed = await app.inject({
      method: "POST",
      url: "/api/session",
      payload: { email: "admin@example.com", password: "wrong password" }
    });
    expect(failed.statusCode).toBe(401);
    expect(failed.json().error.code).toBe("INVALID_CREDENTIALS");
    await app.close();
  });
});
