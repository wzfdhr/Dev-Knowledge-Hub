import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBackfillConfig, runBackfill } from "./backfill-source-blobs.mjs";

const roots = [];

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function id(seed) {
  return `00000000-0000-4000-8000-${String(seed).padStart(12, "0")}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function removeReadOnlyTree(directory) {
  await chmod(directory, 0o700).catch(() => undefined);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) =>
    removeReadOnlyTree(path.join(directory, entry.name))
  ));
  await rm(directory, { recursive: true, force: true });
}

class FakePool {
  constructor({ snapshots, files, blobs = [], releases = [] }) {
    this.snapshots = snapshots;
    this.files = files;
    this.blobs = blobs;
    this.releases = releases;
    this.transactionSnapshot = undefined;
    this.queries = [];
  }

  async query(text, values = []) {
    this.queries.push({ text, values });
    if (text === "BEGIN") {
      this.transactionSnapshot = clone({ snapshots: this.snapshots, files: this.files, blobs: this.blobs });
      return { rows: [] };
    }
    if (text === "COMMIT") {
      this.transactionSnapshot = undefined;
      return { rows: [] };
    }
    if (text === "ROLLBACK") {
      if (this.transactionSnapshot) Object.assign(this, this.transactionSnapshot);
      this.transactionSnapshot = undefined;
      return { rows: [] };
    }
    if (text.includes("pg_advisory_xact_lock")) return { rows: [{ locked: true }] };
    if (text.includes("FROM source_snapshots snapshot") && text.includes("ORDER BY snapshot.workspace_id")) {
      const [workspaceCursor, snapshotCursor, viewRoot, limit] = values;
      const rows = this.snapshots
        .filter((snapshot) => {
          const cursorAfter = snapshot.workspace_id > workspaceCursor
            || (snapshot.workspace_id === workspaceCursor && snapshot.id > snapshotCursor);
          const expected = path.join(viewRoot, "snapshots", snapshot.id, "files");
          return cursorAfter && (snapshot.storage_path !== expected || this.files.some((file) =>
            file.workspace_id === snapshot.workspace_id && file.snapshot_id === snapshot.id && file.source_blob_id === null
          ));
        })
        .sort((left, right) => left.workspace_id.localeCompare(right.workspace_id) || left.id.localeCompare(right.id))
        .slice(0, limit)
        .map(({ id: snapshot_id, workspace_id, storage_path }) => ({ snapshot_id, workspace_id, storage_path }));
      return { rows };
    }
    if (text.includes("FROM source_files file") && text.includes("ORDER BY file.path")) {
      const [snapshotId, workspaceId] = values;
      return { rows: this.files
        .filter((file) => file.snapshot_id === snapshotId && file.workspace_id === workspaceId)
        .sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id))
        .map((file) => ({ ...file })) };
    }
    if (text.includes("FROM source_blobs") && text.includes("status = 'active'")) {
      const [workspaceId, contentHash] = values;
      return { rows: this.blobs.filter((blob) => blob.workspace_id === workspaceId
        && blob.content_hash === contentHash && blob.status === "active").map((blob) => ({ ...blob })) };
    }
    if (text.includes("MAX(generation)")) {
      const [workspaceId, contentHash] = values;
      const generation = Math.max(0, ...this.blobs.filter((blob) => blob.workspace_id === workspaceId
        && blob.content_hash === contentHash).map((blob) => blob.generation)) + 1;
      return { rows: [{ generation }] };
    }
    if (text.includes("INSERT INTO source_blobs")) {
      const [workspace_id, content_hash, generation, byte_size, storage_key] = values;
      const blob = { id: randomUUID(), workspace_id, content_hash, generation, byte_size, storage_key, status: "active" };
      this.blobs.push(blob);
      return { rows: [{ ...blob }] };
    }
    if (text.includes("SELECT file.id, file.source_blob_id") && text.includes("FROM source_files file")) {
      const [snapshotId, workspaceId] = values;
      return { rows: this.files.filter((file) => file.snapshot_id === snapshotId && file.workspace_id === workspaceId)
        .map(({ id: file_id, source_blob_id }) => ({ file_id, source_blob_id })) };
    }
    if (text.includes("UPDATE source_files") && text.includes("source_blob_id IS NULL")) {
      const [blobId, fileId, workspaceId, snapshotId] = values;
      const file = this.files.find((candidate) => candidate.id === fileId && candidate.workspace_id === workspaceId
        && candidate.snapshot_id === snapshotId && candidate.source_blob_id === null);
      if (!file) return { rows: [] };
      file.source_blob_id = blobId;
      return { rows: [{ source_blob_id: blobId }] };
    }
    if (text.includes("UPDATE source_snapshots") && text.includes("storage_path")) {
      const [storagePath, snapshotId, workspaceId, oldPath, newPath] = values;
      const snapshot = this.snapshots.find((candidate) => candidate.id === snapshotId && candidate.workspace_id === workspaceId
        && (candidate.storage_path === oldPath || candidate.storage_path === newPath));
      if (!snapshot) return { rows: [] };
      snapshot.storage_path = storagePath;
      return { rows: [{ id: snapshot.id }] };
    }
    throw new Error(`Unexpected query: ${text}`);
  }

  async end() {}
}

async function fixture({ snapshotCount = 1, filesPerSnapshot = 1, batchSize = 500 } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devkh-source-blob-backfill-"));
  roots.push(dataDir);
  const snapshotData = path.join(dataDir, "snapshots");
  const workspaceId = id(1);
  const snapshots = [];
  const files = [];
  for (let snapshotIndex = 0; snapshotIndex < snapshotCount; snapshotIndex += 1) {
    const snapshotId = id(snapshotIndex + 10);
    const legacy = path.join(snapshotData, snapshotId, "files");
    await mkdir(path.join(legacy, "src"), { recursive: true });
    snapshots.push({ id: snapshotId, workspace_id: workspaceId, storage_path: legacy });
    for (let fileIndex = 0; fileIndex < filesPerSnapshot; fileIndex += 1) {
      const relativePath = `src/${snapshotIndex}-${fileIndex}.ts`;
      const bytes = Buffer.from(`export const value${snapshotIndex}_${fileIndex} = true;\n`);
      await writeFile(path.join(legacy, relativePath), bytes);
      files.push({
        id: id(1_000 + snapshotIndex * 100 + fileIndex), workspace_id: workspaceId, snapshot_id: snapshotId,
        path: relativePath, content_hash: hash(bytes), byte_size: bytes.length, source_blob_id: null
      });
    }
  }
  return {
    dataDir, snapshotData, snapshots, files, batchSize,
    pool: new FakePool({ snapshots, files, releases: [{ id: id(9_999), marker: "unchanged" }] })
  };
}

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeReadOnlyTree(root)));
});

test("uses a safe positive snapshot batch limit and requires DATABASE_URL", () => {
  assert.equal(createBackfillConfig({ DATABASE_URL: "postgres://test", DEVKH_SOURCE_BLOB_BACKFILL_BATCH_SIZE: "" }).batchSize, 500);
  assert.equal(createBackfillConfig({ DATABASE_URL: "postgres://test", DEVKH_SOURCE_BLOB_BACKFILL_BATCH_SIZE: "2" }).batchSize, 2);
  assert.throws(() => createBackfillConfig({}), /DATABASE_URL is required/);
  for (const invalid of ["0", "-1", "1.5", "NaN", "9007199254740992"]) {
    assert.throws(() => createBackfillConfig({ DATABASE_URL: "postgres://test", DEVKH_SOURCE_BLOB_BACKFILL_BATCH_SIZE: invalid }), /positive safe integer/);
  }
});

test("processes snapshots in bounded batches and leaves releases unchanged", async () => {
  const context = await fixture({ snapshotCount: 2, batchSize: 1 });
  const releasesBefore = clone(context.pool.releases);

  const report = await runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: context.batchSize });

  assert.equal(report.processed, 2);
  assert.equal(report.created, 2);
  assert.deepEqual(report.lastCursor, { workspaceId: context.snapshots[1].workspace_id, snapshotId: context.snapshots[1].id });
  assert.deepEqual(context.pool.releases, releasesBefore);
  assert.equal(context.pool.queries.filter(({ text }) => text.includes("FROM source_snapshots snapshot")).length, 3);
});

test("is idempotent, reports zero on a repeat run, and atomically switches storage_path", async () => {
  const context = await fixture({ filesPerSnapshot: 2 });
  const originalPath = context.snapshots[0].storage_path;
  const first = await runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 500 });
  const view = path.join(context.snapshotData, "snapshots", context.snapshots[0].id, "files");
  const reportPath = path.join(context.dataDir, "reports", "source-blob-backfill.json");

  assert.equal(first.processed, 1);
  assert.equal(context.snapshots[0].storage_path, view);
  assert.notEqual(context.snapshots[0].storage_path, originalPath);
  assert.ok(context.files.every((file) => file.source_blob_id));
  assert.equal((await lstat(reportPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), first);
  for (const file of context.files) {
    const blob = context.pool.blobs.find((candidate) => candidate.id === file.source_blob_id);
    const [blobStat, viewStat] = await Promise.all([
      lstat(path.join(context.snapshotData, blob.storage_key)),
      lstat(path.join(view, file.path))
    ]);
    assert.equal(viewStat.dev, blobStat.dev);
    assert.equal(viewStat.ino, blobStat.ino);
  }
  const second = await runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 500 });
  assert.equal(second.processed, 0);
  assert.equal(second.reused, 0);
  assert.equal(second.created, 0);
});

test("rejects an invalid file without partially binding its multi-file snapshot", async () => {
  const context = await fixture({ filesPerSnapshot: 2 });
  context.files[1].content_hash = "0".repeat(64);

  await assert.rejects(runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 500 }), /hash mismatch/);

  assert.ok(context.files.every((file) => file.source_blob_id === null));
  assert.equal(context.snapshots[0].storage_path, path.join(context.snapshotData, context.snapshots[0].id, "files"));
});

test("rejects size mismatch, path escape, and symbolic-link source files", async (t) => {
  await t.test("size mismatch", async () => {
    const context = await fixture();
    context.files[0].byte_size += 1;
    await assert.rejects(runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 500 }), /size mismatch/);
  });
  await t.test("path escape", async () => {
    const context = await fixture();
    context.files[0].path = "../outside.ts";
    await assert.rejects(runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 500 }), /unsafe source file path/);
  });
  await t.test("symbolic link", async () => {
    const context = await fixture();
    const source = path.join(context.snapshots[0].storage_path, context.files[0].path);
    const outside = path.join(context.dataDir, "outside.ts");
    await writeFile(outside, "outside\n");
    await rm(source);
    await symlink(outside, source);
    await assert.rejects(runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 500 }), /not a regular file/);
  });
});

test("reuses only a verified active blob and increments the generation after inactive history", async () => {
  const context = await fixture();
  const source = context.files[0];
  const activeKey = path.posix.join("blobs", source.workspace_id, source.content_hash.slice(0, 2), source.content_hash, "1");
  const activePath = path.join(context.snapshotData, activeKey);
  await mkdir(path.dirname(activePath), { recursive: true });
  await writeFile(activePath, await readFile(path.join(context.snapshots[0].storage_path, source.path)));
  await chmod(activePath, 0o444);
  context.pool.blobs.push({ id: id(800), workspace_id: source.workspace_id, content_hash: source.content_hash,
    generation: 1, byte_size: source.byte_size, storage_key: activeKey, status: "active" });

  const reused = await runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 500 });
  assert.equal(reused.reused, 1);
  assert.equal(reused.created, 0);

  const second = await fixture();
  const stale = second.files[0];
  second.pool.blobs.push({ id: id(801), workspace_id: stale.workspace_id, content_hash: stale.content_hash,
    generation: 1, byte_size: stale.byte_size, storage_key: "untrusted", status: "deleted" });
  const created = await runBackfill({ pool: second.pool, dataDir: second.dataDir, batchSize: 500 });
  assert.equal(created.created, 1);
  assert.equal(second.pool.blobs.find((blob) => blob.status === "active").generation, 2);
});
