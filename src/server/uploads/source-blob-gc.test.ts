import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { SourceBlobGarbageCollector } from "./source-blob-gc.js";
import { SourceBlobStore } from "./source-blob-store.js";
import { removeReadOnlyTree } from "./folder-import.js";
import { MemoryAppStore } from "../persistence/memory-store.js";
import type { SourceBlobRecord } from "../persistence/store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeReadOnlyTree(root)));
});

function sourcePath(root: string, record: SourceBlobRecord): string {
  return path.join(root, ...record.storageKey.split("/"));
}

function trashPath(root: string, record: SourceBlobRecord): string {
  return path.join(root, ".trash", record.workspaceId, record.contentHash, String(record.generation));
}

async function expectMissing(candidate: string): Promise<void> {
  await expect(stat(candidate)).rejects.toMatchObject({ code: "ENOENT" });
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "devkh-source-blob-gc-"));
  roots.push(root);
  const catalog = new MemoryAppStore();
  const setup = await catalog.createInitialSetup("gc-owner@example.com", "hash");
  const blobs = new SourceBlobStore({ dataDir: root, catalog });
  await blobs.initialize();
  let now = new Date("2026-07-20T00:00:00.000Z");
  const collector = (overrides: Partial<ConstructorParameters<typeof SourceBlobGarbageCollector>[0]> = {}) =>
    new SourceBlobGarbageCollector({
      dataDir: root,
      catalog,
      enabled: true,
      tombstoneGraceMs: 1_000,
      trashGraceMs: 2_000,
      now: () => new Date(now),
      ...overrides
    });
  return {
    root,
    catalog,
    blobs,
    workspaceId: setup!.workspace.id,
    collector,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    }
  };
}

describe("source blob garbage collection", () => {
  test("is disabled by default and has zero catalog or filesystem side effects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-source-blob-gc-disabled-"));
    roots.push(root);
    const catalog = {
      findSourceBlobGcCandidateTail: vi.fn(async () => { throw new Error("tail touched"); }),
      listSourceBlobGcCandidates: vi.fn(async () => { throw new Error("catalog touched"); }),
      withSourceBlobLock: vi.fn(async () => { throw new Error("lock touched"); })
    };

    const result = await new SourceBlobGarbageCollector({ dataDir: root, catalog: catalog as never }).runOnce();

    expect(result).toEqual({ scanned: 0, tombstoned: 0, restored: 0, trashed: 0, deleted: 0, inconsistent: 0 });
    expect(catalog.findSourceBlobGcCandidateTail).not.toHaveBeenCalled();
    expect(catalog.listSourceBlobGcCandidates).not.toHaveBeenCalled();
    expect(catalog.withSourceBlobLock).not.toHaveBeenCalled();
    await expect(stat(path.join(root, ".trash"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("requests the fixed default candidate limit and accepts a smaller explicit batch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-source-blob-gc-limit-"));
    roots.push(root);
    const tail = { workspaceId: "workspace", contentHash: "f".repeat(64), generation: 1, id: randomUUID() };
    const catalog = {
      findSourceBlobGcCandidateTail: vi.fn(async () => tail),
      listSourceBlobGcCandidates: vi.fn(async () => []),
      withSourceBlobLock: vi.fn(async () => { throw new Error("unexpected candidate"); })
    };

    await new SourceBlobGarbageCollector({ dataDir: root, catalog: catalog as never, enabled: true }).runOnce();
    await new SourceBlobGarbageCollector({
      dataDir: root, catalog: catalog as never, enabled: true, candidateLimit: 7
    }).runOnce();

    expect(catalog.listSourceBlobGcCandidates.mock.calls).toEqual([
      [{ through: tail, limit: 500 }],
      [{ through: tail, limit: 7 }]
    ]);
  });

  test("applies the same candidate limit in the memory catalog", async () => {
    const context = await fixture();
    for (let generation = 1; generation <= 3; generation += 1) {
      const contentHash = generation.toString(16).padStart(64, "0");
      context.catalog.sourceBlobs.push({
        id: randomUUID(), workspaceId: context.workspaceId, contentHash, generation: 1,
        byteSize: generation, status: "active",
        storageKey: path.posix.join("blobs", context.workspaceId, contentHash.slice(0, 2), contentHash, "1"),
        fencingToken: null, tombstonedAt: null, trashedAt: null, deletedAt: null
      });
    }

    const tail = await context.catalog.findSourceBlobGcCandidateTail();
    await expect(context.catalog.listSourceBlobGcCandidates({ through: tail!, limit: 2 }))
      .resolves.toHaveLength(2);
  });

  test("keyset pagination reaches candidates after an inconsistent first page", async () => {
    const context = await fixture();
    const created = await Promise.all([
      context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("page candidate one") }),
      context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("page candidate two") }),
      context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("page candidate three") })
    ]);
    const ordered = [...context.catalog.sourceBlobs].sort((left, right) =>
      left.workspaceId.localeCompare(right.workspaceId)
      || left.contentHash.localeCompare(right.contentHash)
      || left.generation - right.generation
      || left.id.localeCompare(right.id)
    );
    const inconsistent = ordered[0]!;
    Object.assign(inconsistent, {
      status: "tombstoned" as const,
      fencingToken: randomUUID(),
      tombstonedAt: new Date("2026-07-20T00:00:00.000Z")
    });
    await chmod(sourcePath(context.root, inconsistent), 0o644);

    await expect(context.collector({ candidateLimit: 2 }).runOnce()).resolves.toMatchObject({
      scanned: 3,
      inconsistent: 1,
      tombstoned: 2
    });
    expect(context.catalog.sourceBlobs.filter((record) => record.status === "active")).toHaveLength(0);
    expect(created).toHaveLength(3);
  });

  test("tombstones only an unreferenced active blob, then moves and deletes it after separate grace periods", async () => {
    const context = await fixture();
    const created = await context.blobs.put({
      workspaceId: context.workspaceId,
      bytes: Buffer.from("delayed collection")
    });
    const original = sourcePath(context.root, created.record);
    const trash = trashPath(context.root, created.record);

    await expect(context.collector().runOnce()).resolves.toMatchObject({ scanned: 1, tombstoned: 1 });
    expect(context.catalog.sourceBlobs[0]).toMatchObject({ status: "tombstoned" });
    expect(context.catalog.sourceBlobs[0]?.fencingToken).toMatch(/^[0-9a-f-]{36}$/);
    await expect(stat(original)).resolves.toBeDefined();

    context.advance(999);
    await expect(context.collector().runOnce()).resolves.toMatchObject({ trashed: 0 });
    await expect(stat(original)).resolves.toBeDefined();

    context.advance(1);
    await expect(context.collector().runOnce()).resolves.toMatchObject({ trashed: 1 });
    expect(context.catalog.sourceBlobs[0]).toMatchObject({ status: "trash" });
    await expectMissing(original);
    await expect(stat(trash)).resolves.toBeDefined();

    context.advance(1_999);
    await expect(context.collector().runOnce()).resolves.toMatchObject({ deleted: 0 });
    context.advance(1);
    await expect(context.collector().runOnce()).resolves.toMatchObject({ deleted: 1 });
    expect(context.catalog.sourceBlobs[0]).toMatchObject({ status: "deleted" });
    await expectMissing(trash);
  });

  test("does not tombstone an active generation with a source_file reference", async () => {
    const context = await fixture();
    const created = await context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("referenced") });
    context.catalog.sourceFiles.push({
      id: randomUUID(), workspaceId: context.workspaceId, snapshotId: randomUUID(), path: "src/referenced.ts",
      byteSize: created.record.byteSize, contentHash: created.record.contentHash, language: "typescript",
      sourceBlobId: created.record.id
    });

    await expect(context.collector().runOnce()).resolves.toMatchObject({ tombstoned: 0 });
    expect(context.catalog.sourceBlobs[0]).toMatchObject({ status: "active", fencingToken: null });
  });

  test("restores a referenced tombstone while its verified original file is still present", async () => {
    const context = await fixture();
    const created = await context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("late reference") });
    await context.collector().runOnce();
    context.catalog.sourceFiles.push({
      id: randomUUID(), workspaceId: context.workspaceId, snapshotId: randomUUID(), path: "src/late.ts",
      byteSize: created.record.byteSize, contentHash: created.record.contentHash, language: null,
      sourceBlobId: created.record.id
    });

    await expect(context.collector().runOnce()).resolves.toMatchObject({ restored: 1 });
    expect(context.catalog.sourceBlobs[0]).toMatchObject({
      status: "active", fencingToken: null, tombstonedAt: null
    });
  });

  test("audits and stops when a referenced tombstone has already moved to trash", async () => {
    const context = await fixture();
    const created = await context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("moved reference") });
    await context.collector().runOnce();
    const original = sourcePath(context.root, created.record);
    const trash = trashPath(context.root, created.record);
    await mkdir(path.dirname(trash), { recursive: true });
    await rename(original, trash);
    context.catalog.sourceFiles.push({
      id: randomUUID(), workspaceId: context.workspaceId, snapshotId: randomUUID(), path: "src/moved.ts",
      byteSize: created.record.byteSize, contentHash: created.record.contentHash, language: null,
      sourceBlobId: created.record.id
    });

    await expect(context.collector().runOnce()).resolves.toMatchObject({ inconsistent: 1, trashed: 0 });
    expect(context.catalog.sourceBlobs[0]).toMatchObject({ status: "tombstoned" });
    expect(context.catalog.auditEvents.at(-1)).toMatchObject({ action: "source_blob.gc_inconsistent" });
  });

  test.each(["present", "missing"] as const)(
    "audits and stops a referenced trash generation when its file is %s",
    async (physicalState) => {
      const context = await fixture();
      const created = await context.blobs.put({
        workspaceId: context.workspaceId,
        bytes: Buffer.from(`referenced trash ${physicalState}`)
      });
      await context.collector().runOnce();
      context.advance(1_000);
      await context.collector().runOnce();
      const trash = trashPath(context.root, created.record);
      if (physicalState === "missing") await unlink(trash);
      context.catalog.sourceFiles.push({
        id: randomUUID(), workspaceId: context.workspaceId, snapshotId: randomUUID(), path: "src/trash.ts",
        byteSize: created.record.byteSize, contentHash: created.record.contentHash, language: null,
        sourceBlobId: created.record.id
      });
      context.advance(2_000);

      await expect(context.collector().runOnce()).resolves.toMatchObject({ inconsistent: 1, deleted: 0 });
      expect(context.catalog.sourceBlobs[0]).toMatchObject({ status: "trash" });
      expect(context.catalog.auditEvents.at(-1)).toMatchObject({ action: "source_blob.gc_inconsistent" });
    }
  );

  test("recovers a crash after tombstoning by moving the original on the next eligible run", async () => {
    const context = await fixture();
    const created = await context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("crash one") });
    await context.collector().runOnce();
    context.advance(1_000);

    await expect(context.collector().runOnce()).resolves.toMatchObject({ trashed: 1 });
    await expectMissing(sourcePath(context.root, created.record));
    await expect(stat(trashPath(context.root, created.record))).resolves.toBeDefined();
  });

  test("recovers a crash after rename by verifying trash and completing the fenced trash transition", async () => {
    const context = await fixture();
    const created = await context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("crash two") });
    await context.collector().runOnce();
    const original = sourcePath(context.root, created.record);
    const trash = trashPath(context.root, created.record);
    const syncDirectory = vi.fn(async () => undefined);
    await mkdir(path.dirname(trash), { recursive: true });
    await rename(original, trash);

    await expect(context.collector({ syncDirectory }).runOnce()).resolves.toMatchObject({ trashed: 1 });
    expect(syncDirectory).toHaveBeenCalledWith(path.dirname(original));
    expect(syncDirectory).toHaveBeenCalledWith(path.dirname(trash));
    expect(context.catalog.sourceBlobs[0]).toMatchObject({ status: "trash" });
  });

  test("recovers a crash after physical deletion by rechecking references before marking deleted", async () => {
    const context = await fixture();
    const created = await context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("crash three") });
    await context.collector().runOnce();
    context.advance(1_000);
    await context.collector().runOnce();
    await unlink(trashPath(context.root, created.record));

    await expect(context.collector().runOnce()).resolves.toMatchObject({ deleted: 1 });
    expect(context.catalog.sourceBlobs[0]).toMatchObject({ status: "deleted" });
  });

  test("syncs the missing trash parent before completing the deleted transition", async () => {
    const context = await fixture();
    const created = await context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("ordered delete") });
    await context.collector().runOnce();
    context.advance(1_000);
    await context.collector().runOnce();
    const trash = trashPath(context.root, created.record);
    await unlink(trash);
    const order: string[] = [];
    const baseCatalog = context.catalog;
    const catalog = {
      findSourceBlobGcCandidateTail: () => baseCatalog.findSourceBlobGcCandidateTail(),
      listSourceBlobGcCandidates: (input: Parameters<typeof baseCatalog.listSourceBlobGcCandidates>[0]) =>
        baseCatalog.listSourceBlobGcCandidates(input),
      findSourceBlobById: (workspaceId: string, sourceBlobId: string) =>
        baseCatalog.findSourceBlobById(workspaceId, sourceBlobId),
      withSourceBlobLock: <T>(
        workspaceId: string,
        contentHash: string,
        operation: Parameters<typeof baseCatalog.withSourceBlobLock<T>>[2]
      ) => baseCatalog.withSourceBlobLock(workspaceId, contentHash, async (locked) => operation({
        ...locked,
        markDeletedIfUnreferenced: async (...args: Parameters<typeof locked.markDeletedIfUnreferenced>) => {
          order.push("mark-deleted");
          return locked.markDeletedIfUnreferenced(...args);
        }
      }))
    };
    const collector = context.collector({
      catalog: catalog as never,
      syncDirectory: async (directory) => {
        expect(directory).toBe(path.dirname(trash));
        order.push("sync");
      }
    });

    await expect(collector.runOnce()).resolves.toMatchObject({ deleted: 1 });
    expect(order).toEqual(["sync", "mark-deleted"]);
  });

  test("stops a tampered generation and audits without recording a sensitive path", async () => {
    const context = await fixture();
    const created = await context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("trusted bytes") });
    await context.collector().runOnce();
    const original = sourcePath(context.root, created.record);
    await chmod(original, 0o644);
    await writeFile(original, "tampered bytes");
    await chmod(original, 0o444);
    context.advance(1_000);

    await expect(context.collector().runOnce()).resolves.toMatchObject({ inconsistent: 1, trashed: 0 });
    expect(context.catalog.sourceBlobs[0]).toMatchObject({ status: "tombstoned" });
    const audit = context.catalog.auditEvents.at(-1);
    expect(audit).toMatchObject({
      action: "source_blob.gc_inconsistent",
      resourceType: "source_blob",
      resourceId: created.record.id
    });
    expect(JSON.stringify(audit)).not.toContain(context.root);
    expect(JSON.stringify(audit)).not.toContain(created.record.storageKey);
  });

  test("rejects a hash-correct generation that is still writable", async () => {
    const context = await fixture();
    const created = await context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("mutable bytes") });
    await context.collector().runOnce();
    const original = sourcePath(context.root, created.record);
    await chmod(original, 0o644);
    context.advance(1_000);

    await expect(context.collector().runOnce()).resolves.toMatchObject({ inconsistent: 1, trashed: 0 });
    expect(context.catalog.sourceBlobs[0]).toMatchObject({ status: "tombstoned" });
    await expect(stat(original)).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  test("never lets an old generation fence transition or delete a newer active generation", async () => {
    const context = await fixture();
    const bytes = Buffer.from("generation isolation");
    const first = await context.blobs.put({ workspaceId: context.workspaceId, bytes });
    await context.collector().runOnce();
    context.advance(1_000);
    await context.collector().runOnce();
    const firstFence = context.catalog.sourceBlobs[0]!.fencingToken!;
    const second = await context.blobs.put({ workspaceId: context.workspaceId, bytes });
    context.catalog.sourceFiles.push({
      id: randomUUID(), workspaceId: context.workspaceId, snapshotId: randomUUID(), path: "src/current.ts",
      byteSize: second.record.byteSize, contentHash: second.record.contentHash, language: "typescript",
      sourceBlobId: second.record.id
    });

    await context.catalog.withSourceBlobLock(context.workspaceId, first.record.contentHash, async (locked) => {
      await expect(locked.markTrash(second.record.id, firstFence, new Date())).resolves.toBeNull();
      await expect(locked.markDeletedIfUnreferenced(second.record.id, firstFence, new Date())).resolves.toBeNull();
    });
    context.advance(2_000);
    await context.collector().runOnce();

    expect(context.catalog.sourceBlobs.find((record) => record.id === first.record.id)).toMatchObject({ status: "deleted" });
    expect(context.catalog.sourceBlobs.find((record) => record.id === second.record.id)).toMatchObject({ status: "active" });
    await expect(context.blobs.read(second.record)).resolves.toEqual(bytes);
  });

  test("isolates identical content across workspaces while collecting candidates", async () => {
    const context = await fixture();
    const bytes = Buffer.from("workspace isolation");
    const first = await context.blobs.put({ workspaceId: context.workspaceId, bytes });
    const otherWorkspaceId = randomUUID();
    const other: SourceBlobRecord = {
      ...first.record,
      id: randomUUID(),
      workspaceId: otherWorkspaceId,
      storageKey: path.posix.join(
        "blobs", otherWorkspaceId, first.record.contentHash.slice(0, 2), first.record.contentHash, "1"
      )
    };
    const otherPath = sourcePath(context.root, other);
    await mkdir(path.dirname(otherPath), { recursive: true });
    await writeFile(otherPath, bytes, { mode: 0o444 });
    context.catalog.sourceBlobs.push(other);
    context.catalog.sourceFiles.push({
      id: randomUUID(), workspaceId: otherWorkspaceId, snapshotId: randomUUID(), path: "src/other.ts",
      byteSize: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex"), language: null,
      sourceBlobId: other.id
    });

    await context.collector().runOnce();

    expect(context.catalog.sourceBlobs.find((record) => record.id === first.record.id)).toMatchObject({ status: "tombstoned" });
    expect(context.catalog.sourceBlobs.find((record) => record.id === other.id)).toMatchObject({ status: "active" });
    await expect(stat(otherPath)).resolves.toBeDefined();
  });
});
