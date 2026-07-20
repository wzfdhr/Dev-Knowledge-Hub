import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
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
      withSourceBlobGcLease: vi.fn(async () => { throw new Error("lease touched"); }),
      findSourceBlobGcRunBoundary: vi.fn(async () => { throw new Error("boundary touched"); }),
      listSourceBlobGcCandidates: vi.fn(async () => { throw new Error("catalog touched"); }),
      withSourceBlobLock: vi.fn(async () => { throw new Error("lock touched"); })
    };

    const result = await new SourceBlobGarbageCollector({ dataDir: root, catalog: catalog as never }).runOnce();

    expect(result).toEqual({
      scanned: 0, tombstoned: 0, restored: 0, trashed: 0, deleted: 0, inconsistent: 0,
      lockBusy: false, resumeRequired: false
    });
    expect(catalog.withSourceBlobGcLease).not.toHaveBeenCalled();
    expect(catalog.findSourceBlobGcRunBoundary).not.toHaveBeenCalled();
    expect(catalog.listSourceBlobGcCandidates).not.toHaveBeenCalled();
    expect(catalog.withSourceBlobLock).not.toHaveBeenCalled();
    await expect(stat(path.join(root, ".trash"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("requests the fixed default candidate limit and accepts a smaller explicit batch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-source-blob-gc-limit-"));
    roots.push(root);
    const tail = { workspaceId: "workspace", contentHash: "f".repeat(64), generation: 1, id: randomUUID() };
    const boundary = {
      through: tail,
      creationCutoff: "2026-07-20T00:00:00.000000Z"
    };
    const withSourceBlobGcLease = vi.fn(async (operation: (scoped: never) => Promise<unknown>) => ({
      acquired: true as const, value: await operation(catalog as never)
    }));
    const catalog = {
      withSourceBlobGcLease,
      findSourceBlobGcRunBoundary: vi.fn(async () => boundary),
      listSourceBlobGcCandidates: vi.fn(async () => []),
      withSourceBlobLock: vi.fn(async () => { throw new Error("unexpected candidate"); })
    };

    await new SourceBlobGarbageCollector({ dataDir: root, catalog: catalog as never, enabled: true }).runOnce();
    await new SourceBlobGarbageCollector({
      dataDir: root, catalog: catalog as never, enabled: true, candidateLimit: 7
    }).runOnce();

    expect(catalog.listSourceBlobGcCandidates.mock.calls).toEqual([
      [{ ...boundary, limit: 500 }],
      [{ ...boundary, limit: 7 }]
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

    const boundary = await context.catalog.findSourceBlobGcRunBoundary();
    await expect(context.catalog.listSourceBlobGcCandidates({ ...boundary!, limit: 2 }))
      .resolves.toHaveLength(2);
  });

  test("holds one exclusive lease around the boundary and every page, then releases on success and error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-source-blob-gc-lease-"));
    roots.push(root);
    const events: string[] = [];
    const boundary = {
      through: { workspaceId: "workspace", contentHash: "f".repeat(64), generation: 1, id: randomUUID() },
      creationCutoff: "2026-07-20T00:00:00.000000Z"
    };
    const makeCatalog = (fail: boolean) => {
      const leaseCatalog = {
        findSourceBlobGcRunBoundary: async () => { events.push("boundary"); return boundary; },
        listSourceBlobGcCandidates: async () => {
          events.push("page");
          if (fail) throw new Error("page failed");
          return [];
        },
        withSourceBlobLock: vi.fn()
      };
      return {
      withSourceBlobGcLease: async (operation: (catalog: typeof leaseCatalog) => Promise<unknown>) => {
        events.push("acquire");
        try { return { acquired: true as const, value: await operation(leaseCatalog) }; }
        finally { events.push("release"); }
      },
      findSourceBlobGcRunBoundary: vi.fn(async () => { throw new Error("escaped lease"); }),
      listSourceBlobGcCandidates: vi.fn(async () => { throw new Error("escaped lease"); }),
      withSourceBlobLock: vi.fn(async () => { throw new Error("escaped lease"); })
    }; };

    await new SourceBlobGarbageCollector({ dataDir: root, catalog: makeCatalog(false) as never, enabled: true }).runOnce();
    expect(events).toEqual(["acquire", "boundary", "page", "release"]);
    events.length = 0;
    await expect(new SourceBlobGarbageCollector({
      dataDir: root, catalog: makeCatalog(true) as never, enabled: true
    }).runOnce()).rejects.toThrow("page failed");
    expect(events).toEqual(["acquire", "boundary", "page", "release"]);
  });

  test("returns a stable no-op when the exclusive lease is busy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-source-blob-gc-busy-"));
    roots.push(root);
    const boundary = vi.fn();
    const catalog = {
      withSourceBlobGcLease: vi.fn(async () => ({ acquired: false as const })),
      findSourceBlobGcRunBoundary: boundary,
      listSourceBlobGcCandidates: vi.fn(),
      withSourceBlobLock: vi.fn()
    };
    await expect(new SourceBlobGarbageCollector({ dataDir: root, catalog: catalog as never, enabled: true }).runOnce())
      .resolves.toMatchObject({ lockBusy: true, resumeRequired: false, scanned: 0 });
    expect(boundary).not.toHaveBeenCalled();
  });

  test("memory lease releases after errors, blocks writers, and permits its own GC transition lock", async () => {
    const catalog = new MemoryAppStore();
    const setup = await catalog.createInitialSetup("memory-gc-gate@example.com", "hash");
    const contentHash = "a".repeat(64);

    await expect(catalog.withSourceBlobGcLease(() => catalog.withSourceBlobLock(
      setup!.workspace.id, contentHash, async () => "transitioned"
    ))).resolves.toEqual({ acquired: true, value: "transitioned" });
    await expect(catalog.withSourceBlobGcLease(async () => { throw new Error("lease failed"); }))
      .rejects.toThrow("lease failed");

    let releaseLease!: () => void;
    let enterLease!: () => void;
    const release = new Promise<void>((resolve) => { releaseLease = resolve; });
    const entered = new Promise<void>((resolve) => { enterLease = resolve; });
    const lease = catalog.withSourceBlobGcLease(async () => { enterLease(); await release; });
    await entered;
    let writerEntered = false;
    const writer = catalog.withSourceBlobWriterLock(setup!.workspace.id, contentHash, async () => {
      writerEntered = true;
    });
    await Promise.resolve();
    expect(writerEntered).toBe(false);
    releaseLease();
    await lease;
    await writer;
    expect(writerEntered).toBe(true);
  });

  test("probes after 500 candidates and reports resume required when a 501st remains", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-source-blob-gc-cap-"));
    roots.push(root);
    const records = Array.from({ length: 501 }, (_, index): SourceBlobRecord => ({
      id: String(index).padStart(36, "0"), workspaceId: "workspace",
      contentHash: index.toString(16).padStart(64, "0"), generation: 1, byteSize: 1,
      status: "active", storageKey: `blobs/${index}`, fencingToken: null,
      tombstonedAt: null, trashedAt: null, deletedAt: null
    }));
    const pageLimits: number[] = [];
    const leaseCatalog = {
      findSourceBlobGcRunBoundary: async () => ({
        through: { workspaceId: "workspace", contentHash: records.at(-1)!.contentHash, generation: 1, id: records.at(-1)!.id },
        creationCutoff: "2026-07-20T00:00:00.000000Z"
      }),
      listSourceBlobGcCandidates: async (input: { after?: { contentHash: string }; limit?: number }) => {
        pageLimits.push(input.limit!);
        const start = input.after ? records.findIndex((record) => record.contentHash === input.after!.contentHash) + 1 : 0;
        return records.slice(start, start + input.limit!);
      },
      withSourceBlobLock: async (_workspaceId: string, _contentHash: string, operation: (locked: unknown) => Promise<unknown>) =>
        operation({ findById: async () => null })
    };
    const catalog = {
      withSourceBlobGcLease: async (operation: (scoped: typeof leaseCatalog) => Promise<unknown>) => ({
        acquired: true as const, value: await operation(leaseCatalog)
      })
    };

    await expect(new SourceBlobGarbageCollector({ dataDir: root, catalog: catalog as never, enabled: true }).runOnce())
      .resolves.toMatchObject({ scanned: 500, resumeRequired: true, lockBusy: false });
    expect(pageLimits).toEqual([500, 1]);
  });

  test("probes after exactly 500 candidates and clears resume when the tail vanished", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-source-blob-gc-cap-tail-"));
    roots.push(root);
    const records = Array.from({ length: 500 }, (_, index): SourceBlobRecord => ({
      id: String(index).padStart(36, "0"), workspaceId: "workspace",
      contentHash: index.toString(16).padStart(64, "0"), generation: 1, byteSize: 1,
      status: "active", storageKey: `blobs/${index}`, fencingToken: null,
      tombstonedAt: null, trashedAt: null, deletedAt: null
    }));
    const pageLimits: number[] = [];
    const leaseCatalog = {
      findSourceBlobGcRunBoundary: async () => ({
        through: { workspaceId: "workspace", contentHash: records.at(-1)!.contentHash, generation: 1, id: records.at(-1)!.id },
        creationCutoff: "2026-07-20T00:00:00.000000Z"
      }),
      listSourceBlobGcCandidates: async (input: { after?: unknown; limit?: number }) => {
        pageLimits.push(input.limit!);
        return input.after ? [] : records;
      },
      withSourceBlobLock: async (_workspaceId: string, _contentHash: string, operation: (locked: unknown) => Promise<unknown>) =>
        operation({ findById: async () => null })
    };
    const catalog = {
      withSourceBlobGcLease: async (operation: (scoped: typeof leaseCatalog) => Promise<unknown>) => ({
        acquired: true as const, value: await operation(leaseCatalog)
      })
    };

    await expect(new SourceBlobGarbageCollector({ dataDir: root, catalog: catalog as never, enabled: true }).runOnce())
      .resolves.toMatchObject({ scanned: 500, resumeRequired: false });
    expect(pageLimits).toEqual([500, 1]);
  });

  test("freezes creation membership while inserts sort inside the initial tail range on every page", async () => {
    const context = await fixture();
    const makeCandidate = (digit: string): SourceBlobRecord => {
      const contentHash = digit.repeat(64);
      return {
        id: randomUUID(), workspaceId: context.workspaceId, contentHash, generation: 1,
        byteSize: 1, status: "tombstoned",
        storageKey: path.posix.join("blobs", context.workspaceId, digit.repeat(2), contentHash, "1"),
        fencingToken: randomUUID(), tombstonedAt: new Date("2026-07-20T00:00:00.000Z"),
        trashedAt: null, deletedAt: null
      };
    };
    context.catalog.sourceBlobs.push(makeCandidate("a"), makeCandidate("f"));
    const baseCatalog = context.catalog;
    let pageCount = 0;
    const leaseCatalog = {
      findSourceBlobGcRunBoundary: () => baseCatalog.findSourceBlobGcRunBoundary(),
      listSourceBlobGcCandidates: async (
        input: Parameters<typeof baseCatalog.listSourceBlobGcCandidates>[0]
      ) => {
        pageCount += 1;
        if (pageCount > 6) throw new Error("GC_SCAN_DID_NOT_TERMINATE");
        baseCatalog.sourceBlobs.push(makeCandidate(String.fromCharCode("a".charCodeAt(0) + pageCount)));
        return baseCatalog.listSourceBlobGcCandidates(input);
      },
      findSourceBlobById: baseCatalog.findSourceBlobById.bind(baseCatalog),
      withSourceBlobLock: baseCatalog.withSourceBlobLock.bind(baseCatalog)
    };
    const catalog = {
      ...leaseCatalog,
      withSourceBlobGcLease: <T>(operation: (scoped: typeof leaseCatalog) => Promise<T>) =>
        baseCatalog.withSourceBlobGcLease(() => operation(leaseCatalog))
    };

    await expect(context.collector({ catalog: catalog as never, candidateLimit: 1 }).runOnce())
      .resolves.toMatchObject({ scanned: 2, inconsistent: 2 });
    expect(pageCount).toBe(2);
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

  test("continues keyset scanning when the initial through candidate disappears", async () => {
    const context = await fixture();
    await Promise.all([
      context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("vanishing tail one") }),
      context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("vanishing tail two") }),
      context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("vanishing tail three") }),
      context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("vanishing tail four") })
    ]);
    const boundary = await context.catalog.findSourceBlobGcRunBoundary();
    const tail = boundary!.through;
    const tailRecord = context.catalog.sourceBlobs.find((record) => record.id === tail!.id)!;
    const baseCatalog = context.catalog;
    let page = 0;
    const leaseCatalog = {
      findSourceBlobGcRunBoundary: () => baseCatalog.findSourceBlobGcRunBoundary(),
      listSourceBlobGcCandidates: async (input: Parameters<typeof baseCatalog.listSourceBlobGcCandidates>[0]) => {
        page += 1;
        if (page === 2) Object.assign(tailRecord, { status: "deleted" as const, deletedAt: new Date() });
        return baseCatalog.listSourceBlobGcCandidates(input);
      },
      findSourceBlobById: (workspaceId: string, sourceBlobId: string) =>
        baseCatalog.findSourceBlobById(workspaceId, sourceBlobId),
      withSourceBlobLock: baseCatalog.withSourceBlobLock.bind(baseCatalog)
    };
    const catalog = {
      ...leaseCatalog,
      withSourceBlobGcLease: <T>(operation: (scoped: typeof leaseCatalog) => Promise<T>) =>
        baseCatalog.withSourceBlobGcLease(() => operation(leaseCatalog))
    };

    await expect(context.collector({ catalog: catalog as never, candidateLimit: 2 }).runOnce())
      .resolves.toMatchObject({ scanned: 3, tombstoned: 3 });
    expect(context.catalog.sourceBlobs.filter((record) => record.status === "active")).toHaveLength(0);
  });

  test("defers a candidate created beyond the initial through cursor until the next run", async () => {
    const context = await fixture();
    await context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("initial boundary") });
    const baseCatalog = context.catalog;
    const newWorkspaceId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const deferredBytes = Buffer.from("deferred until next GC run");
    const newHash = createHash("sha256").update(deferredBytes).digest("hex");
    const deferred: SourceBlobRecord = {
      id: randomUUID(), workspaceId: newWorkspaceId, contentHash: newHash, generation: 1,
      byteSize: deferredBytes.length, status: "active",
      storageKey: path.posix.join("blobs", newWorkspaceId, newHash.slice(0, 2), newHash, "1"),
      fencingToken: null, tombstonedAt: null, trashedAt: null, deletedAt: null
    };
    let inserted = false;
    const leaseCatalog = {
      findSourceBlobGcRunBoundary: () => baseCatalog.findSourceBlobGcRunBoundary(),
      listSourceBlobGcCandidates: async (input: Parameters<typeof baseCatalog.listSourceBlobGcCandidates>[0]) => {
        const records = await baseCatalog.listSourceBlobGcCandidates(input);
        if (!inserted) {
          inserted = true;
          const deferredPath = sourcePath(context.root, deferred);
          await mkdir(path.dirname(deferredPath), { recursive: true });
          await writeFile(deferredPath, deferredBytes, { mode: 0o444 });
          baseCatalog.sourceBlobs.push(deferred);
        }
        return records;
      },
      findSourceBlobById: (workspaceId: string, sourceBlobId: string) =>
        baseCatalog.findSourceBlobById(workspaceId, sourceBlobId),
      withSourceBlobLock: baseCatalog.withSourceBlobLock.bind(baseCatalog)
    };
    const catalog = {
      ...leaseCatalog,
      withSourceBlobGcLease: <T>(operation: (scoped: typeof leaseCatalog) => Promise<T>) =>
        baseCatalog.withSourceBlobGcLease(() => operation(leaseCatalog))
    };
    const collector = context.collector({ catalog: catalog as never, candidateLimit: 1 });

    await expect(collector.runOnce()).resolves.toMatchObject({ scanned: 1, tombstoned: 1 });
    expect(deferred.status).toBe("active");
    await expect(collector.runOnce()).resolves.toMatchObject({ scanned: 2, tombstoned: 1 });
    expect(deferred.status).toBe("tombstoned");
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

  test.each([
    "storage-key", "parent-symlink", "final-symlink", "writable", "content-mismatch", "size-mismatch"
  ] as const)(
    "audits an active %s artifact before tombstoning and continues later candidates",
    async (artifact) => {
      const context = await fixture();
      const invalid = await context.blobs.put({
        workspaceId: context.workspaceId,
        bytes: Buffer.from(`invalid active ${artifact}`)
      });
      const valid = await context.blobs.put({
        workspaceId: context.workspaceId,
        bytes: Buffer.from(`valid after ${artifact}`)
      });
      const invalidRecord = context.catalog.sourceBlobs.find((record) => record.id === invalid.record.id)!;
      const invalidPath = sourcePath(context.root, invalidRecord);
      if (artifact === "storage-key") {
        invalidRecord.storageKey = path.posix.join("blobs", context.workspaceId, "wrong", "1");
      } else if (artifact === "parent-symlink") {
        const hashDirectory = path.dirname(invalidPath);
        const external = await mkdtemp(path.join(os.tmpdir(), "devkh-active-blob-symlink-"));
        roots.push(external);
        const moved = path.join(external, "hash");
        await rename(hashDirectory, moved);
        await symlink(moved, hashDirectory, "dir");
      } else if (artifact === "final-symlink") {
        const external = await mkdtemp(path.join(os.tmpdir(), "devkh-active-blob-final-symlink-"));
        roots.push(external);
        const externalFile = path.join(external, "generation");
        await writeFile(externalFile, await readFile(invalidPath), { mode: 0o444 });
        await unlink(invalidPath);
        await symlink(externalFile, invalidPath);
      } else if (artifact === "writable") {
        await chmod(invalidPath, 0o644);
      } else if (artifact === "content-mismatch") {
        const original = await readFile(invalidPath);
        await chmod(invalidPath, 0o644);
        await writeFile(invalidPath, Buffer.alloc(original.length, 0x78));
        await chmod(invalidPath, 0o444);
      } else {
        invalidRecord.byteSize += 1;
      }

      await expect(context.collector().runOnce()).resolves.toMatchObject({
        scanned: 2,
        tombstoned: 1,
        inconsistent: 1
      });
      expect(invalidRecord).toMatchObject({ status: "active", fencingToken: null, tombstonedAt: null });
      expect(context.catalog.sourceBlobs.find((record) => record.id === valid.record.id))
        .toMatchObject({ status: "tombstoned", fencingToken: expect.any(String) });
      expect(context.catalog.auditEvents.find((event) => event.resourceId === invalid.record.id))
        .toMatchObject({
          action: "source_blob.gc_inconsistent",
          metadata: { reason: "active_file_inconsistent", status: "active", generation: 1 }
        });
    }
  );

  test.each(["EACCES", "EPERM"] as const)(
    "audits an active blob whose final file open fails with %s and continues the bounded run",
    async (code) => {
      const context = await fixture();
      const inaccessible = await context.blobs.put({
        workspaceId: context.workspaceId,
        bytes: Buffer.from(`inaccessible final ${code}`)
      });
      const valid = await context.blobs.put({
        workspaceId: context.workspaceId,
        bytes: Buffer.from(`valid after final ${code}`)
      });
      const inaccessiblePath = sourcePath(context.root, inaccessible.record);
      const openFile = async (candidate: string, flags: number) => {
        if (candidate === inaccessiblePath) throw Object.assign(new Error("permission denied"), { code });
        return open(candidate, flags);
      };

      await expect(context.collector({ openFile }).runOnce()).resolves.toMatchObject({
        scanned: 2,
        tombstoned: 1,
        inconsistent: 1
      });
      expect(context.catalog.sourceBlobs.find((record) => record.id === inaccessible.record.id))
        .toMatchObject({ status: "active", fencingToken: null });
      expect(context.catalog.sourceBlobs.find((record) => record.id === valid.record.id))
        .toMatchObject({ status: "tombstoned", fencingToken: expect.any(String) });
      expect(context.catalog.auditEvents.find((event) => event.resourceId === inaccessible.record.id))
        .toMatchObject({ metadata: { reason: "active_file_inaccessible" } });
    }
  );

  test.each(["ancestor", "final"] as const)(
    "audits an inaccessible active %s lstat and continues the bounded run",
    async (location) => {
      const context = await fixture();
      const inaccessible = await context.blobs.put({
        workspaceId: context.workspaceId,
        bytes: Buffer.from("inaccessible ancestor")
      });
      const valid = await context.blobs.put({
        workspaceId: context.workspaceId,
        bytes: Buffer.from("valid after ancestor")
      });
      const inaccessiblePath = sourcePath(context.root, inaccessible.record);
      const deniedPath = location === "ancestor" ? path.dirname(inaccessiblePath) : inaccessiblePath;
      const lstatFile = async (candidate: string) => {
        if (candidate === deniedPath) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        return lstat(candidate);
      };

      await expect(context.collector({ lstatFile }).runOnce()).resolves.toMatchObject({
        scanned: 2,
        tombstoned: 1,
        inconsistent: 1
      });
      expect(context.catalog.sourceBlobs.find((record) => record.id === inaccessible.record.id))
        .toMatchObject({ status: "active", fencingToken: null });
      expect(context.catalog.sourceBlobs.find((record) => record.id === valid.record.id))
        .toMatchObject({ status: "tombstoned", fencingToken: expect.any(String) });
      expect(context.catalog.auditEvents.find((event) => event.resourceId === inaccessible.record.id))
        .toMatchObject({ metadata: { reason: "active_file_inaccessible" } });
    }
  );

  test("propagates an unexpected final open failure without auditing it as inaccessible", async () => {
    const context = await fixture();
    const created = await context.blobs.put({
      workspaceId: context.workspaceId,
      bytes: Buffer.from("unexpected final failure")
    });
    const createdPath = sourcePath(context.root, created.record);
    const unexpected = Object.assign(new Error("device failure"), { code: "EIO" });

    await expect(context.collector({
      openFile: async (candidate, flags) => {
        if (candidate === createdPath) throw unexpected;
        return open(candidate, flags);
      }
    }).runOnce()).rejects.toBe(unexpected);
    expect(context.catalog.sourceBlobs[0]).toMatchObject({ status: "active", fencingToken: null });
    expect(context.catalog.auditEvents.some((event) => event.resourceId === created.record.id)).toBe(false);
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

  test.each([".trash", "workspace", "hash"] as const)(
    "rejects a trash %s symlink without moving bytes outside dataDir",
    async (symlinkLevel) => {
      const context = await fixture();
      const created = await context.blobs.put({
        workspaceId: context.workspaceId,
        bytes: Buffer.from(`trash symlink ${symlinkLevel}`)
      });
      await context.collector().runOnce();
      const external = await mkdtemp(path.join(os.tmpdir(), "devkh-source-blob-gc-external-"));
      roots.push(external);
      const trashRoot = path.join(context.root, ".trash");
      const workspaceRoot = path.join(trashRoot, context.workspaceId);
      const hashRoot = path.join(workspaceRoot, created.record.contentHash);
      if (symlinkLevel === ".trash") {
        await symlink(external, trashRoot, "dir");
      } else if (symlinkLevel === "workspace") {
        await mkdir(trashRoot);
        await symlink(external, workspaceRoot, "dir");
      } else {
        await mkdir(workspaceRoot, { recursive: true });
        await symlink(external, hashRoot, "dir");
      }
      context.advance(1_000);

      await expect(context.collector().runOnce()).resolves.toMatchObject({ inconsistent: 1, trashed: 0 });
      expect(context.catalog.sourceBlobs[0]).toMatchObject({ status: "tombstoned" });
      await expect(stat(sourcePath(context.root, created.record))).resolves.toBeDefined();
      await expect(readdir(external)).resolves.toEqual([]);
      expect(context.catalog.auditEvents.at(-1)).toMatchObject({ action: "source_blob.gc_inconsistent" });
    }
  );

  test("rejects a symlinked data directory without creating a trash tree outside it", async () => {
    const context = await fixture();
    const created = await context.blobs.put({
      workspaceId: context.workspaceId,
      bytes: Buffer.from("symlinked data directory")
    });
    await context.collector().runOnce();
    const external = await mkdtemp(path.join(os.tmpdir(), "devkh-source-blob-gc-data-dir-"));
    roots.push(external);
    const movedDataDir = path.join(external, "data");
    await rename(context.root, movedDataDir);
    await symlink(movedDataDir, context.root, "dir");
    context.advance(1_000);

    await expect(context.collector().runOnce()).resolves.toMatchObject({ inconsistent: 1, trashed: 0 });
    expect(context.catalog.sourceBlobs[0]).toMatchObject({ status: "tombstoned" });
    await expect(stat(path.join(movedDataDir, created.record.storageKey))).resolves.toBeDefined();
    expect(await readdir(movedDataDir)).not.toContain(".trash");
    expect(context.catalog.auditEvents.at(-1)).toMatchObject({ action: "source_blob.gc_inconsistent" });
  });

  test("fsyncs every newly created trash directory level before rename", async () => {
    const context = await fixture();
    const created = await context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("ordered trash") });
    await context.collector().runOnce();
    context.advance(1_000);
    const order: string[] = [];
    const trashRoot = path.join(context.root, ".trash");
    const workspaceRoot = path.join(trashRoot, context.workspaceId);
    const hashRoot = path.join(workspaceRoot, created.record.contentHash);
    const collector = context.collector({
      syncDirectory: async (directory) => { order.push(`sync:${directory}`); },
      renameFile: async (source, destination) => {
        order.push("rename");
        await rename(source, destination);
      }
    });

    await expect(collector.runOnce()).resolves.toMatchObject({ trashed: 1 });
    expect(order.slice(0, 5)).toEqual([
      `sync:${context.root}`,
      `sync:${trashRoot}`,
      `sync:${workspaceRoot}`,
      `sync:${hashRoot}`,
      "rename"
    ]);
  });

  test.each([1, 2, 3, 4])(
    "never renames when power is lost at trash directory fsync step %s",
    async (failureStep) => {
      const context = await fixture();
      const created = await context.blobs.put({
        workspaceId: context.workspaceId,
        bytes: Buffer.from(`power loss ${failureStep}`)
      });
      await context.collector().runOnce();
      context.advance(1_000);
      let syncStep = 0;
      const renameFile = vi.fn(async () => undefined);
      const collector = context.collector({
        syncDirectory: async () => {
          syncStep += 1;
          if (syncStep === failureStep) throw new Error("POWER_LOSS");
        },
        renameFile
      });

      await expect(collector.runOnce()).rejects.toThrow("POWER_LOSS");
      expect(renameFile).not.toHaveBeenCalled();
      expect(context.catalog.sourceBlobs[0]).toMatchObject({ status: "tombstoned" });
      await expect(stat(sourcePath(context.root, created.record))).resolves.toBeDefined();
    }
  );

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

  test("audits rename access denial, continues later candidates, and retries with the same fence", async () => {
    const context = await fixture();
    const inaccessible = await context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("rename denied") });
    const valid = await context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("rename allowed") });
    await context.collector().runOnce();
    const fence = context.catalog.sourceBlobs.find((record) => record.id === inaccessible.record.id)!.fencingToken;
    context.advance(1_000);
    const inaccessiblePath = sourcePath(context.root, inaccessible.record);

    await expect(context.collector({
      renameFile: async (source, destination) => {
        if (source === inaccessiblePath) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        await rename(source, destination);
      }
    }).runOnce()).resolves.toMatchObject({ scanned: 2, trashed: 1, inconsistent: 1 });
    expect(context.catalog.sourceBlobs.find((record) => record.id === inaccessible.record.id))
      .toMatchObject({ status: "tombstoned", fencingToken: fence });
    expect(context.catalog.sourceBlobs.find((record) => record.id === valid.record.id))
      .toMatchObject({ status: "trash" });
    expect(context.catalog.auditEvents.find((event) => event.resourceId === inaccessible.record.id))
      .toMatchObject({ metadata: { reason: "rename_inaccessible" } });

    await expect(context.collector().runOnce()).resolves.toMatchObject({ trashed: 1 });
    expect(context.catalog.sourceBlobs.find((record) => record.id === inaccessible.record.id))
      .toMatchObject({ status: "trash", fencingToken: fence });
  });

  test("reconciles a moved tombstone after directory fsync access denial without changing its fence", async () => {
    const context = await fixture();
    const created = await context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("move sync denied") });
    await context.collector().runOnce();
    const fence = context.catalog.sourceBlobs[0]!.fencingToken;
    const original = sourcePath(context.root, created.record);
    const trash = trashPath(context.root, created.record);
    await mkdir(path.dirname(trash), { recursive: true });
    context.advance(1_000);

    await expect(context.collector({
      syncDirectory: async (directory) => {
        if (directory === path.dirname(original)) {
          throw Object.assign(new Error("permission denied"), { code: "EPERM" });
        }
      }
    }).runOnce()).resolves.toMatchObject({ trashed: 0, inconsistent: 1 });
    expect(context.catalog.sourceBlobs[0]).toMatchObject({ status: "tombstoned", fencingToken: fence });
    await expectMissing(original);
    await expect(stat(trash)).resolves.toBeDefined();
    expect(context.catalog.auditEvents.at(-1)).toMatchObject({ metadata: { reason: "directory_sync_inaccessible" } });

    await expect(context.collector().runOnce()).resolves.toMatchObject({ trashed: 1 });
    expect(context.catalog.sourceBlobs[0]).toMatchObject({ status: "trash", fencingToken: fence });
  });

  test("audits unlink access denial, continues later candidates, and retries deletion with the same fence", async () => {
    const context = await fixture();
    const inaccessible = await context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("unlink denied") });
    const valid = await context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("unlink allowed") });
    await context.collector().runOnce();
    context.advance(1_000);
    await context.collector().runOnce();
    const fence = context.catalog.sourceBlobs.find((record) => record.id === inaccessible.record.id)!.fencingToken;
    context.advance(2_000);
    const inaccessibleTrash = trashPath(context.root, inaccessible.record);

    await expect(context.collector({
      unlinkFile: async (candidate) => {
        if (candidate === inaccessibleTrash) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        await unlink(candidate);
      }
    }).runOnce()).resolves.toMatchObject({ scanned: 2, deleted: 1, inconsistent: 1 });
    expect(context.catalog.sourceBlobs.find((record) => record.id === inaccessible.record.id))
      .toMatchObject({ status: "trash", fencingToken: fence });
    expect(context.catalog.sourceBlobs.find((record) => record.id === valid.record.id))
      .toMatchObject({ status: "deleted" });
    await expect(stat(inaccessibleTrash)).resolves.toBeDefined();
    expect(context.catalog.auditEvents.find((event) => event.resourceId === inaccessible.record.id))
      .toMatchObject({ metadata: { reason: "unlink_inaccessible" } });

    await expect(context.collector().runOnce()).resolves.toMatchObject({ deleted: 1 });
    expect(context.catalog.sourceBlobs.find((record) => record.id === inaccessible.record.id))
      .toMatchObject({ status: "deleted", fencingToken: fence });
  });

  test("reconciles a physically deleted trash file after directory fsync access denial", async () => {
    const context = await fixture();
    const created = await context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("delete sync denied") });
    await context.collector().runOnce();
    context.advance(1_000);
    await context.collector().runOnce();
    const fence = context.catalog.sourceBlobs[0]!.fencingToken;
    const trash = trashPath(context.root, created.record);
    context.advance(2_000);

    await expect(context.collector({
      syncDirectory: async (directory) => {
        if (directory === path.dirname(trash)) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
      }
    }).runOnce()).resolves.toMatchObject({ deleted: 0, inconsistent: 1 });
    expect(context.catalog.sourceBlobs[0]).toMatchObject({ status: "trash", fencingToken: fence });
    await expectMissing(trash);
    expect(context.catalog.auditEvents.at(-1)).toMatchObject({ metadata: { reason: "directory_sync_inaccessible" } });

    await expect(context.collector().runOnce()).resolves.toMatchObject({ deleted: 1 });
    expect(context.catalog.sourceBlobs[0]).toMatchObject({ status: "deleted", fencingToken: fence });
  });

  test("propagates an unexpected rename error without auditing it", async () => {
    const context = await fixture();
    const created = await context.blobs.put({ workspaceId: context.workspaceId, bytes: Buffer.from("rename eio") });
    await context.collector().runOnce();
    context.advance(1_000);
    const unexpected = Object.assign(new Error("device failure"), { code: "EIO" });

    await expect(context.collector({ renameFile: async () => { throw unexpected; } }).runOnce())
      .rejects.toBe(unexpected);
    expect(context.catalog.sourceBlobs[0]).toMatchObject({ status: "tombstoned" });
    expect(context.catalog.auditEvents.some((event) => event.resourceId === created.record.id)).toBe(false);
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
    const leaseCatalog = {
      findSourceBlobGcRunBoundary: () => baseCatalog.findSourceBlobGcRunBoundary(),
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
    const catalog = {
      ...leaseCatalog,
      withSourceBlobGcLease: <T>(operation: (scoped: typeof leaseCatalog) => Promise<T>) =>
        baseCatalog.withSourceBlobGcLease(() => operation(leaseCatalog))
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
