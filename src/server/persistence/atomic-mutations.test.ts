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

class FailingRepositoryCredentialStore extends MemoryAppStore {
  protected async createRepositoryCredential(): Promise<void> {
    throw new Error("credential unavailable");
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

  test("archives the previous repository without changing its release history", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const original = await store.createRepository(setup!.workspace.id, {
      kind: "local",
      name: "Original",
      path: "/original"
    });
    store.releases.push({
      id: "release-original",
      workspaceId: setup!.workspace.id,
      repositoryId: original!.id,
      buildId: "build-original",
      snapshotId: "snapshot-original",
      version: "1.0.0",
      kernelMode: "legacy",
      packageArtifactId: null,
      createdAt: new Date("2026-07-11T00:00:00.000Z"),
      publishedAt: new Date("2026-07-11T00:01:00.000Z")
    });

    const replacement = await store.switchRepositoryWithAudit(setup!.workspace.id, {
      kind: "git",
      name: "Replacement",
      url: "https://example.com/replacement.git",
      encryptedToken: "encrypted-token"
    }, setup!.admin.id);

    await expect(store.currentRepository(setup!.workspace.id)).resolves.toEqual(replacement);
    await expect(store.listArchivedRepositories(setup!.workspace.id)).resolves.toEqual([
      expect.objectContaining({ id: original!.id, archivedAt: expect.any(Date) })
    ]);
    expect(store.releases).toContainEqual(expect.objectContaining({
      id: "release-original",
      repositoryId: original!.id
    }));
    expect(store.auditEvents).toContainEqual(expect.objectContaining({
      action: "repository.switched",
      metadata: { oldRepositoryId: original!.id, newRepositoryId: replacement!.id }
    }));
  });

  test("rolls back a replacement when encrypted credential creation fails", async () => {
    const store = new FailingRepositoryCredentialStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const original = await store.createRepository(setup!.workspace.id, {
      kind: "local",
      name: "Original",
      path: "/original"
    });

    await expect(store.switchRepositoryWithAudit(setup!.workspace.id, {
      kind: "git",
      name: "Replacement",
      url: "https://example.com/replacement.git",
      encryptedToken: "encrypted-token"
    }, setup!.admin.id)).rejects.toThrow("credential unavailable");

    await expect(store.currentRepository(setup!.workspace.id)).resolves.toEqual(original);
    await expect(store.listArchivedRepositories(setup!.workspace.id)).resolves.toEqual([]);
    expect(store.encryptedCredentials).toEqual([]);
    expect(store.auditEvents.filter((event) => event.action === "repository.switched")).toEqual([]);
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

describe("repository build claims", () => {
  test("serializes different feedback builds until the active build is terminal", async () => {
    const store = new MemoryAppStore();
    const base = {
      workspaceId: "workspace-1",
      repositoryId: "repository-1",
      snapshotId: "snapshot-1",
      snapshotPath: "/tmp/snapshot-1",
      commitSha: "a".repeat(40)
    };
    const first = (await store.createBuild({
      ...base,
      purpose: { kind: "feedback", feedbackIds: ["feedback-1"], feedbackContext: [] }
    })).build;
    const second = (await store.createBuild({
      ...base,
      purpose: { kind: "feedback", feedbackIds: ["feedback-2"], feedbackContext: [] }
    })).build;

    const claims = await Promise.all([store.claimBuild(first.id), store.claimBuild(second.id)]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    const active = claims.find(Boolean)!;
    const queued = active.id === first.id ? second : first;
    expect(queued.status).toBe("queued");

    await store.transitionBuild(active.id, "syncing", "failed");
    await expect(store.claimBuild(queued.id)).resolves.toMatchObject({
      id: queued.id,
      status: "syncing"
    });
  });
});
