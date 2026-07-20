import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  SourceBlobIntegrityError,
  SourceBlobStore,
  type LockedSourceBlobCatalog,
  type SourceBlobCatalog,
  type SourceBlobRecord
} from "./source-blob-store.js";
import { removeReadOnlyTree } from "./folder-import.js";
import { MemoryAppStore } from "../persistence/memory-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeReadOnlyTree(root)));
});

class MemorySourceBlobCatalog implements SourceBlobCatalog {
  readonly records: SourceBlobRecord[] = [];
  readonly audits: Array<{ sourceBlobId: string; reason: string }> = [];
  readonly referenceCounts = new Map<string, number>();
  private readonly locks = new Map<string, Promise<void>>();

  async findSourceBlobGcCandidateTail() {
    const record = this.records.filter((candidate) => candidate.status !== "deleted").at(-1);
    return record ? {
      workspaceId: record.workspaceId,
      contentHash: record.contentHash,
      generation: record.generation,
      id: record.id
    } : null;
  }

  async listSourceBlobGcCandidates(input: { limit?: number }): Promise<SourceBlobRecord[]> {
    return this.records.filter((record) => record.status !== "deleted")
      .slice(0, input.limit).map((record) => ({ ...record }));
  }

  async findSourceBlobById(workspaceId: string, sourceBlobId: string): Promise<SourceBlobRecord | null> {
    return this.records.find((record) => record.workspaceId === workspaceId && record.id === sourceBlobId) ?? null;
  }

  async withSourceBlobLock<T>(
    workspaceId: string,
    contentHash: string,
    operation: (catalog: LockedSourceBlobCatalog) => Promise<T>
  ): Promise<T> {
    const key = `${workspaceId}:${contentHash}`;
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    this.locks.set(key, queued);
    await previous;
    try {
      return await operation({
        findActive: async () => this.records.find((record) => record.workspaceId === workspaceId
          && record.contentHash === contentHash && record.status === "active") ?? null,
        findTombstoned: async () => this.records.find((record) => record.workspaceId === workspaceId
          && record.contentHash === contentHash && record.status === "tombstoned") ?? null,
        findById: async (sourceBlobId: string) => this.records.find((record) => record.workspaceId === workspaceId
          && record.contentHash === contentHash && record.id === sourceBlobId) ?? null,
        countReferences: async (sourceBlobId: string) => this.referenceCounts.get(sourceBlobId) ?? 0,
        nextGeneration: async () => Math.max(0, ...this.records.filter((record) =>
          record.workspaceId === workspaceId && record.contentHash === contentHash
        ).map((record) => record.generation)) + 1,
        create: async (input) => {
          const record: SourceBlobRecord = {
            id: randomUUID(), ...input, status: "active", fencingToken: null,
            tombstonedAt: null, trashedAt: null, deletedAt: null
          };
          this.records.push(record);
          return record;
        },
        tombstoneIfUnreferenced: async (sourceBlobId: string, fencingToken: string, at: Date) =>
          this.replace(sourceBlobId, (record) => record.status === "active" ? {
            ...record, status: "tombstoned", fencingToken, tombstonedAt: at
          } : null),
        restoreTombstoned: async (sourceBlobId: string, fencingToken: string) =>
          this.replace(sourceBlobId, (record) => record.status === "tombstoned"
            && record.fencingToken === fencingToken ? {
              ...record, status: "active", fencingToken: null, tombstonedAt: null
            } : null),
        markTrash: async (sourceBlobId: string, fencingToken: string, at: Date) =>
          this.replace(sourceBlobId, (record) => record.status === "tombstoned"
            && record.fencingToken === fencingToken ? { ...record, status: "trash", trashedAt: at } : null),
        markDeletedIfUnreferenced: async (sourceBlobId: string, fencingToken: string, at: Date) =>
          this.replace(sourceBlobId, (record) => record.status === "trash"
            && record.fencingToken === fencingToken ? { ...record, status: "deleted", deletedAt: at } : null),
        recordGcInconsistency: async (sourceBlobId: string, reason: string) => {
          this.audits.push({ sourceBlobId, reason });
        }
      });
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }

  private replace(
    sourceBlobId: string,
    update: (record: SourceBlobRecord) => SourceBlobRecord | null
  ): SourceBlobRecord | null {
    const index = this.records.findIndex((record) => record.id === sourceBlobId);
    if (index < 0) return null;
    const updated = update(this.records[index]!);
    if (!updated) return null;
    this.records[index] = updated;
    return { ...updated };
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "devkh-source-blobs-"));
  roots.push(root);
  const catalog = new MemorySourceBlobCatalog();
  const store = new SourceBlobStore({ dataDir: root, catalog });
  await store.initialize();
  return { root, catalog, store };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("workspace source blob store", () => {
  test("verifies same-volume hardlinks at startup and removes every probe file", async () => {
    const context = await fixture();

    await context.store.verifyHardlinkSupport();

    await expect(readdir(path.join(context.root, "blobs"))).resolves.toEqual([]);
    await expect(readdir(path.join(context.root, "snapshots"))).resolves.toEqual([]);
  });

  test.each(["EXDEV", "ENOTSUP"])("rejects startup when hardlinks fail with %s and cleans the probe", async (code) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-source-blob-probe-"));
    roots.push(root);
    const error = Object.assign(new Error("link failed"), { code });
    const store = new SourceBlobStore({
      dataDir: root,
      catalog: new MemorySourceBlobCatalog(),
      linkFile: async () => { throw error; }
    });
    await store.initialize();

    await expect(store.verifyHardlinkSupport()).rejects.toMatchObject({
      code: "SNAPSHOT_VIEW_FAILED"
    });
    await expect(readdir(path.join(root, "blobs"))).resolves.toEqual([]);
    await expect(readdir(path.join(root, "snapshots"))).resolves.toEqual([]);
  });

  test("uses the application store as the lock-scoped source blob catalog", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-source-blobs-app-store-"));
    roots.push(root);
    const catalog = new MemoryAppStore();
    const setup = await catalog.createInitialSetup("blob-owner@example.com", "hash");
    const store = new SourceBlobStore({ dataDir: root, catalog });
    await store.initialize();

    const result = await store.put({
      workspaceId: setup!.workspace.id,
      bytes: Buffer.from("application catalog")
    });

    expect(result.record).toMatchObject({ workspaceId: setup!.workspace.id, generation: 1 });
  });

  test("writes immutable bytes and reuses the active generation in one workspace", async () => {
    const context = await fixture();
    const workspaceId = randomUUID();
    const bytes = Buffer.from("export const shared = true;\n");

    const [first, second] = await Promise.all([
      context.store.put({ workspaceId, bytes }),
      context.store.put({ workspaceId, bytes })
    ]);

    expect(second.record.id).toBe(first.record.id);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
    expect(context.catalog.records).toHaveLength(1);
    expect(first.record).toMatchObject({
      workspaceId, contentHash: sha256(bytes), generation: 1, byteSize: bytes.length, status: "active"
    });
    await expect(context.store.read(first.record)).resolves.toEqual(bytes);
  });

  test("never reuses identical bytes across workspaces", async () => {
    const context = await fixture();
    const bytes = Buffer.from("same bytes");

    const first = await context.store.put({ workspaceId: randomUUID(), bytes });
    const second = await context.store.put({ workspaceId: randomUUID(), bytes });

    expect(second.record.id).not.toBe(first.record.id);
    expect(second.record.storageKey).not.toBe(first.record.storageKey);
    expect(context.catalog.records).toHaveLength(2);
  });

  test("creates a new immutable generation after the previous generation is no longer active", async () => {
    const context = await fixture();
    const workspaceId = randomUUID();
    const bytes = Buffer.from("generation bytes");
    const first = await context.store.put({ workspaceId, bytes });
    context.catalog.records[0] = { ...first.record, status: "deleted", deletedAt: new Date() };

    const second = await context.store.put({ workspaceId, bytes });

    expect(second.record).toMatchObject({ generation: 2, status: "active" });
    expect(second.record.id).not.toBe(first.record.id);
  });

  test("cancels a tombstone and reuses its verified original while holding the upload lock", async () => {
    const context = await fixture();
    const workspaceId = randomUUID();
    const bytes = Buffer.from("revive before move");
    const first = await context.store.put({ workspaceId, bytes });
    const fencingToken = randomUUID();
    context.catalog.records[0] = {
      ...first.record, status: "tombstoned", fencingToken, tombstonedAt: new Date()
    };

    const reused = await context.store.put({ workspaceId, bytes });

    expect(reused).toMatchObject({ reused: true, record: { id: first.record.id, status: "active" } });
    expect(context.catalog.records[0]).toMatchObject({
      status: "active", fencingToken: null, tombstonedAt: null
    });
  });

  test("does not restore a tombstoned generation while its source file is writable", async () => {
    const context = await fixture();
    const workspaceId = randomUUID();
    const bytes = Buffer.from("mutable tombstone");
    const first = await context.store.put({ workspaceId, bytes });
    context.catalog.records[0] = {
      ...first.record, status: "tombstoned", fencingToken: randomUUID(), tombstonedAt: new Date()
    };
    await chmod(path.join(context.root, first.record.storageKey), 0o644);

    await expect(context.store.put({ workspaceId, bytes }))
      .rejects.toMatchObject({ code: "SOURCE_BLOB_INTEGRITY_FAILED" });
    expect(context.catalog.records[0]).toMatchObject({ status: "tombstoned" });
  });

  test("finishes a moved tombstone as trash and creates a new generation without reviving the old one", async () => {
    const context = await fixture();
    const workspaceId = randomUUID();
    const bytes = Buffer.from("replace after move");
    const first = await context.store.put({ workspaceId, bytes });
    context.catalog.records[0] = {
      ...first.record, status: "tombstoned", fencingToken: randomUUID(), tombstonedAt: new Date()
    };
    const original = path.join(context.root, first.record.storageKey);
    const trash = path.join(context.root, ".trash", workspaceId, first.record.contentHash, "1");
    await mkdir(path.dirname(trash), { recursive: true });
    await rename(original, trash);

    const replacement = await context.store.put({ workspaceId, bytes });

    expect(replacement).toMatchObject({ reused: false, record: { generation: 2, status: "active" } });
    expect(context.catalog.records[0]).toMatchObject({ status: "trash", fencingToken: expect.any(String) });
    await expect(readFile(trash)).resolves.toEqual(bytes);
    await expect(context.store.read(replacement.record)).resolves.toEqual(bytes);
  });

  test("audits and stops a moved tombstone with references without trashing it or creating a generation", async () => {
    const context = await fixture();
    const workspaceId = randomUUID();
    const bytes = Buffer.from("referenced moved tombstone");
    const first = await context.store.put({ workspaceId, bytes });
    context.catalog.records[0] = {
      ...first.record, status: "tombstoned", fencingToken: randomUUID(), tombstonedAt: new Date()
    };
    context.catalog.referenceCounts.set(first.record.id, 1);
    const original = path.join(context.root, first.record.storageKey);
    const trash = path.join(context.root, ".trash", workspaceId, first.record.contentHash, "1");
    await mkdir(path.dirname(trash), { recursive: true });
    await rename(original, trash);

    await expect(context.store.put({ workspaceId, bytes }))
      .rejects.toMatchObject({ code: "SOURCE_BLOB_INTEGRITY_FAILED" });

    expect(context.catalog.records).toHaveLength(1);
    expect(context.catalog.records[0]).toMatchObject({ status: "tombstoned", generation: 1 });
    expect(context.catalog.audits).toEqual([{
      sourceBlobId: first.record.id,
      reason: "referenced_tombstone_moved"
    }]);
    await expect(readFile(trash)).resolves.toEqual(bytes);
  });

  test("audits and rejects a writable active generation without reusing it", async () => {
    const context = await fixture();
    const workspaceId = randomUUID();
    const bytes = Buffer.from("writable active");
    const first = await context.store.put({ workspaceId, bytes });
    await chmod(path.join(context.root, first.record.storageKey), 0o644);

    await expect(context.store.put({ workspaceId, bytes }))
      .rejects.toMatchObject({ code: "SOURCE_BLOB_INTEGRITY_FAILED" });
    await expect(context.store.read(first.record))
      .rejects.toMatchObject({ code: "SOURCE_BLOB_INTEGRITY_FAILED" });

    expect(context.catalog.records).toHaveLength(1);
    expect(context.catalog.records[0]).toMatchObject({ status: "active" });
    expect(context.catalog.audits).toEqual([{
      sourceBlobId: first.record.id,
      reason: "active_content_inconsistent"
    }]);
  });

  test("rejects a new source_file binding when its blob generation is not active", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-source-blob-binding-"));
    roots.push(root);
    const catalog = new MemoryAppStore();
    const setup = await catalog.createInitialSetup("binding-owner@example.com", "hash");
    const store = new SourceBlobStore({ dataDir: root, catalog });
    await store.initialize();
    const created = await store.put({ workspaceId: setup!.workspace.id, bytes: Buffer.from("binding") });
    catalog.sourceBlobs[0] = {
      ...created.record, status: "tombstoned", fencingToken: randomUUID(), tombstonedAt: new Date()
    };
    const snapshotId = randomUUID();

    await expect(catalog.createSnapshot({
      snapshot: {
        id: snapshotId, workspaceId: setup!.workspace.id, repositoryId: randomUUID(),
        commitSha: "a".repeat(40), ref: "main", remoteUrl: null,
        commitTimestamp: new Date(), storagePath: root
      },
      files: [{
        id: randomUUID(), workspaceId: setup!.workspace.id, snapshotId, path: "src/binding.ts",
        byteSize: created.record.byteSize, contentHash: created.record.contentHash,
        language: "typescript", sourceBlobId: created.record.id
      }]
    })).rejects.toThrow("SOURCE_BLOB_NOT_ACTIVE");
    expect(catalog.sourceSnapshots).toHaveLength(0);
    expect(catalog.sourceFiles).toHaveLength(0);
  });

  test.each(["content hash", "byte size"] as const)(
    "rejects an active source_file binding with a mismatched %s",
    async (mismatch) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "devkh-source-blob-metadata-binding-"));
      roots.push(root);
      const catalog = new MemoryAppStore();
      const setup = await catalog.createInitialSetup("metadata-owner@example.com", "hash");
      const store = new SourceBlobStore({ dataDir: root, catalog });
      await store.initialize();
      const created = await store.put({ workspaceId: setup!.workspace.id, bytes: Buffer.from("metadata binding") });
      const snapshotId = randomUUID();

      await expect(catalog.createSnapshot({
        snapshot: {
          id: snapshotId, workspaceId: setup!.workspace.id, repositoryId: randomUUID(),
          commitSha: "d".repeat(40), ref: "main", remoteUrl: null,
          commitTimestamp: new Date(), storagePath: root
        },
        files: [{
          id: randomUUID(), workspaceId: setup!.workspace.id, snapshotId, path: "src/metadata.ts",
          byteSize: mismatch === "byte size" ? created.record.byteSize + 1 : created.record.byteSize,
          contentHash: mismatch === "content hash" ? "f".repeat(64) : created.record.contentHash,
          language: "typescript", sourceBlobId: created.record.id
        }]
      })).rejects.toThrow("SOURCE_BLOB_NOT_ACTIVE");
      expect(catalog.sourceSnapshots).toHaveLength(0);
      expect(catalog.sourceFiles).toHaveLength(0);
    }
  );

  test("adopts a verified orphan left after bytes were committed before the catalog transaction", async () => {
    const context = await fixture();
    const workspaceId = randomUUID();
    const bytes = Buffer.from("recoverable orphan");
    const contentHash = sha256(bytes);
    const destination = path.join(
      context.root, "blobs", workspaceId, contentHash.slice(0, 2), contentHash, "1"
    );
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { mode: 0o600 });
    await chmod(destination, 0o444);

    const result = await context.store.put({ workspaceId, bytes });

    expect(result).toMatchObject({ reused: false, record: { generation: 1, storageKey: path.relative(context.root, destination) } });
    await expect(context.store.read(result.record)).resolves.toEqual(bytes);
    expect(context.catalog.records).toHaveLength(1);
  });

  test("rejects a mismatched orphan instead of replacing unowned bytes", async () => {
    const context = await fixture();
    const workspaceId = randomUUID();
    const bytes = Buffer.from("expected orphan");
    const contentHash = sha256(bytes);
    const destination = path.join(
      context.root, "blobs", workspaceId, contentHash.slice(0, 2), contentHash, "1"
    );
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, "different bytes", { mode: 0o444 });

    await expect(context.store.put({ workspaceId, bytes }))
      .rejects.toMatchObject({ code: "SOURCE_BLOB_INTEGRITY_FAILED" });
    expect(context.catalog.records).toHaveLength(0);
  });

  test("rejects a missing or tampered active blob instead of silently replacing it", async () => {
    const context = await fixture();
    const workspaceId = randomUUID();
    const created = await context.store.put({ workspaceId, bytes: Buffer.from("trusted") });
    const blobPath = path.join(context.root, created.record.storageKey);
    await unlink(blobPath);

    await expect(context.store.put({ workspaceId, bytes: Buffer.from("trusted") }))
      .rejects.toMatchObject({ code: "SOURCE_BLOB_MISSING" });
    await writeFile(blobPath, "tampered");
    await expect(context.store.read(created.record))
      .rejects.toMatchObject({ code: "SOURCE_BLOB_INTEGRITY_FAILED" });
  });

  test("materializes a read-only snapshot view with same-volume hardlinks", async () => {
    const context = await fixture();
    const workspaceId = randomUUID();
    const created = await context.store.put({ workspaceId, bytes: Buffer.from("linked") });
    const snapshotId = randomUUID();

    const view = await context.store.materializeSnapshotView({
      workspaceId,
      snapshotId,
      files: [{ path: "src/index.ts", blob: created.record }]
    });

    const blobPath = path.join(context.root, created.record.storageKey);
    const viewPath = path.join(view, "src/index.ts");
    expect((await stat(viewPath)).ino).toBe((await stat(blobPath)).ino);
    expect((await stat(viewPath)).mode & 0o222).toBe(0);
    await expect(readFile(viewPath, "utf8")).resolves.toBe("linked");
  });

  test("rejects unsafe snapshot paths and removes the incomplete view", async () => {
    const context = await fixture();
    const workspaceId = randomUUID();
    const created = await context.store.put({ workspaceId, bytes: Buffer.from("linked") });
    const snapshotId = randomUUID();

    await expect(context.store.materializeSnapshotView({
      workspaceId,
      snapshotId,
      files: [{ path: "../outside.ts", blob: created.record }]
    })).rejects.toBeInstanceOf(SourceBlobIntegrityError);
    await expect(stat(path.join(context.root, "snapshots", snapshotId))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
