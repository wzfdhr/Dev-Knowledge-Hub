import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
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
  private readonly locks = new Map<string, Promise<void>>();

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
        }
      });
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
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
