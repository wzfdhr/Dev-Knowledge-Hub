import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { MemoryAppStore } from "../persistence/memory-store.js";
import type { AuditEventInput, CompleteUploadSessionInput } from "../persistence/store.js";
import {
  UploadSessionError,
  UploadSessionService,
  canonicalUploadManifestDigest
} from "./upload-session.js";
import { importFolderFiles, PENDING_UPLOAD_SNAPSHOT_MARKER } from "./folder-import.js";
import { MAX_UPLOAD_MANIFEST_METADATA_BYTES } from "../../shared/import-filter.js";

const temporaryDirectories: string[] = [];

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writable(directory: string): Promise<void> {
  await chmod(directory, 0o700).catch(() => undefined);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => writable(path.join(directory, entry.name))));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.map(writable));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class FailingSwitchAuditStore extends MemoryAppStore {
  failSwitch = false;

  override async recordAudit(event: AuditEventInput): Promise<void> {
    await super.recordAudit(event);
    if (this.failSwitch && event.action === "repository.switched") throw new Error("switch audit unavailable");
  }
}

class RevokingCompletionStore extends MemoryAppStore {
  revoke: { workspaceId: string; projectId: string; userId: string; actorId: string } | null = null;

  override async completeUploadSessionCommit(input: CompleteUploadSessionInput) {
    if (this.revoke) {
      const { workspaceId, projectId, userId, actorId } = this.revoke;
      this.revoke = null;
      await this.removeProjectMember(workspaceId, projectId, userId, actorId);
    }
    return super.completeUploadSessionCommit(input);
  }
}

class ExpiringCompletionStore extends MemoryAppStore {
  override async completeUploadSessionCommit(input: CompleteUploadSessionInput) {
    const session = this.uploadSessions.find((candidate) => candidate.id === input.sessionId);
    if (session) session.expiresAt = new Date(0);
    return super.completeUploadSessionCommit(input);
  }
}

async function fixture(
  now = new Date("2026-07-19T00:00:00.000Z"),
  store: MemoryAppStore = new MemoryAppStore()
) {
  const setup = await store.createInitialSetup("admin@example.com", "hash");
  const project = (await store.listProjects(setup!.workspace.id))[0]!;
  const repository = await store.createRepository(
    setup!.workspace.id,
    { kind: "upload", name: "Folder" },
    project.id
  );
  if (!repository) throw new Error("Upload repository fixture was not created");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devkh-upload-session-"));
  temporaryDirectories.push(dataDir);
  const service = new UploadSessionService({ store, dataDir, now: () => now });
  return { store, setup: setup!, project, repository, dataDir, service };
}

function source(ordinal: number, filePath: string, content: string) {
  return {
    ordinal,
    path: filePath,
    kind: "source" as const,
    byteSize: Buffer.byteLength(content),
    contentHash: hash(content),
    mediaType: "text/typescript"
  };
}

describe("durable upload sessions", () => {
  test("creates one actor-bound 24 hour session and replays the same idempotency key", async () => {
    const context = await fixture();
    const input = {
      workspaceId: context.setup.workspace.id,
      projectId: context.project.id,
      repositoryId: context.repository.id,
      actorId: context.setup.admin.id,
      sessionVersion: context.setup.admin.sessionVersion,
      entryCount: 2,
      idempotencyKey: "create-1"
    };

    const first = await context.service.createSession(input);
    const replay = await context.service.createSession(input);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({ status: "open", entryCount: 2 });
    expect(new Date(first.expiresAt).toISOString()).toBe("2026-07-20T00:00:00.000Z");
    expect(await context.store.getUploadSession(context.setup.workspace.id, first.id)).toMatchObject({
      actorId: context.setup.admin.id,
      projectId: context.project.id,
      sessionVersion: 1
    });
    const rotated = await context.store.resetTeamMemberPassword(
      context.setup.workspace.id, context.setup.admin.id, "rotated", context.setup.admin.id
    );
    await expect(context.service.createSession({ ...input, sessionVersion: rotated!.sessionVersion }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", statusCode: 409 });
  });

  test("accepts out-of-order manifest pages and classifies source, asset, and excluded entries", async () => {
    const context = await fixture();
    const session = await context.service.createSession({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id,
      sessionVersion: 1, entryCount: 501, idempotencyKey: "create"
    });
    const identity = { workspaceId: context.setup.workspace.id, projectId: context.project.id, actorId: context.setup.admin.id, sessionVersion: 1 };

    const listEntries = vi.spyOn(context.store, "listUploadManifestEntries");
    const laterPage = await context.service.putManifestPage({
      ...identity, sessionId: session.id, page: 1, idempotencyKey: "page-1",
      entries: [
        { ordinal: 500, path: "assets/logo.png", kind: "asset", byteSize: 128, contentHash: null, mediaType: "image/png" }
      ]
    });
    const page = await context.service.putManifestPage({
      ...identity, sessionId: session.id, page: 0, idempotencyKey: "page-0",
      entries: [
        source(2, "node_modules/pkg/index.ts", "ignored"),
        source(1, "src/secondary.ts", "export {};\n"),
        source(0, "src/index.ts", "export const value = 1;\n")
      ]
    });

    expect(laterPage.entries).toEqual([
      expect.objectContaining({ ordinal: 500, disposition: "metadata_only", trust: "client_unverified" })
    ]);
    expect(page.entries).toEqual([
      expect.objectContaining({ ordinal: 0, disposition: "upload_required", trust: "pending" }),
      expect.objectContaining({ ordinal: 1, disposition: "upload_required", trust: "pending" }),
      expect.objectContaining({ ordinal: 2, disposition: "ignored", ignoreReason: "excluded_directory" })
    ]);
    expect(listEntries).not.toHaveBeenCalled();
    await expect(context.service.putManifestPage({
      ...identity, sessionId: session.id, page: 1, idempotencyKey: "too-many",
      entries: Array.from({ length: 501 }, (_, ordinal) => source(500 + ordinal, `src/${ordinal}.ts`, "x"))
    })).rejects.toMatchObject({ code: "MANIFEST_PAGE_LIMIT" });
  });

  test("accepts and commits exactly 100,000 manifest entries across 200 pages", async () => {
    const context = await fixture();
    const identity = {
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id, sessionVersion: 1
    };
    const sourceText = "export const boundary = true;\n";
    const entries = Array.from({ length: 100_000 }, (_, ordinal) => ordinal === 0
      ? source(ordinal, "src/index.ts", sourceText)
      : {
          ordinal, path: `assets/${ordinal}.png`, kind: "asset" as const,
          byteSize: 0, contentHash: null, mediaType: "image/png"
        });
    const session = await context.service.createSession({
      ...identity, entryCount: entries.length, idempotencyKey: "manifest-limit-create"
    });
    for (let page = 0; page < 200; page += 1) {
      await context.service.putManifestPage({
        ...identity, sessionId: session.id, page,
        entries: entries.slice(page * 500, (page + 1) * 500),
        idempotencyKey: `manifest-limit-page-${page}`
      });
    }
    await context.service.putFile({
      ...identity, sessionId: session.id, ordinal: 0,
      bytes: Buffer.from(sourceText), idempotencyKey: "manifest-limit-file"
    });

    await expect(context.service.commit({
      ...identity, sessionId: session.id,
      manifestDigest: canonicalUploadManifestDigest(entries), idempotencyKey: "manifest-limit-commit"
    })).resolves.toMatchObject({ fileCount: 1, assetCount: 99_999 });
    await expect(context.service.createSession({
      ...identity, entryCount: 100_001, idempotencyKey: "manifest-over-limit"
    })).rejects.toMatchObject({ code: "INVALID_UPLOAD_MANIFEST" });
  }, 30_000);

  test("accepts exactly 50,000 source decisions and rejects the 50,001st", async () => {
    const context = await fixture();
    const identity = {
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id, sessionVersion: 1
    };
    const session = await context.service.createSession({
      ...identity, entryCount: 50_001, idempotencyKey: "source-limit-create"
    });
    for (let page = 0; page < 100; page += 1) {
      await context.service.putManifestPage({
        ...identity, sessionId: session.id, page,
        entries: Array.from({ length: 500 }, (_, index) => {
          const ordinal = page * 500 + index;
          return source(ordinal, `src/${ordinal}.ts`, "");
        }),
        idempotencyKey: `source-limit-page-${page}`
      });
    }
    expect(context.store.uploadManifestEntries).toHaveLength(50_000);

    await expect(context.service.putManifestPage({
      ...identity, sessionId: session.id, page: 100,
      entries: [source(50_000, "src/50000.ts", "")], idempotencyKey: "source-over-limit-page"
    })).rejects.toMatchObject({ code: "TOO_MANY_FILES", statusCode: 413 });
    expect(context.store.uploadManifestEntries).toHaveLength(50_000);
  }, 30_000);

  test("accepts exactly 2 GiB and rejects the next byte inside the manifest transaction", async () => {
    const context = await fixture();
    const session = await context.service.createSession({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id,
      sessionVersion: 1, entryCount: 42, idempotencyKey: "byte-budget-create"
    });
    const workbookBytes = 50 * 1024 * 1024;
    const entries = Array.from({ length: 41 }, (_, ordinal) => ({
      ordinal, path: `tables/${ordinal}.xlsx`, kind: "source" as const,
      byteSize: ordinal === 40 ? 48 * 1024 * 1024 : workbookBytes,
      contentHash: hash(String(ordinal)), mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }));

    await expect(context.service.putManifestPage({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      actorId: context.setup.admin.id, sessionVersion: 1,
      sessionId: session.id, page: 0, entries, idempotencyKey: "byte-budget-page"
    })).resolves.toMatchObject({ entries: expect.arrayContaining([expect.objectContaining({ ordinal: 40 })]) });
    expect(context.store.uploadManifestEntries.reduce((total, entry) => total + entry.byteSize, 0))
      .toBe(2 * 1024 * 1024 * 1024);

    await expect(context.service.putManifestPage({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      actorId: context.setup.admin.id, sessionVersion: 1,
      sessionId: session.id, page: 0,
      entries: [source(41, "src/extra.ts", "x")], idempotencyKey: "byte-budget-extra"
    })).rejects.toMatchObject({ code: "FOLDER_SIZE_LIMIT", statusCode: 413 });
    expect(context.store.uploadManifestEntries).toHaveLength(41);
  });

  test("rejects cumulative manifest metadata inside the page transaction", async () => {
    const context = await fixture();
    const session = await context.service.createSession({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id,
      sessionVersion: 1, entryCount: 1, idempotencyKey: "metadata-budget-create"
    });

    await expect(context.store.saveUploadManifestPage({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      sessionId: session.id, actorId: context.setup.admin.id, sessionVersion: 1
    }, [{
      ...source(0, "src/index.ts", "export {};"),
      metadataByteSize: MAX_UPLOAD_MANIFEST_METADATA_BYTES + 1,
      disposition: "upload_required",
      trust: "pending",
      ignoreReason: null
    }])).rejects.toThrow("MANIFEST_METADATA_LIMIT");
    expect(context.store.uploadManifestEntries).toHaveLength(0);
  });

  test("recomputes bytes and hash, verifies source content, and never accepts asset bytes", async () => {
    const context = await fixture();
    const sourceText = "export const value = 1;\n";
    const session = await context.service.createSession({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id,
      sessionVersion: 1, entryCount: 2, idempotencyKey: "create"
    });
    const identity = { workspaceId: context.setup.workspace.id, projectId: context.project.id, actorId: context.setup.admin.id, sessionVersion: 1 };
    await context.service.putManifestPage({
      ...identity, sessionId: session.id, page: 0, idempotencyKey: "page",
      entries: [
        source(0, "src/index.ts", sourceText),
        { ordinal: 1, path: "assets/logo.png", kind: "asset", byteSize: 5, contentHash: null, mediaType: "image/png" }
      ]
    });

    await expect(context.service.putFile({
      ...identity, sessionId: session.id, ordinal: 0, idempotencyKey: "bad-file", bytes: Buffer.from("wrong")
    })).rejects.toMatchObject({ code: "UPLOAD_HASH_MISMATCH" });
    await expect(context.service.putFile({
      ...identity, sessionId: session.id, ordinal: 1, idempotencyKey: "asset-file", bytes: Buffer.from("asset")
    })).rejects.toMatchObject({ code: "UPLOAD_NOT_REQUIRED" });

    const uploaded = await context.service.putFile({
      ...identity, sessionId: session.id, ordinal: 0, idempotencyKey: "file-0", bytes: Buffer.from(sourceText)
    });
    expect(uploaded).toMatchObject({ ordinal: 0, disposition: "upload_required", trust: "server_verified" });
  });

  test("uploads a source entry beyond the first manifest page", async () => {
    const context = await fixture();
    const content = "export const latePage = true;\n";
    const session = await context.service.createSession({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id,
      sessionVersion: 1, entryCount: 501, idempotencyKey: "late-page-create"
    });
    const identity = {
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      actorId: context.setup.admin.id, sessionVersion: 1
    };
    await context.service.putManifestPage({
      ...identity, sessionId: session.id, page: 1,
      entries: [source(500, "src/late.ts", content)], idempotencyKey: "late-page-manifest"
    });

    await expect(context.service.putFile({
      ...identity, sessionId: session.id, ordinal: 500,
      bytes: Buffer.from(content), idempotencyKey: "late-page-file"
    })).resolves.toMatchObject({ ordinal: 500, trust: "server_verified" });
  });

  test("serializes the same idempotency key across different sessions before side effects", async () => {
    const context = await fixture();
    const identity = {
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      actorId: context.setup.admin.id, sessionVersion: 1
    };
    const first = await context.service.createSession({
      ...identity, repositoryId: context.repository.id, entryCount: 1, idempotencyKey: "first-session"
    });
    const second = await context.service.createSession({
      ...identity, repositoryId: context.repository.id, entryCount: 1, idempotencyKey: "second-session"
    });
    const results = await Promise.allSettled([
      context.service.putManifestPage({
        ...identity, sessionId: first.id, page: 0,
        entries: [source(0, "src/first.ts", "export {};\n")], idempotencyKey: "shared-operation"
      }),
      context.service.putManifestPage({
        ...identity, sessionId: second.id, page: 0,
        entries: [source(0, "src/second.ts", "export {};\n")], idempotencyKey: "shared-operation"
      })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(context.store.uploadManifestEntries).toHaveLength(1);
  });

  test("rejects paths over 4096 UTF-8 bytes before persistence", async () => {
    const context = await fixture();
    const session = await context.service.createSession({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id,
      sessionVersion: 1, entryCount: 1, idempotencyKey: "create-long-path"
    });
    await expect(context.service.putManifestPage({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      actorId: context.setup.admin.id, sessionVersion: 1,
      sessionId: session.id, page: 0, idempotencyKey: "long-path-page",
      entries: [source(0, `${"知".repeat(1_400)}.ts`, "export {};\n")]
    })).rejects.toMatchObject({ code: "INVALID_UPLOAD_MANIFEST", statusCode: 400 });
  });

  test("commits a complete manifest once and safely replays concurrent commit requests", async () => {
    const context = await fixture();
    const sourceText = "export const value = 1;\n";
    const entries = [source(0, "src/index.ts", sourceText)];
    const session = await context.service.createSession({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id,
      sessionVersion: 1, entryCount: 1, idempotencyKey: "create"
    });
    const identity = { workspaceId: context.setup.workspace.id, projectId: context.project.id, actorId: context.setup.admin.id, sessionVersion: 1 };
    await context.service.putManifestPage({ ...identity, sessionId: session.id, page: 0, entries, idempotencyKey: "page" });
    await context.service.putFile({
      ...identity, sessionId: session.id, ordinal: 0, bytes: Buffer.from(sourceText), idempotencyKey: "file"
    });
    const manifestDigest = canonicalUploadManifestDigest(entries);

    const [first, second] = await Promise.all([
      context.service.commit({ ...identity, sessionId: session.id, manifestDigest, idempotencyKey: "commit" }),
      context.service.commit({ ...identity, sessionId: session.id, manifestDigest, idempotencyKey: "commit" })
    ]);

    expect(second).toEqual(first);
    expect(first).toMatchObject({ fileCount: 1, unchanged: false, assetCount: 0 });
    const committedSnapshot = await context.store.findSnapshotById(context.setup.workspace.id, first.snapshotId);
    await expect(readdir(path.dirname(committedSnapshot!.storagePath)))
      .resolves.not.toContain(PENDING_UPLOAD_SNAPSHOT_MARKER);
    expect(await context.store.getUploadSession(context.setup.workspace.id, session.id)).toMatchObject({
      status: "committed", manifestDigest, snapshotId: first.snapshotId,
      commitResponse: expect.objectContaining({ unchanged: false })
    });
    context.store.uploadIdempotencyKeys.splice(
      0,
      context.store.uploadIdempotencyKeys.length,
      ...context.store.uploadIdempotencyKeys.filter((item) => item.idempotencyKey !== "commit")
    );
    await expect(context.service.commit({
      ...identity, sessionId: session.id, manifestDigest, idempotencyKey: "commit"
    })).resolves.toEqual(first);
    await expect(context.service.putManifestPage({
      ...identity, sessionId: session.id, page: 0, entries, idempotencyKey: "page"
    })).resolves.toMatchObject({ entries: [expect.objectContaining({ ordinal: 0 })] });
    await expect(context.service.putFile({
      ...identity, sessionId: session.id, ordinal: 0, bytes: Buffer.from(sourceText), idempotencyKey: "file"
    })).resolves.toMatchObject({ ordinal: 0, trust: "server_verified" });
    const committedStaging = path.join(context.dataDir, "uploads", "sessions", session.id, "import");
    await mkdir(committedStaging, { recursive: true });
    await context.service.cleanupExpired();
    await expect(readdir(path.dirname(committedStaging))).rejects.toThrow();

    const persisted = context.store.uploadSessions.find((candidate) => candidate.id === session.id)!;
    persisted.expiresAt = new Date("2026-07-18T00:00:00.000Z");
    await expect(context.service.cleanupExpired()).resolves.toBe(1);
    await expect(context.store.getUploadSession(context.setup.workspace.id, session.id)).resolves.toBeNull();
    await expect(context.store.findSnapshotById(context.setup.workspace.id, first.snapshotId))
      .resolves.toMatchObject({ id: first.snapshotId });
    await expect(context.store.listImportReports(context.setup.workspace.id, context.project.id))
      .resolves.toContainEqual(expect.objectContaining({ status: "succeeded", snapshotId: first.snapshotId }));
  });

  test("rejects incomplete or wrong manifests without changing the current release", async () => {
    const context = await fixture();
    const entry = source(0, "src/index.ts", "export {};\n");
    const session = await context.service.createSession({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id,
      sessionVersion: 1, entryCount: 1, idempotencyKey: "create"
    });
    const identity = { workspaceId: context.setup.workspace.id, projectId: context.project.id, actorId: context.setup.admin.id, sessionVersion: 1 };
    await context.service.putManifestPage({ ...identity, sessionId: session.id, page: 0, entries: [entry], idempotencyKey: "page" });

    await expect(context.service.commit({
      ...identity, sessionId: session.id, manifestDigest: hash("wrong"), idempotencyKey: "commit-wrong"
    })).rejects.toMatchObject({ code: "MANIFEST_DIGEST_MISMATCH" });
    await expect(context.service.commit({
      ...identity, sessionId: session.id, manifestDigest: canonicalUploadManifestDigest([entry]), idempotencyKey: "commit-incomplete"
    })).rejects.toMatchObject({ code: "UPLOAD_INCOMPLETE" });
  });

  test("rejects a manifest with no accepted source before entering committing", async () => {
    const context = await fixture();
    const identity = {
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id, sessionVersion: 1
    };
    const entry = {
      ordinal: 0, path: "assets/logo.png", kind: "asset" as const, byteSize: 12,
      contentHash: null, mediaType: "image/png"
    };
    const session = await context.service.createSession({
      ...identity, entryCount: 1, idempotencyKey: "asset-only-create"
    });
    await context.service.putManifestPage({
      ...identity, sessionId: session.id, page: 0, entries: [entry], idempotencyKey: "asset-only-page"
    });

    await expect(context.service.commit({
      ...identity, sessionId: session.id,
      manifestDigest: canonicalUploadManifestDigest([entry]), idempotencyKey: "asset-only-commit"
    })).rejects.toMatchObject({ code: "EMPTY_FOLDER_UPLOAD", statusCode: 400 });
    await expect(context.store.getUploadSession(identity.workspaceId, session.id))
      .resolves.toMatchObject({ status: "open" });
  });

  test("invalidates sessions after session rotation and expiry", async () => {
    const context = await fixture();
    const session = await context.service.createSession({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id,
      sessionVersion: 1, entryCount: 1, idempotencyKey: "create"
    });
    const entry = source(0, "src/index.ts", "export {};\n");

    const rotated = await context.store.resetTeamMemberPassword(
      context.setup.workspace.id, context.setup.admin.id, "new-hash", context.setup.admin.id
    );
    expect(rotated?.sessionVersion).toBe(2);
    await expect(context.service.putManifestPage({
      workspaceId: context.setup.workspace.id, projectId: context.project.id, actorId: context.setup.admin.id, sessionVersion: 2,
      sessionId: session.id, page: 0, entries: [entry], idempotencyKey: "page"
    })).rejects.toMatchObject({ code: "UPLOAD_SESSION_INVALIDATED" });

    const expiredContext = await fixture(new Date("2026-07-21T00:00:00.000Z"));
    const expired = await expiredContext.store.createUploadSession({
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId: expiredContext.setup.workspace.id,
      projectId: expiredContext.project.id,
      repositoryId: expiredContext.repository.id,
      actorId: expiredContext.setup.admin.id,
      sessionVersion: 1,
      isReplacement: false,
      expectedCurrentRepositoryId: expiredContext.repository.id,
      entryCount: 1,
      expiresAt: new Date("2026-07-20T00:00:00.000Z")
    });
    await expect(expiredContext.service.putManifestPage({
      workspaceId: expired.workspaceId, projectId: expired.projectId, actorId: expired.actorId, sessionVersion: 1,
      sessionId: expired.id, page: 0, entries: [entry], idempotencyKey: "expired-page"
    })).rejects.toMatchObject({ code: "UPLOAD_SESSION_EXPIRED" });
    await expect(expiredContext.service.cleanupExpired()).resolves.toBe(1);
    const orphanId = "22222222-2222-4222-8222-222222222222";
    const orphan = path.join(expiredContext.dataDir, "uploads", "sessions", orphanId);
    await mkdir(orphan, { recursive: true });
    await utimes(orphan, new Date("2026-07-21T00:00:00.000Z"), new Date("2026-07-21T00:00:00.000Z"));
    await expect(expiredContext.service.cleanupExpired()).resolves.toBe(0);
    await expect(readdir(path.dirname(orphan))).resolves.toContain(orphanId);
    await utimes(orphan, new Date("2026-07-19T00:00:00.000Z"), new Date("2026-07-19T00:00:00.000Z"));
    await expiredContext.service.cleanupExpired();
    await expect(readdir(path.dirname(orphan))).resolves.not.toContain(orphanId);

    const markedOrphanId = "66666666-6666-4666-8666-666666666666";
    const markedOrphan = path.join(expiredContext.dataDir, "uploads", "sessions", markedOrphanId);
    await mkdir(markedOrphan, { recursive: true });
    await writeFile(path.join(markedOrphan, ".devkh-upload-session.json"), JSON.stringify({
      workspaceId: expiredContext.setup.workspace.id,
      sessionId: markedOrphanId
    }));
    await expiredContext.service.cleanupExpired();
    await expect(readdir(path.dirname(markedOrphan))).resolves.not.toContain(markedOrphanId);

    const snapshotOrphanId = "77777777-7777-4777-8777-777777777777";
    const snapshotOrphan = path.join(expiredContext.dataDir, "snapshots", snapshotOrphanId);
    await mkdir(snapshotOrphan, { recursive: true });
    await writeFile(path.join(snapshotOrphan, PENDING_UPLOAD_SNAPSHOT_MARKER), JSON.stringify({
      workspaceId: expiredContext.setup.workspace.id,
      sessionId: markedOrphanId,
      snapshotId: snapshotOrphanId
    }));
    await expiredContext.service.cleanupExpired();
    await expect(readdir(path.dirname(snapshotOrphan))).resolves.not.toContain(snapshotOrphanId);
  });

  test("does not replay an expired create-session idempotency response", async () => {
    const context = await fixture(new Date("2026-07-21T00:00:00.000Z"));
    const input = {
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id,
      sessionVersion: 1, entryCount: 1, idempotencyKey: "expired-create-key"
    };
    const created = await context.service.createSession(input);
    context.store.uploadSessions.find((session) => session.id === created.id)!.expiresAt =
      new Date("2026-07-20T00:00:00.000Z");
    context.store.uploadIdempotencyKeys.find((record) => record.idempotencyKey === input.idempotencyKey)!.expiresAt =
      new Date("2026-07-20T00:00:00.000Z");

    await expect(context.service.createSession(input))
      .rejects.toMatchObject({ code: "UPLOAD_SESSION_EXPIRED", statusCode: 410 });
  });

  test("returns current verification state when an uploaded manifest page is replayed", async () => {
    const context = await fixture();
    const identity = {
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id, sessionVersion: 1
    };
    const content = "export const resumed = true;\n";
    const entry = source(0, "src/resumed.ts", content);
    const session = await context.service.createSession({
      ...identity, entryCount: 1, idempotencyKey: "resume-create"
    });
    const page = {
      ...identity, sessionId: session.id, page: 0, entries: [entry], idempotencyKey: "resume-page"
    };
    await expect(context.service.putManifestPage(page)).resolves.toMatchObject({
      entries: [expect.objectContaining({ trust: "pending" })]
    });
    await context.service.putFile({
      ...identity, sessionId: session.id, ordinal: 0,
      bytes: Buffer.from(content), idempotencyKey: "resume-file"
    });

    await expect(context.service.putManifestPage(page)).resolves.toMatchObject({
      entries: [expect.objectContaining({ trust: "server_verified" })]
    });
  });

  test("keeps an archived replacement while a sibling upload session is still active", async () => {
    const context = await fixture(new Date("2026-07-21T00:00:00.000Z"));
    const candidate = await context.store.prepareUploadReplacementWithAudit(
      context.setup.workspace.id, context.project.id, "Shared replacement", context.setup.admin.id
    );
    const base = {
      workspaceId: context.setup.workspace.id,
      projectId: context.project.id,
      repositoryId: candidate!.id,
      actorId: context.setup.admin.id,
      sessionVersion: 1,
      isReplacement: true,
      expectedCurrentRepositoryId: context.repository.id,
      entryCount: 1
    };
    await context.store.createUploadSession({
      ...base,
      id: "88888888-8888-4888-8888-888888888888",
      expiresAt: new Date("2026-07-20T00:00:00.000Z")
    });
    const active = await context.store.createUploadSession({
      ...base,
      id: "99999999-9999-4999-8999-999999999999",
      expiresAt: new Date("2026-07-22T00:00:00.000Z")
    });

    await expect(context.service.cleanupExpired()).resolves.toBe(1);
    await expect(context.store.getRepository(context.setup.workspace.id, candidate!.id))
      .resolves.toMatchObject({ id: candidate!.id, archivedAt: expect.any(Date) });
    await expect(context.store.getUploadSession(context.setup.workspace.id, active.id))
      .resolves.toMatchObject({ id: active.id, status: "open" });
  });

  test("expires a crashed commit without exposing its snapshot or leaving a running report", async () => {
    const context = await fixture(new Date("2026-07-21T00:00:00.000Z"));
    const candidate = await context.store.prepareUploadReplacementWithAudit(
      context.setup.workspace.id, context.project.id, "Crashed replacement", context.setup.admin.id
    );
    const session = await context.store.createUploadSession({
      id: "33333333-3333-4333-8333-333333333333",
      workspaceId: context.setup.workspace.id,
      projectId: context.project.id,
      repositoryId: candidate!.id,
      actorId: context.setup.admin.id,
      sessionVersion: 1,
      isReplacement: true,
      expectedCurrentRepositoryId: context.repository.id,
      entryCount: 1,
      expiresAt: new Date("2026-07-20T00:00:00.000Z")
    });
    const report = await context.store.createUploadSessionImportReport({
      workspaceId: session.workspaceId, projectId: session.projectId,
      repositoryId: session.repositoryId, actorId: session.actorId, sourceKind: "upload"
    }, session.id);
    const snapshotId = "44444444-4444-4444-8444-444444444444";
    await context.store.createSnapshotWithAudit({
      snapshot: {
        id: snapshotId, workspaceId: session.workspaceId, repositoryId: session.repositoryId,
        commitSha: "d".repeat(40), ref: "upload/crashed", remoteUrl: null,
        commitTimestamp: new Date("2026-07-19T00:00:00.000Z"),
        storagePath: path.join(context.dataDir, "snapshots", snapshotId, "files")
      },
      files: [{
        id: "55555555-5555-4555-8555-555555555555", workspaceId: session.workspaceId,
        snapshotId, path: "src/index.ts", byteSize: 10, contentHash: "e".repeat(64), language: "typescript"
      }]
    }, session.actorId, session.id);
    await context.store.markUploadSessionCommitting(session.workspaceId, session.id);

    await expect(context.store.latestSnapshot(session.workspaceId, session.repositoryId)).resolves.toBeNull();
    await expect(context.service.cleanupExpired()).resolves.toBe(1);
    await expect(context.store.getUploadSession(session.workspaceId, session.id)).resolves.toBeNull();
    await expect(context.store.getRepository(session.workspaceId, session.repositoryId)).resolves.toBeNull();
    await expect(context.store.listImportReports(session.workspaceId, session.projectId)).resolves.toContainEqual(
      expect.objectContaining({ id: report.id, status: "failed", failureCode: "UPLOAD_SESSION_EXPIRED" })
    );
  });

  test("cleans a compatibility snapshot left pending for more than 24 hours", async () => {
    const context = await fixture(new Date("2026-07-21T00:00:00.000Z"));
    const report = await context.store.createImportReport({
      workspaceId: context.setup.workspace.id,
      projectId: context.project.id,
      repositoryId: context.repository.id,
      actorId: context.setup.admin.id,
      sourceKind: "upload"
    });
    report.startedAt = new Date("2026-07-19T00:00:00.000Z");
    async function* pendingFile() {
      yield { path: "src/pending.ts", content: Buffer.from("export const pending = true;\n") };
    }
    const summary = await importFolderFiles({
      files: pendingFile(), dataDir: context.dataDir,
      workspaceId: context.setup.workspace.id, repositoryId: context.repository.id,
      actorId: context.setup.admin.id, store: context.store, pendingImportReportId: report.id
    });
    await context.store.discardPendingFolderImport(
      context.setup.workspace.id, report.id, summary.snapshotId
    );

    await context.service.cleanupExpired();

    await expect(context.store.findSnapshotById(context.setup.workspace.id, summary.snapshotId)).resolves.toBeNull();
    await expect(readdir(path.dirname(summary.storagePath))).rejects.toThrow();
    await expect(context.store.listImportReports(context.setup.workspace.id, context.project.id))
      .resolves.toContainEqual(expect.objectContaining({ id: report.id, status: "failed", failureCode: "UPLOAD_INTERRUPTED" }));
  });

  test("cleans a pending compatibility snapshot whose report already failed", async () => {
    const context = await fixture(new Date("2026-07-21T00:00:00.000Z"));
    const report = await context.store.createImportReport({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id, sourceKind: "upload"
    });
    report.startedAt = new Date("2026-07-19T00:00:00.000Z");
    async function* pendingFile() {
      yield { path: "src/failed.ts", content: Buffer.from("export const failed = true;\n") };
    }
    const summary = await importFolderFiles({
      files: pendingFile(), dataDir: context.dataDir,
      workspaceId: context.setup.workspace.id, repositoryId: context.repository.id,
      actorId: context.setup.admin.id, store: context.store, pendingImportReportId: report.id
    });
    await context.store.finishImportReport(context.setup.workspace.id, report.id, {
      status: "failed", collectedFileCount: 0, collectedTextBytes: 0,
      ignored: { total: 0, reasons: {} }, snapshotId: null, failureCode: "UPLOAD_FAILED"
    });

    await context.service.cleanupExpired();

    await expect(readdir(path.dirname(summary.storagePath))).rejects.toThrow();
  });

  test("fails a stale running compatibility report even when no snapshot marker exists", async () => {
    const context = await fixture(new Date("2026-07-21T00:00:00.000Z"));
    const report = await context.store.createImportReport({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id, sourceKind: "upload"
    });
    report.startedAt = new Date("2026-07-19T00:00:00.000Z");

    await context.service.cleanupExpired();

    await expect(context.store.listImportReports(context.setup.workspace.id, context.project.id))
      .resolves.toContainEqual(expect.objectContaining({
        id: report.id, status: "failed", failureCode: "UPLOAD_INTERRUPTED"
      }));
  });

  test("cancels a crashed commit and removes its pending snapshot immediately", async () => {
    const context = await fixture();
    const session = await context.store.createUploadSession({
      id: "88888888-8888-4888-8888-888888888888",
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id,
      sessionVersion: 1, isReplacement: false, expectedCurrentRepositoryId: context.repository.id, entryCount: 1,
      expiresAt: new Date("2026-07-20T00:00:00.000Z")
    });
    const report = await context.store.createUploadSessionImportReport({
      workspaceId: session.workspaceId, projectId: session.projectId,
      repositoryId: session.repositoryId, actorId: session.actorId, sourceKind: "upload"
    }, session.id);
    const snapshotId = "99999999-9999-4999-8999-999999999999";
    await context.store.createSnapshotWithAudit({
      snapshot: {
        id: snapshotId, workspaceId: session.workspaceId, repositoryId: session.repositoryId,
        commitSha: "f".repeat(40), ref: "upload/cancelled", remoteUrl: null,
        commitTimestamp: new Date(), storagePath: path.join(context.dataDir, "snapshots", snapshotId, "files")
      }, files: []
    }, session.actorId, session.id);
    const snapshotDirectory = path.join(context.dataDir, "snapshots", snapshotId);
    const snapshotFiles = path.join(snapshotDirectory, "files");
    await mkdir(snapshotFiles, { recursive: true });
    await writeFile(path.join(snapshotFiles, "source.ts"), "export {};\n");
    await chmod(path.join(snapshotFiles, "source.ts"), 0o444);
    await chmod(snapshotFiles, 0o555);
    await chmod(snapshotDirectory, 0o555);
    await context.store.markUploadSessionCommitting(session.workspaceId, session.id);

    await expect(context.service.cancel({
      workspaceId: session.workspaceId, projectId: session.projectId,
      actorId: session.actorId, sessionVersion: 1,
      sessionId: session.id, idempotencyKey: "cancel-crashed"
    })).resolves.toEqual({ cancelled: true });
    expect(context.store.sourceSnapshots).not.toContainEqual(expect.objectContaining({ id: snapshotId }));
    await expect(readdir(path.join(context.dataDir, "snapshots"))).resolves.not.toContain(snapshotId);
    await expect(context.store.listImportReports(session.workspaceId, session.projectId)).resolves.toContainEqual(
      expect.objectContaining({ id: report.id, status: "cancelled" })
    );
  });

  test("clears stale bytes before recreating the same expired session id", async () => {
    const context = await fixture();
    const input = {
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id,
      sessionVersion: 1, entryCount: 1, idempotencyKey: "recreated-session"
    };
    const first = await context.service.createSession(input);
    const staleDirectory = path.join(context.dataDir, "uploads", "sessions", first.id);
    await mkdir(staleDirectory, { recursive: true });
    await writeFile(path.join(staleDirectory, "stale.bin"), "old bytes");
    const persisted = context.store.uploadSessions.find((session) => session.id === first.id)!;
    persisted.expiresAt = new Date("2026-07-18T00:00:00.000Z");
    await context.store.deleteExpiredUploadSession(
      context.setup.workspace.id, first.id, new Date("2026-07-19T00:00:00.000Z")
    );

    await expect(context.service.createSession(input)).resolves.toMatchObject({ id: first.id });
    await expect(readdir(staleDirectory)).resolves.not.toContain("stale.bin");
  });

  test("invalidates member sessions immediately after disablement or project removal", async () => {
    const context = await fixture();
    const disabled = await context.store.createTeamMember(context.setup.workspace.id, {
      email: "disabled@example.com", passwordHash: "hash", role: "member"
    }, context.setup.admin.id);
    const removed = await context.store.createTeamMember(context.setup.workspace.id, {
      email: "removed@example.com", passwordHash: "hash", role: "member"
    }, context.setup.admin.id);
    await context.store.addProjectMember(
      context.setup.workspace.id, context.project.id, disabled!.id, "member", context.setup.admin.id
    );
    await context.store.addProjectMember(
      context.setup.workspace.id, context.project.id, removed!.id, "member", context.setup.admin.id
    );
    const createFor = (actorId: string, idempotencyKey: string) => context.service.createSession({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId, sessionVersion: 1,
      entryCount: 1, idempotencyKey
    });
    const disabledSession = await createFor(disabled!.id, "create-disabled");
    const removedSession = await createFor(removed!.id, "create-removed");
    await context.store.setTeamMemberDisabled(
      context.setup.workspace.id, disabled!.id, true, context.setup.admin.id
    );
    await context.store.removeProjectMember(
      context.setup.workspace.id, context.project.id, removed!.id, context.setup.admin.id
    );
    const entry = source(0, "src/index.ts", "export {};\n");

    await expect(context.service.putManifestPage({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      actorId: disabled!.id, sessionVersion: 2, sessionId: disabledSession.id,
      page: 0, entries: [entry], idempotencyKey: "disabled-page"
    })).rejects.toMatchObject({ code: "UPLOAD_SESSION_INVALIDATED" });
    await expect(context.service.putManifestPage({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      actorId: removed!.id, sessionVersion: 1, sessionId: removedSession.id,
      page: 0, entries: [entry], idempotencyKey: "removed-page"
    })).rejects.toMatchObject({ code: "UPLOAD_SESSION_INVALIDATED" });
  });

  test("rechecks project access inside final completion after a long-running import", async () => {
    const store = new RevokingCompletionStore();
    const context = await fixture(new Date("2026-07-19T00:00:00.000Z"), store);
    const member = await store.createTeamMember(context.setup.workspace.id, {
      email: "project-admin@example.com", passwordHash: "hash", role: "member"
    }, context.setup.admin.id);
    await store.addProjectMember(
      context.setup.workspace.id, context.project.id, member!.id, "admin", context.setup.admin.id
    );
    const text = "export const revoked = true;\n";
    const entries = [source(0, "src/revoked.ts", text)];
    const identity = {
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      actorId: member!.id, sessionVersion: member!.sessionVersion
    };
    const session = await context.service.createSession({
      ...identity, repositoryId: context.repository.id, entryCount: 1, idempotencyKey: "revoked-create"
    });
    await context.service.putManifestPage({
      ...identity, sessionId: session.id, page: 0, entries, idempotencyKey: "revoked-page"
    });
    await context.service.putFile({
      ...identity, sessionId: session.id, ordinal: 0, bytes: Buffer.from(text), idempotencyKey: "revoked-file"
    });
    store.revoke = {
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      userId: member!.id, actorId: context.setup.admin.id
    };

    await expect(context.service.commit({
      ...identity, sessionId: session.id,
      manifestDigest: canonicalUploadManifestDigest(entries), idempotencyKey: "revoked-commit"
    })).rejects.toMatchObject({ code: "UPLOAD_SESSION_INVALIDATED" });
    await expect(store.latestSnapshot(context.setup.workspace.id, context.repository.id)).resolves.toBeNull();
  });

  test("rejects a commit that expires during the final import", async () => {
    const store = new ExpiringCompletionStore();
    const context = await fixture(new Date("2026-07-19T00:00:00.000Z"), store);
    const text = "export const expires = true;\n";
    const entries = [source(0, "src/expires.ts", text)];
    const identity = {
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id, sessionVersion: 1
    };
    const session = await context.service.createSession({
      ...identity, entryCount: 1, idempotencyKey: "expires-create"
    });
    await context.service.putManifestPage({
      ...identity, sessionId: session.id, page: 0, entries, idempotencyKey: "expires-page"
    });
    await context.service.putFile({
      ...identity, sessionId: session.id, ordinal: 0,
      bytes: Buffer.from(text), idempotencyKey: "expires-file"
    });

    await expect(context.service.commit({
      ...identity, sessionId: session.id,
      manifestDigest: canonicalUploadManifestDigest(entries), idempotencyKey: "expires-commit"
    })).rejects.toMatchObject({ code: "UPLOAD_SESSION_INVALIDATED", statusCode: 409 });
    await expect(store.latestSnapshot(identity.workspaceId, identity.repositoryId)).resolves.toBeNull();
    await expect(store.getUploadSession(identity.workspaceId, session.id))
      .resolves.toMatchObject({ status: "committing" });
  });

  test("resumes uploaded bytes after a service restart", async () => {
    const context = await fixture();
    const text = "export const resumed = true;\n";
    const entries = [source(0, "src/resumed.ts", text)];
    const identity = {
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      actorId: context.setup.admin.id, sessionVersion: 1
    };
    const session = await context.service.createSession({
      ...identity, repositoryId: context.repository.id, entryCount: 1, idempotencyKey: "restart-create"
    });
    await context.service.putManifestPage({
      ...identity, sessionId: session.id, page: 0, entries, idempotencyKey: "restart-page"
    });
    await context.service.putFile({
      ...identity, sessionId: session.id, ordinal: 0, bytes: Buffer.from(text), idempotencyKey: "restart-file"
    });

    const restarted = new UploadSessionService({ store: context.store, dataDir: context.dataDir });
    await expect(restarted.commit({
      ...identity, sessionId: session.id,
      manifestDigest: canonicalUploadManifestDigest(entries), idempotencyKey: "restart-commit"
    })).resolves.toMatchObject({ fileCount: 1, unchanged: false });
  });

  test("does not re-promote a source that was current when its session started", async () => {
    const context = await fixture();
    const text = "export const oldSource = true;\n";
    const entries = [source(0, "src/old.ts", text)];
    const identity = {
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      actorId: context.setup.admin.id, sessionVersion: 1
    };
    const session = await context.service.createSession({
      ...identity, repositoryId: context.repository.id, entryCount: 1, idempotencyKey: "old-source-create"
    });
    await context.service.putManifestPage({
      ...identity, sessionId: session.id, page: 0, entries, idempotencyKey: "old-source-page"
    });
    await context.service.putFile({
      ...identity, sessionId: session.id, ordinal: 0, bytes: Buffer.from(text), idempotencyKey: "old-source-file"
    });
    const next = await context.store.prepareUploadReplacementWithAudit(
      context.setup.workspace.id, context.project.id, "Next", context.setup.admin.id
    );
    await context.store.activateUploadReplacementWithAudit(
      context.setup.workspace.id, context.project.id, next!.id, context.setup.admin.id
    );

    await expect(context.service.commit({
      ...identity, sessionId: session.id,
      manifestDigest: canonicalUploadManifestDigest(entries), idempotencyKey: "old-source-commit"
    })).rejects.toMatchObject({ code: "UPLOAD_SESSION_INVALIDATED", statusCode: 409 });
    await expect(context.store.currentRepository(context.setup.workspace.id, context.project.id))
      .resolves.toMatchObject({ id: next!.id });
  });

  test("rejects an older active-source session after a newer session commits", async () => {
    const context = await fixture();
    const identity = {
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      actorId: context.setup.admin.id, sessionVersion: 1
    };
    async function prepare(key: string, content: string) {
      const session = await context.service.createSession({
        ...identity, repositoryId: context.repository.id, entryCount: 1, idempotencyKey: `${key}-create`
      });
      const entries = [source(0, "src/index.ts", content)];
      await context.service.putManifestPage({
        ...identity, sessionId: session.id, page: 0, entries, idempotencyKey: `${key}-page`
      });
      await context.service.putFile({
        ...identity, sessionId: session.id, ordinal: 0, bytes: Buffer.from(content), idempotencyKey: `${key}-file`
      });
      return { session, entries };
    }
    const older = await prepare("older", "export const version = 1;\n");
    const newer = await prepare("newer", "export const version = 2;\n");

    const committed = await context.service.commit({
      ...identity, sessionId: newer.session.id,
      manifestDigest: canonicalUploadManifestDigest(newer.entries), idempotencyKey: "newer-commit"
    });
    await expect(context.service.commit({
      ...identity, sessionId: older.session.id,
      manifestDigest: canonicalUploadManifestDigest(older.entries), idempotencyKey: "older-commit"
    })).rejects.toMatchObject({ code: "UPLOAD_SESSION_INVALIDATED", statusCode: 409 });
    await expect(context.store.latestSnapshot(identity.workspaceId, context.repository.id))
      .resolves.toMatchObject({ id: committed.snapshotId });
  });

  test("deduplicates identical sessions that were created from the same snapshot", async () => {
    const context = await fixture();
    const identity = {
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      actorId: context.setup.admin.id, sessionVersion: 1
    };
    const content = "export const shared = true;\n";
    const entries = [source(0, "src/index.ts", content)];
    const sessions = await Promise.all(["one", "two"].map(async (key) => {
      const session = await context.service.createSession({
        ...identity, repositoryId: context.repository.id, entryCount: 1, idempotencyKey: `${key}-create`
      });
      await context.service.putManifestPage({
        ...identity, sessionId: session.id, page: 0, entries, idempotencyKey: `${key}-page`
      });
      await context.service.putFile({
        ...identity, sessionId: session.id, ordinal: 0, bytes: Buffer.from(content), idempotencyKey: `${key}-file`
      });
      return { key, session };
    }));

    const first = await context.service.commit({
      ...identity, sessionId: sessions[0]!.session.id,
      manifestDigest: canonicalUploadManifestDigest(entries), idempotencyKey: "one-commit"
    });
    const second = await context.service.commit({
      ...identity, sessionId: sessions[1]!.session.id,
      manifestDigest: canonicalUploadManifestDigest(entries), idempotencyKey: "two-commit"
    });

    expect(second).toMatchObject({ snapshotId: first.snapshotId, unchanged: true });
    expect(context.store.sourceSnapshots).toHaveLength(1);
  });

  test("reuses an unfinished upload replacement so the browser resume key remains valid", async () => {
    const context = await fixture();
    const candidate = await context.store.prepareUploadReplacementWithAudit(
      context.setup.workspace.id, context.project.id, "Replacement", context.setup.admin.id
    );
    await context.service.createSession({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: candidate!.id, actorId: context.setup.admin.id,
      sessionVersion: 1, entryCount: 1, idempotencyKey: "replacement-resume"
    });

    await expect(context.store.prepareUploadReplacementWithAudit(
      context.setup.workspace.id, context.project.id, "Replacement", context.setup.admin.id
    )).resolves.toMatchObject({ id: candidate!.id });
  });

  test("does not reuse another project administrator's unfinished replacement", async () => {
    const context = await fixture();
    const member = await context.store.createTeamMember(context.setup.workspace.id, {
      email: "uploader@example.com", passwordHash: "hash", role: "member"
    }, context.setup.admin.id);
    await context.store.addProjectMember(
      context.setup.workspace.id, context.project.id, member!.id, "admin", context.setup.admin.id
    );
    const candidate = await context.store.prepareUploadReplacementWithAudit(
      context.setup.workspace.id, context.project.id, "Member replacement", member!.id
    );
    await context.service.createSession({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: candidate!.id, actorId: member!.id,
      sessionVersion: 1, entryCount: 1, idempotencyKey: "member-replacement"
    });

    const adminCandidate = await context.store.prepareUploadReplacementWithAudit(
      context.setup.workspace.id, context.project.id, "Admin replacement", context.setup.admin.id
    );
    expect(adminCandidate).not.toBeNull();
    expect(adminCandidate!.id).not.toBe(candidate!.id);
  });

  test("allows only the replacement based on the still-current source to commit", async () => {
    const context = await fixture();
    const projectAdmin = await context.store.createTeamMember(context.setup.workspace.id, {
      email: "parallel-admin@example.com", passwordHash: "hash", role: "member"
    }, context.setup.admin.id);
    await context.store.addProjectMember(
      context.setup.workspace.id, context.project.id, projectAdmin!.id, "admin", context.setup.admin.id
    );
    const firstCandidate = await context.store.prepareUploadReplacementWithAudit(
      context.setup.workspace.id, context.project.id, "First candidate", projectAdmin!.id
    );
    const firstText = "export const first = true;\n";
    const firstEntries = [source(0, "src/first.ts", firstText)];
    const firstIdentity = {
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      actorId: projectAdmin!.id, sessionVersion: 1
    };
    const firstSession = await context.service.createSession({
      ...firstIdentity, repositoryId: firstCandidate!.id, entryCount: 1, idempotencyKey: "parallel-first"
    });
    await context.service.putManifestPage({
      ...firstIdentity, sessionId: firstSession.id, page: 0,
      entries: firstEntries, idempotencyKey: "parallel-first-page"
    });
    await context.service.putFile({
      ...firstIdentity, sessionId: firstSession.id, ordinal: 0,
      bytes: Buffer.from(firstText), idempotencyKey: "parallel-first-file"
    });

    const secondCandidate = await context.store.prepareUploadReplacementWithAudit(
      context.setup.workspace.id, context.project.id, "Second candidate", context.setup.admin.id
    );
    const secondText = "export const second = true;\n";
    const secondEntries = [source(0, "src/second.ts", secondText)];
    const secondIdentity = {
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      actorId: context.setup.admin.id, sessionVersion: 1
    };
    const secondSession = await context.service.createSession({
      ...secondIdentity, repositoryId: secondCandidate!.id, entryCount: 1, idempotencyKey: "parallel-second"
    });
    await context.service.putManifestPage({
      ...secondIdentity, sessionId: secondSession.id, page: 0,
      entries: secondEntries, idempotencyKey: "parallel-second-page"
    });
    await context.service.putFile({
      ...secondIdentity, sessionId: secondSession.id, ordinal: 0,
      bytes: Buffer.from(secondText), idempotencyKey: "parallel-second-file"
    });
    await context.service.commit({
      ...secondIdentity, sessionId: secondSession.id,
      manifestDigest: canonicalUploadManifestDigest(secondEntries), idempotencyKey: "parallel-second-commit"
    });

    await expect(context.service.commit({
      ...firstIdentity, sessionId: firstSession.id,
      manifestDigest: canonicalUploadManifestDigest(firstEntries), idempotencyKey: "parallel-first-commit"
    })).rejects.toMatchObject({ code: "UPLOAD_SESSION_INVALIDATED" });
    await expect(context.store.currentRepository(context.setup.workspace.id, context.project.id))
      .resolves.toMatchObject({ id: secondCandidate!.id });
  });

  test("activates a replacement only inside its project", async () => {
    const context = await fixture();
    const secondProject = await context.store.createProject(
      context.setup.workspace.id, { name: "Second", slug: "second" }, context.setup.admin.id
    );
    const secondCurrent = await context.store.createRepository(
      context.setup.workspace.id, { kind: "local", name: "Second current", path: "/second" }, secondProject!.id
    );
    const candidate = await context.store.prepareUploadReplacementWithAudit(
      context.setup.workspace.id, secondProject!.id, "Second upload", context.setup.admin.id
    );
    const text = "export const second = true;\n";
    const entries = [source(0, "src/index.ts", text)];
    const identity = {
      workspaceId: context.setup.workspace.id, projectId: secondProject!.id,
      actorId: context.setup.admin.id, sessionVersion: 1
    };
    const session = await context.service.createSession({
      ...identity, repositoryId: candidate!.id, entryCount: 1, idempotencyKey: "second-create"
    });
    await context.service.putManifestPage({
      ...identity, sessionId: session.id, page: 0, entries, idempotencyKey: "second-page"
    });
    await context.service.putFile({
      ...identity, sessionId: session.id, ordinal: 0, bytes: Buffer.from(text), idempotencyKey: "second-file"
    });
    await context.service.commit({
      ...identity, sessionId: session.id,
      manifestDigest: canonicalUploadManifestDigest(entries), idempotencyKey: "second-commit"
    });

    await expect(context.store.currentRepository(context.setup.workspace.id, context.project.id))
      .resolves.toMatchObject({ id: context.repository.id, archivedAt: null });
    await expect(context.store.currentRepository(context.setup.workspace.id, secondProject!.id))
      .resolves.toMatchObject({ id: candidate!.id, archivedAt: null });
    expect(await context.store.getRepository(context.setup.workspace.id, secondCurrent!.id))
      .toMatchObject({ archivedAt: expect.any(Date) });
  });

  test("rolls back replacement activation when atomic completion fails and remains retryable", async () => {
    const store = new FailingSwitchAuditStore();
    const context = await fixture(new Date("2026-07-19T00:00:00.000Z"), store);
    const candidate = await store.prepareUploadReplacementWithAudit(
      context.setup.workspace.id, context.project.id, "Replacement", context.setup.admin.id
    );
    const text = "export const replacement = true;\n";
    const entries = [source(0, "src/index.ts", text)];
    const identity = {
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      actorId: context.setup.admin.id, sessionVersion: 1
    };
    const session = await context.service.createSession({
      ...identity, repositoryId: candidate!.id, entryCount: 1, idempotencyKey: "rollback-create"
    });
    await context.service.putManifestPage({
      ...identity, sessionId: session.id, page: 0, entries, idempotencyKey: "rollback-page"
    });
    await context.service.putFile({
      ...identity, sessionId: session.id, ordinal: 0, bytes: Buffer.from(text), idempotencyKey: "rollback-file"
    });
    const commit = {
      ...identity, sessionId: session.id,
      manifestDigest: canonicalUploadManifestDigest(entries), idempotencyKey: "rollback-commit"
    };
    store.failSwitch = true;

    await expect(context.service.commit(commit)).rejects.toThrow("switch audit unavailable");
    await expect(store.currentRepository(context.setup.workspace.id, context.project.id))
      .resolves.toMatchObject({ id: context.repository.id, archivedAt: null });
    await expect(store.getUploadSession(context.setup.workspace.id, session.id))
      .resolves.toMatchObject({ status: "committing", commitResponse: null });
    await expect(store.latestSnapshot(context.setup.workspace.id, candidate!.id)).resolves.toBeNull();
    await expect(context.service.createSession({
      ...identity, repositoryId: candidate!.id, entryCount: 1, idempotencyKey: "rollback-create"
    })).resolves.toMatchObject({ id: session.id, status: "open" });
    await expect(context.service.createSession({
      ...identity, repositoryId: candidate!.id, entryCount: 1, idempotencyKey: "different-create"
    })).resolves.toMatchObject({ status: "open", id: expect.not.stringMatching(session.id) });

    store.failSwitch = false;
    await expect(context.service.commit(commit)).resolves.toMatchObject({ snapshotId: expect.any(String) });
    await expect(store.latestSnapshot(context.setup.workspace.id, candidate!.id))
      .resolves.toMatchObject({ id: expect.any(String) });
    await expect(store.currentRepository(context.setup.workspace.id, context.project.id))
      .resolves.toMatchObject({ id: candidate!.id, archivedAt: null });
  });

  test("cancels idempotently and removes staged bytes", async () => {
    const context = await fixture();
    const session = await context.service.createSession({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id,
      sessionVersion: 1, entryCount: 1, idempotencyKey: "create"
    });
    const identity = { workspaceId: context.setup.workspace.id, projectId: context.project.id, actorId: context.setup.admin.id, sessionVersion: 1 };
    const report = await context.store.createUploadSessionImportReport({
      workspaceId: context.setup.workspace.id, projectId: context.project.id,
      repositoryId: context.repository.id, actorId: context.setup.admin.id, sourceKind: "upload"
    }, session.id);

    await expect(context.service.cancel({ ...identity, sessionId: session.id, idempotencyKey: "cancel" })).resolves.toEqual({ cancelled: true });
    await expect(context.service.cancel({ ...identity, sessionId: session.id, idempotencyKey: "cancel" })).resolves.toEqual({ cancelled: true });
    await expect(context.service.putManifestPage({
      ...identity, sessionId: session.id, page: 0,
      entries: [source(0, "src/index.ts", "export {};\n")], idempotencyKey: "after-cancel"
    })).rejects.toBeInstanceOf(UploadSessionError);
    await expect(context.store.listImportReports(context.setup.workspace.id, context.project.id)).resolves.toContainEqual(
      expect.objectContaining({ id: report.id, status: "cancelled", failureCode: "UPLOAD_CANCELLED" })
    );
  });
});
