import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Pool } from "pg";

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
  constructor({ snapshots, files, blobs = [], releases = [], tombstoneBeforeBinding = false }) {
    this.snapshots = snapshots;
    this.files = files;
    this.blobs = blobs;
    this.releases = releases;
    this.transactionSnapshot = undefined;
    this.queries = [];
    this.tombstoneBeforeBinding = tombstoneBeforeBinding;
    this.transactionCount = 0;
    this.audits = [];
    this.storageSwitchBeforeSnapshotLock = null;
    this.sourceFileMutationBeforeLock = null;
  }

  async query(text, values = []) {
    this.queries.push({ text, values });
    if (text === "BEGIN") {
      this.transactionCount += 1;
      this.transactionSnapshot = clone({ snapshots: this.snapshots, files: this.files, blobs: this.blobs, audits: this.audits });
      if (this.tombstoneBeforeBinding && this.transactionCount === this.files.length + 1) {
        this.blobs.forEach((blob) => { blob.status = "tombstoned"; });
        this.transactionSnapshot.blobs.forEach((blob) => { blob.status = "tombstoned"; });
        this.tombstoneBeforeBinding = false;
      }
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
    if (text.includes("source_blob.snapshot_backfilled") && text.includes("checkpoint_complete")) {
      return { rows: this.audits
        .filter((audit) => audit.action === "source_blob.snapshot_backfilled")
        .filter((audit) => text.includes("LEFT JOIN source_snapshots") || this.snapshots.some((snapshot) =>
          snapshot.workspace_id === audit.workspace_id && snapshot.id === audit.resource_id))
        .sort((left, right) => left.workspace_id.localeCompare(right.workspace_id)
          || left.resource_id.localeCompare(right.resource_id))
        .map((audit) => {
          const snapshot = this.snapshots.find((candidate) => candidate.workspace_id === audit.workspace_id
            && candidate.id === audit.resource_id);
          const complete = Boolean(snapshot)
            && !this.files.some((file) => file.workspace_id === audit.workspace_id
              && file.snapshot_id === audit.resource_id && file.source_blob_id === null)
            && this.files.filter((file) => file.workspace_id === audit.workspace_id
              && file.snapshot_id === audit.resource_id).every((file) => {
              const blob = this.blobs.find((candidate) => candidate.id === file.source_blob_id);
              return blob?.status === "active" && blob.workspace_id === file.workspace_id
                && blob.content_hash === file.content_hash && Number(blob.byte_size) === Number(file.byte_size);
            });
          return {
            workspace_id: audit.workspace_id,
            snapshot_id: audit.resource_id,
            metadata: audit.metadata,
            storage_path: snapshot?.storage_path,
            checkpoint_complete: complete
          };
        }) };
    }
    if (text.includes("FROM source_snapshots snapshot") && text.includes("ORDER BY snapshot.workspace_id")) {
      const [workspaceCursor, snapshotCursor, viewRoot, limit] = values;
      const rows = this.snapshots
        .filter((snapshot) => {
          const cursorAfter = workspaceCursor === null || snapshot.workspace_id > workspaceCursor
            || (snapshot.workspace_id === workspaceCursor && snapshot.id > snapshotCursor);
          const expected = path.join(viewRoot, "snapshots", snapshot.id, "files");
          return cursorAfter && (snapshot.storage_path !== expected || this.files.some((file) =>
            file.workspace_id === snapshot.workspace_id && file.snapshot_id === snapshot.id && file.source_blob_id === null
          ));
        })
        .sort((left, right) => left.workspace_id.localeCompare(right.workspace_id) || left.id.localeCompare(right.id))
        .slice(0, limit)
        .map(({ id: snapshot_id, workspace_id, storage_path, repository_id, project_id }) => ({
          snapshot_id, workspace_id, storage_path, repository_id, project_id
        }));
      return { rows };
    }
    if (text.includes("FROM source_files file") && text.includes("ORDER BY file.path") && !text.includes("FOR UPDATE")) {
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
    if (text.includes("FROM source_blobs") && text.includes("'tombstoned'")) {
      const [workspaceId, contentHash] = values;
      return { rows: this.blobs.filter((blob) => blob.workspace_id === workspaceId
        && blob.content_hash === contentHash && ["active", "tombstoned"].includes(blob.status)).map((blob) => ({ ...blob })) };
    }
    if (text.includes("jsonb_to_recordset") && text.includes("FROM source_blobs blob")) {
      const expected = JSON.parse(values[0]);
      return { rows: expected.flatMap((candidate) => this.blobs.filter((blob) => blob.id === candidate.id
        && blob.workspace_id === candidate.workspace_id && blob.content_hash === candidate.content_hash
        && blob.generation === candidate.generation && Number(blob.byte_size) === candidate.byte_size
      ).map((blob) => ({ ...blob }))) };
    }
    if (text.includes("MAX(generation)")) {
      const [workspaceId, contentHash] = values;
      const generation = Math.max(0, ...this.blobs.filter((blob) => blob.workspace_id === workspaceId
        && blob.content_hash === contentHash).map((blob) => blob.generation)) + 1;
      return { rows: [{ generation }] };
    }
    if (text.includes("COUNT(*)") && text.includes("source_blob_id")) {
      const [blobId] = values;
      return { rows: [{ reference_count: String(this.files.filter((file) => file.source_blob_id === blobId).length) }] };
    }
    if (text.includes("INSERT INTO source_blobs")) {
      const [workspace_id, content_hash, generation, byte_size, storage_key] = values;
      const blob = { id: randomUUID(), workspace_id, content_hash, generation, byte_size, storage_key, status: "active" };
      this.blobs.push(blob);
      return { rows: [{ ...blob }] };
    }
    if (text.includes("SET status = 'active'") && text.includes("fencing_token")) {
      const [workspaceId, contentHash, blobId, fencingToken] = values;
      const blob = this.blobs.find((candidate) => candidate.workspace_id === workspaceId
        && candidate.content_hash === contentHash && candidate.id === blobId
        && candidate.status === "tombstoned" && candidate.fencing_token === fencingToken);
      if (!blob) return { rows: [] };
      Object.assign(blob, { status: "active", fencing_token: null, tombstoned_at: null, trashed_at: null });
      return { rows: [{ ...blob }] };
    }
    if (text.includes("SET status = 'trash'") && text.includes("fencing_token")) {
      const [workspaceId, contentHash, blobId, fencingToken] = values;
      const blob = this.blobs.find((candidate) => candidate.workspace_id === workspaceId
        && candidate.content_hash === contentHash && candidate.id === blobId
        && candidate.status === "tombstoned" && candidate.fencing_token === fencingToken);
      if (!blob) return { rows: [] };
      Object.assign(blob, { status: "trash", trashed_at: new Date().toISOString() });
      return { rows: [{ ...blob }] };
    }
    if (text.includes("FROM audit_events") && text.includes("source_blob.snapshot_backfilled")) {
      const [workspaceId, snapshotId] = values;
      return { rows: this.audits.filter((audit) => audit.workspace_id === workspaceId
        && audit.resource_id === snapshotId && audit.action === "source_blob.snapshot_backfilled").map((audit) => ({ ...audit })) };
    }
    if (text.includes("INSERT INTO audit_events")) {
      const action = text.match(/'([^']+)'\s*,\s*'([^']+)'/)?.[1];
      const resourceType = text.match(/'([^']+)'\s*,\s*'([^']+)'/)?.[2];
      this.audits.push({
        workspace_id: values[0], action, resource_type: resourceType,
        resource_id: values[1], metadata: JSON.parse(values[2])
      });
      return { rows: [] };
    }
    if (text.includes("FROM source_snapshots") && text.includes("FOR UPDATE")) {
      const [snapshotId, workspaceId] = values;
      if (this.storageSwitchBeforeSnapshotLock) {
        const snapshot = this.snapshots.find((candidate) => candidate.id === snapshotId
          && candidate.workspace_id === workspaceId);
        snapshot.storage_path = this.storageSwitchBeforeSnapshotLock;
        this.storageSwitchBeforeSnapshotLock = null;
      }
      const snapshot = this.snapshots.find((candidate) => candidate.id === snapshotId
        && candidate.workspace_id === workspaceId);
      return { rows: snapshot ? [{ ...snapshot }] : [] };
    }
    if (text.includes("FROM source_files file") && text.includes("FOR UPDATE")) {
      const [snapshotId, workspaceId] = values;
      if (this.sourceFileMutationBeforeLock) {
        const file = this.files.find((candidate) => candidate.snapshot_id === snapshotId
          && candidate.workspace_id === workspaceId);
        this.sourceFileMutationBeforeLock(file);
        this.sourceFileMutationBeforeLock = null;
      }
      return { rows: this.files.filter((file) => file.snapshot_id === snapshotId && file.workspace_id === workspaceId)
        .map((file) => ({ ...file })) };
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
    snapshots.push({
      id: snapshotId, workspace_id: workspaceId, storage_path: legacy,
      repository_id: id(100 + snapshotIndex), project_id: id(200 + snapshotIndex)
    });
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

async function seedBlobFile(context, source, { generation = 1, location = "source", status = "active" } = {}) {
  const storageKey = path.posix.join("blobs", source.workspace_id, source.content_hash.slice(0, 2), source.content_hash, String(generation));
  const blobPath = location === "trash"
    ? path.join(context.snapshotData, ".trash", source.workspace_id, source.content_hash, String(generation))
    : path.join(context.snapshotData, storageKey);
  await mkdir(path.dirname(blobPath), { recursive: true });
  await writeFile(blobPath, await readFile(path.join(context.snapshots[0].storage_path, source.path)));
  await chmod(blobPath, 0o444);
  const blob = {
    id: id(800 + generation), workspace_id: source.workspace_id, content_hash: source.content_hash,
    generation, byte_size: source.byte_size, storage_key: storageKey, status,
    fencing_token: status === "active" ? null : id(900 + generation),
    tombstoned_at: status === "active" ? null : new Date().toISOString(),
    trashed_at: status === "trash" ? new Date().toISOString() : null
  };
  context.pool.blobs.push(blob);
  return { blob, blobPath };
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
  const snapshotQueries = context.pool.queries.filter(({ text }) => text.includes("FROM source_snapshots snapshot")
    && text.includes("ORDER BY snapshot.workspace_id"));
  assert.equal(snapshotQueries.length, 3);
  assert.deepEqual(snapshotQueries[0].values.slice(0, 2), [null, null]);
  assert.match(snapshotQueries[0].text, /\$1::uuid IS NULL/);
  const lockQueries = context.pool.queries.filter(({ text }) => text.includes("pg_advisory_xact_lock"));
  assert.ok(lockQueries.length >= 2);
  assert.ok(lockQueries.every(({ text }) => text === "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))"));
});

test("is idempotent, preserves cumulative checkpoint state, and atomically switches storage_path", async () => {
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
  const bindLockCalls = context.pool.queries
    .filter(({ text }) => text.includes("pg_advisory_xact_lock"))
    .slice(-context.files.length)
    .map(({ values }) => values);
  assert.deepEqual(bindLockCalls, context.files
    .map((file) => [file.workspace_id, file.content_hash])
    .sort(([leftWorkspace, leftHash], [rightWorkspace, rightHash]) => leftWorkspace.localeCompare(rightWorkspace)
      || leftHash.localeCompare(rightHash)));
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
  assert.equal(second.processed, first.processed);
  assert.equal(second.reused, 0);
  assert.equal(second.created, first.created);
  assert.deepEqual(second.lastCursor, first.lastCursor);
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

test("restores a verified tombstoned source generation and reuses it", async () => {
  const context = await fixture();
  const seeded = await seedBlobFile(context, context.files[0], { status: "tombstoned" });

  const report = await runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 500 });

  assert.equal(report.reused, 1);
  assert.equal(report.created, 0);
  assert.equal(seeded.blob.status, "active");
  assert.equal(context.files[0].source_blob_id, seeded.blob.id);
});

test("reconciles a tombstoned generation already moved to trash before creating the next generation", async () => {
  const context = await fixture();
  const seeded = await seedBlobFile(context, context.files[0], { status: "tombstoned", location: "trash" });

  const report = await runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 500 });

  assert.equal(report.created, 1);
  assert.equal(seeded.blob.status, "trash");
  assert.equal(context.pool.blobs.find((blob) => blob.status === "active").generation, 2);
});

test("audits and refuses a moved tombstone that is still referenced", async () => {
  const context = await fixture();
  const seeded = await seedBlobFile(context, context.files[0], { status: "tombstoned", location: "trash" });
  context.files[0].source_blob_id = seeded.blob.id;

  await assert.rejects(
    runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 500 }),
    /still referenced/
  );

  assert.equal(seeded.blob.status, "tombstoned");
  assert.equal(context.pool.blobs.length, 1);
  assert.ok(context.pool.audits.some((audit) => audit.action === "source_blob.gc_inconsistent"
    && audit.metadata.reason === "tombstoned_blob_still_referenced"));
});

test("creates the next generation when a prior generation is already trash", async () => {
  const context = await fixture();
  await seedBlobFile(context, context.files[0], { status: "trash", location: "trash" });

  await runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 500 });

  assert.equal(context.pool.blobs.find((blob) => blob.status === "active").generation, 2);
});

test("audits and stops on an inconsistent tombstone location", async () => {
  const context = await fixture();
  const seeded = await seedBlobFile(context, context.files[0], { status: "tombstoned" });
  const trashPath = path.join(context.snapshotData, ".trash", seeded.blob.workspace_id,
    seeded.blob.content_hash, String(seeded.blob.generation));
  await mkdir(path.dirname(trashPath), { recursive: true });
  await writeFile(trashPath, await readFile(seeded.blobPath));
  await chmod(trashPath, 0o444);

  await assert.rejects(
    runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 500 }),
    /location is inconsistent/
  );
  assert.equal(context.pool.audits.length, 1);
  assert.equal(context.files[0].source_blob_id, null);
});

test("replaces only a read-only mismatched orphan view while the database still points at legacy", async () => {
  const context = await fixture();
  const seeded = await seedBlobFile(context, context.files[0]);
  const orphanView = path.join(context.snapshotData, "snapshots", context.snapshots[0].id, "files");
  const orphanFile = path.join(orphanView, context.files[0].path);
  await mkdir(path.dirname(orphanFile), { recursive: true });
  await writeFile(orphanFile, await readFile(seeded.blobPath));
  await chmod(orphanFile, 0o444);
  await chmod(path.dirname(orphanFile), 0o555);
  await chmod(orphanView, 0o555);
  await chmod(path.dirname(orphanView), 0o555);

  await runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 500 });

  const [blobStat, viewStat] = await Promise.all([lstat(seeded.blobPath), lstat(orphanFile)]);
  assert.equal(viewStat.ino, blobStat.ino);
  assert.equal(viewStat.dev, blobStat.dev);
});

test("recovers a durably quarantined orphan view after a crash", async () => {
  const context = await fixture();
  const seeded = await seedBlobFile(context, context.files[0]);
  const viewRoot = path.join(context.snapshotData, "snapshots");
  const snapshotRoot = path.join(viewRoot, context.snapshots[0].id);
  const orphanFile = path.join(snapshotRoot, "files", context.files[0].path);
  const quarantine = path.join(viewRoot, `.orphan-${context.snapshots[0].id}`);
  await mkdir(path.dirname(orphanFile), { recursive: true });
  await writeFile(orphanFile, "stale\n");
  await chmod(orphanFile, 0o444);
  await chmod(path.dirname(orphanFile), 0o555);
  await chmod(path.join(snapshotRoot, "files"), 0o555);
  await chmod(snapshotRoot, 0o555);

  await assert.rejects(runBackfill({
    pool: context.pool,
    dataDir: context.dataDir,
    observer: (event) => {
      if (event.type === "view-quarantine-fsync") throw new Error("crash after quarantine");
    }
  }), /crash after quarantine/);
  await assert.rejects(lstat(snapshotRoot), { code: "ENOENT" });
  assert.ok((await lstat(quarantine)).isDirectory());

  await runBackfill({ pool: context.pool, dataDir: context.dataDir });

  const [blobStat, viewStat] = await Promise.all([lstat(seeded.blobPath), lstat(orphanFile)]);
  assert.equal(viewStat.dev, blobStat.dev);
  assert.equal(viewStat.ino, blobStat.ino);
  await assert.rejects(lstat(quarantine), { code: "ENOENT" });
});

test("adopts a published view and clears quarantine after a publication crash", async () => {
  const context = await fixture();
  const seeded = await seedBlobFile(context, context.files[0]);
  const viewRoot = path.join(context.snapshotData, "snapshots");
  const snapshotRoot = path.join(viewRoot, context.snapshots[0].id);
  const orphanFile = path.join(snapshotRoot, "files", context.files[0].path);
  const quarantine = path.join(viewRoot, `.orphan-${context.snapshots[0].id}`);
  await mkdir(path.dirname(orphanFile), { recursive: true });
  await writeFile(orphanFile, "stale\n");
  await chmod(orphanFile, 0o444);
  await chmod(path.dirname(orphanFile), 0o555);
  await chmod(path.join(snapshotRoot, "files"), 0o555);
  await chmod(snapshotRoot, 0o555);

  await assert.rejects(runBackfill({
    pool: context.pool,
    dataDir: context.dataDir,
    observer: (event) => {
      if (event.type === "view-rename") throw new Error("crash during publication");
    }
  }), /crash during publication/);
  assert.ok((await lstat(quarantine)).isDirectory());

  await runBackfill({ pool: context.pool, dataDir: context.dataDir });

  const [blobStat, viewStat] = await Promise.all([lstat(seeded.blobPath), lstat(orphanFile)]);
  assert.equal(viewStat.dev, blobStat.dev);
  assert.equal(viewStat.ino, blobStat.ino);
  await assert.rejects(lstat(quarantine), { code: "ENOENT" });
});

test("does not delete an orphan view when a concurrent transaction switches snapshot storage", async () => {
  const context = await fixture();
  const orphanRoot = path.join(context.snapshotData, "snapshots", context.snapshots[0].id);
  const orphanFile = path.join(orphanRoot, "files", context.files[0].path);
  await mkdir(path.dirname(orphanFile), { recursive: true });
  await writeFile(orphanFile, "orphan\n");
  await chmod(orphanFile, 0o444);
  await chmod(path.dirname(orphanFile), 0o555);
  await chmod(path.join(orphanRoot, "files"), 0o555);
  await chmod(orphanRoot, 0o555);
  const concurrentPath = path.join(context.snapshotData, "snapshots", id(999), "files");
  context.pool.storageSwitchBeforeSnapshotLock = concurrentPath;

  await assert.rejects(
    runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 500 }),
    /storage path changed/
  );

  assert.equal(await readFile(orphanFile, "utf8"), "orphan\n");
  assert.equal(context.snapshots[0].storage_path, concurrentPath);
});

test("revalidates the complete source file tuple before canonical view publication", async () => {
  const context = await fixture({ filesPerSnapshot: 2 });
  const originalStoragePath = context.snapshots[0].storage_path;
  const canonicalRoot = path.join(context.snapshotData, "snapshots", context.snapshots[0].id);
  context.pool.sourceFileMutationBeforeLock = (file) => {
    file.path = "src/mutated.ts";
    file.content_hash = "f".repeat(64);
    file.byte_size += 1;
  };

  await assert.rejects(
    runBackfill({ pool: context.pool, dataDir: context.dataDir }),
    /source file tuple changed/
  );

  await assert.rejects(lstat(canonicalRoot), { code: "ENOENT" });
  assert.equal(context.snapshots[0].storage_path, originalStoragePath);
  assert.ok(context.files.every((file) => file.source_blob_id === null));
  assert.equal(context.pool.queries.filter(({ text }) => text.includes("UPDATE source_files")
    && text.includes("SET source_blob_id")).length, 0);
  assert.equal(context.pool.queries.filter(({ text }) => text.includes("UPDATE source_snapshots")
    && text.includes("SET storage_path")).length, 0);
});

test("never replaces a mismatched view after the database path has switched", async () => {
  const context = await fixture();
  const seeded = await seedBlobFile(context, context.files[0]);
  const newView = path.join(context.snapshotData, "snapshots", context.snapshots[0].id, "files");
  const viewFile = path.join(newView, context.files[0].path);
  await mkdir(path.dirname(viewFile), { recursive: true });
  await writeFile(viewFile, await readFile(seeded.blobPath));
  await chmod(viewFile, 0o444);
  await chmod(path.dirname(viewFile), 0o555);
  await chmod(newView, 0o555);
  await chmod(path.dirname(newView), 0o555);
  context.snapshots[0].storage_path = newView;

  await assert.rejects(
    runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 500 }),
    /not a source blob hardlink/
  );
});

test("rejects symlinked blob, trash, and canonical view ancestors", async (t) => {
  await t.test("blob root", async () => {
    const context = await fixture();
    await seedBlobFile(context, context.files[0]);
    const blobRoot = path.join(context.snapshotData, "blobs");
    const outside = path.join(context.dataDir, "outside-blobs");
    await rename(blobRoot, outside);
    await symlink(outside, blobRoot);
    await assert.rejects(runBackfill({ pool: context.pool, dataDir: context.dataDir }), /real directory/);
  });
  await t.test("trash root", async () => {
    const context = await fixture();
    await seedBlobFile(context, context.files[0], { status: "tombstoned", location: "trash" });
    const trashRoot = path.join(context.snapshotData, ".trash");
    const outside = path.join(context.dataDir, "outside-trash");
    await rename(trashRoot, outside);
    await symlink(outside, trashRoot);
    await assert.rejects(runBackfill({ pool: context.pool, dataDir: context.dataDir }), /real directory/);
  });
  await t.test("canonical snapshot directory", async () => {
    const context = await fixture();
    const seeded = await seedBlobFile(context, context.files[0]);
    const viewRoot = path.join(context.snapshotData, "snapshots");
    const outside = path.join(context.dataDir, "outside-view");
    const outsideFile = path.join(outside, "files", context.files[0].path);
    await mkdir(path.dirname(outsideFile), { recursive: true });
    await link(seeded.blobPath, outsideFile);
    await chmod(path.dirname(outsideFile), 0o555);
    await chmod(path.join(outside, "files"), 0o555);
    await chmod(outside, 0o555);
    await mkdir(viewRoot, { recursive: true });
    await symlink(outside, path.join(viewRoot, context.snapshots[0].id));
    await assert.rejects(runBackfill({ pool: context.pool, dataDir: context.dataDir }), /real directory/);
  });
});

test("rejects writable canonical view directory components", async () => {
  const context = await fixture();
  const seeded = await seedBlobFile(context, context.files[0]);
  const view = path.join(context.snapshotData, "snapshots", context.snapshots[0].id, "files");
  const viewFile = path.join(view, context.files[0].path);
  await mkdir(path.dirname(viewFile), { recursive: true });
  await link(seeded.blobPath, viewFile);

  await assert.rejects(
    runBackfill({ pool: context.pool, dataDir: context.dataDir }),
    /read-only real directory/
  );
});

test("fsyncs immutable blob inodes and snapshot directories before publishing the view", async () => {
  const context = await fixture();
  const events = [];

  await runBackfill({
    pool: context.pool,
    dataDir: context.dataDir,
    batchSize: 500,
    observer: (event) => events.push(event)
  });

  const blobFileSync = events.findIndex((event) => event.type === "blob-file-fsync" && event.mode === 0o444);
  const blobLink = events.findIndex((event) => event.type === "blob-link");
  const blobDirectorySync = events.findIndex((event) => event.type === "blob-directory-fsync");
  const viewLink = events.findIndex((event) => event.type === "view-link");
  const viewTreeSync = events.findIndex((event) => event.type === "view-tree-fsync");
  const viewRename = events.findIndex((event) => event.type === "view-rename");
  const viewRootSync = events.findIndex((event) => event.type === "view-root-fsync");
  const reportParentSync = events.findIndex((event) => event.type === "ancestor-directory-fsync"
    && event.path === context.dataDir);
  assert.ok(blobFileSync >= 0 && blobFileSync < blobLink && blobLink < blobDirectorySync);
  assert.ok(viewLink >= 0 && viewLink < viewTreeSync && viewTreeSync < viewRename && viewRename < viewRootSync);
  assert.ok(reportParentSync > viewRootSync);
});

test("rejects symlinks at the legacy view root and in intermediate directories", async (t) => {
  await t.test("view root", async () => {
    const context = await fixture();
    const view = context.snapshots[0].storage_path;
    const realView = path.join(context.dataDir, "real-view");
    await mkdir(realView, { recursive: true });
    await rm(view, { recursive: true });
    await symlink(realView, view);
    await assert.rejects(runBackfill({ pool: context.pool, dataDir: context.dataDir }), /real directory/);
  });
  await t.test("intermediate directory", async () => {
    const context = await fixture();
    const view = context.snapshots[0].storage_path;
    const realSource = path.join(context.dataDir, "real-source");
    await mkdir(realSource, { recursive: true });
    await writeFile(path.join(realSource, path.basename(context.files[0].path)),
      await readFile(path.join(view, context.files[0].path)));
    await rm(path.join(view, "src"), { recursive: true });
    await symlink(realSource, path.join(view, "src"));
    await assert.rejects(runBackfill({ pool: context.pool, dataDir: context.dataDir }), /real directory/);
  });
});

test("streams source, blob, temporary, and view bodies in bounded chunks", async () => {
  const context = await fixture();
  const legacyView = context.snapshots[0].storage_path;
  const largeBody = Buffer.alloc(256 * 1024, "x");
  await writeFile(path.join(legacyView, context.files[0].path), largeBody);
  context.files[0].content_hash = hash(largeBody);
  context.files[0].byte_size = largeBody.length;
  const reads = [];
  const writes = [];
  let readChunks = 0;
  let maxReadChunk = 0;
  let maxWriteChunk = 0;

  await runBackfill({
    pool: context.pool,
    dataDir: context.dataDir,
    streams: {
      createReadStream: (filePath, options) => {
        reads.push(filePath);
        const stream = createReadStream(filePath, { ...options, highWaterMark: 1024 });
        stream.on("data", (chunk) => {
          readChunks += 1;
          maxReadChunk = Math.max(maxReadChunk, chunk.length);
        });
        return stream;
      },
      createWriteStream: (filePath, options) => {
        writes.push(filePath);
        const stream = createWriteStream(filePath, { ...options, highWaterMark: 1024 });
        const write = stream.write.bind(stream);
        stream.write = (chunk, ...args) => {
          maxWriteChunk = Math.max(maxWriteChunk, chunk.length);
          return write(chunk, ...args);
        };
        return stream;
      }
    },
    observer: (event) => {
      if (event.type === "snapshot-preflight") assert.ok(event.files.every((file) => !("bytes" in file)));
    }
  });

  assert.ok(writes.length >= context.files.length);
  assert.ok(reads.some((filePath) => filePath.startsWith(legacyView)));
  assert.ok(reads.some((filePath) => filePath.includes(`${path.sep}blobs${path.sep}`)));
  assert.ok(reads.some((filePath) => filePath.includes(`${path.sep}snapshots${path.sep}snapshots${path.sep}`)));
  assert.ok(readChunks > 100);
  assert.ok(maxReadChunk <= 1024);
  assert.ok(maxWriteChunk <= 1024);
});

test("checkpoints each completed snapshot and preserves cumulative report state on a zero-work rerun", async () => {
  const context = await fixture({ snapshotCount: 2 });
  context.files[1].content_hash = "0".repeat(64);
  const reportPath = path.join(context.dataDir, "reports", "source-blob-backfill.json");

  await assert.rejects(runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 2 }), /hash mismatch/);
  const checkpoint = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(checkpoint.processed, 1);
  assert.deepEqual(checkpoint.lastCursor, {
    workspaceId: context.snapshots[0].workspace_id,
    snapshotId: context.snapshots[0].id
  });

  context.files[1].content_hash = hash(await readFile(path.join(context.snapshots[1].storage_path, context.files[1].path)));
  const resumed = await runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 2 });
  const repeated = await runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 2 });
  assert.equal(resumed.processed, 2);
  assert.equal(repeated.processed, 2);
  assert.deepEqual(repeated.lastCursor, resumed.lastCursor);
});

test("preserves the maximum audit cursor when repairing an earlier snapshot", async () => {
  const context = await fixture({ snapshotCount: 2 });
  await runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 2 });
  const earlier = context.snapshots[0];
  const later = context.snapshots[1];
  context.pool.audits = context.pool.audits
    .filter((audit) => audit.resource_id !== earlier.id)
    .reverse();
  earlier.storage_path = path.join(context.snapshotData, earlier.id, "files");
  for (const file of context.files.filter((candidate) => candidate.snapshot_id === earlier.id)) {
    file.source_blob_id = null;
  }

  const repaired = await runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 2 });
  const repeated = await runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 2 });

  const maximum = { workspaceId: later.workspace_id, snapshotId: later.id };
  assert.deepEqual(repaired.lastCursor, maximum);
  assert.deepEqual(repeated.lastCursor, maximum);
  assert.equal(repaired.processed, 2);
  assert.equal(repeated.processed, 2);
});

test("rebuilds the report checkpoint from committed audit after crashing before report write", async () => {
  const context = await fixture({ filesPerSnapshot: 2 });
  let crashed = false;

  await assert.rejects(runBackfill({
    pool: context.pool,
    dataDir: context.dataDir,
    batchSize: 500,
    observer: (event) => {
      if (event.type === "snapshot-bound" && !crashed) {
        crashed = true;
        throw new Error("simulated post-commit crash");
      }
    }
  }), /simulated post-commit crash/);

  assert.equal(context.pool.audits.filter((audit) => audit.action === "source_blob.snapshot_backfilled").length, 1);
  assert.deepEqual(context.pool.audits.find((audit) => audit.action === "source_blob.snapshot_backfilled").metadata, {
    projectId: context.snapshots[0].project_id,
    repositoryId: context.snapshots[0].repository_id,
    reused: 0,
    created: 2,
    workspaceId: context.snapshots[0].workspace_id,
    snapshotId: context.snapshots[0].id
  });
  const recovered = await runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 500 });
  assert.equal(recovered.processed, 1);
  assert.equal(recovered.reused, 0);
  assert.equal(recovered.created, 2);
  assert.deepEqual(recovered.lastCursor, {
    workspaceId: context.snapshots[0].workspace_id,
    snapshotId: context.snapshots[0].id
  });
  assert.equal(context.pool.audits.filter((audit) => audit.action === "source_blob.snapshot_backfilled").length, 1);
});

test("rejects an audit checkpoint whose snapshot can no longer be proven", async () => {
  const context = await fixture();
  context.pool.audits.push({
    workspace_id: context.snapshots[0].workspace_id,
    action: "source_blob.snapshot_backfilled",
    resource_type: "source_snapshot",
    resource_id: id(777),
    metadata: {
      projectId: id(200), repositoryId: id(100), reused: 0, created: 1,
      workspaceId: context.snapshots[0].workspace_id, snapshotId: id(777)
    }
  });

  await assert.rejects(
    runBackfill({ pool: context.pool, dataDir: context.dataDir }),
    /checkpoint cannot be proven/
  );
});

test("Docker integration stage includes scripts required by test:integration", async () => {
  const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /FROM runtime AS integration[\s\S]*COPY --chown=node:node scripts \.\/scripts/);
});

test("accepts a private zero-work report written by an earlier run", async () => {
  const context = await fixture();
  const reportRoot = path.join(context.dataDir, "reports");
  await mkdir(reportRoot, { recursive: true });
  const reportPath = path.join(reportRoot, "source-blob-backfill.json");
  await writeFile(reportPath, `${JSON.stringify({
    schemaVersion: 1,
    batchSize: 500,
    processed: 0,
    reused: 0,
    created: 0,
    lastCursor: null,
    completedAt: new Date().toISOString()
  })}\n`, { mode: 0o600 });

  const report = await runBackfill({ pool: context.pool, dataDir: context.dataDir });

  assert.equal(report.processed, 1);
  assert.ok(report.lastCursor);
});

test("rolls back the complete snapshot binding when GC tombstones a resolved blob", async () => {
  const context = await fixture({ filesPerSnapshot: 2 });
  const originalPath = context.snapshots[0].storage_path;
  context.pool.tombstoneBeforeBinding = true;

  await assert.rejects(
    runBackfill({ pool: context.pool, dataDir: context.dataDir, batchSize: 500 }),
    /not active/
  );

  assert.ok(context.files.every((file) => file.source_blob_id === null));
  assert.equal(context.snapshots[0].storage_path, originalPath);
  assert.ok(context.pool.queries.some(({ text }) => text === "ROLLBACK"));
});

test("rolls back all bindings when failure follows the first source file update", async () => {
  const context = await fixture({ filesPerSnapshot: 2 });
  const originalStoragePath = context.snapshots[0].storage_path;
  let bindingMutations = 0;

  await assert.rejects(runBackfill({
    pool: context.pool,
    dataDir: context.dataDir,
    observer: (event) => {
      if (event.type === "source-file-bound" && ++bindingMutations === 1) {
        throw new Error("fail after first binding mutation");
      }
    }
  }), /fail after first binding mutation/);

  assert.equal(bindingMutations, 1);
  assert.ok(context.pool.files.every((file) => file.source_blob_id === null));
  assert.equal(context.pool.snapshots[0].storage_path, originalStoragePath);
  assert.equal(context.pool.audits.filter((audit) => audit.action === "source_blob.snapshot_backfilled").length, 0);
});

test("runs the snapshot backfill against PostgreSQL atomically", {
  skip: !process.env.TEST_DATABASE_URL
}, async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  const parsed = new URL(databaseUrl);
  assert.equal(parsed.pathname.replace(/^\//, ""), "devkh_test",
    "TEST_DATABASE_URL must target the dedicated devkh_test database");
  const pool = new Pool({ connectionString: databaseUrl });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devkh-source-blob-pg-"));
  roots.push(dataDir);
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const repositoryId = randomUUID();
  const snapshotId = randomUUID();
  const buildId = randomUUID();
  const releaseId = randomUUID();
  const snapshotData = path.join(dataDir, "snapshots");
  const legacyView = path.join(snapshotData, snapshotId, "files");
  const sourceRows = [
    { id: randomUUID(), path: "src/index.ts", bytes: Buffer.from("export const pg = true;\n") },
    { id: randomUUID(), path: "README.md", bytes: Buffer.from("# PostgreSQL backfill\n") }
  ];
  try {
    const schema = await pool.query("SELECT to_regclass('source_blobs')::text AS source_blobs");
    assert.equal(schema.rows[0]?.source_blobs, "source_blobs",
      "integration schema must be migrated before the backfill test");
    await mkdir(path.join(legacyView, "src"), { recursive: true });
    await Promise.all(sourceRows.map((source) => writeFile(path.join(legacyView, source.path), source.bytes)));
    await pool.query("INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)",
      [workspaceId, "FK16.1 integration", `fk16-${workspaceId}`]);
    await pool.query("INSERT INTO projects (id, workspace_id, name, slug) VALUES ($1, $2, $3, $4)",
      [projectId, workspaceId, "FK16.1", `fk16-project-${projectId}`]);
    await pool.query(
      `INSERT INTO repositories (id, workspace_id, project_id, name, kind, default_branch)
       VALUES ($1, $2, $3, $4, 'upload', 'main')`,
      [repositoryId, workspaceId, projectId, "FK16.1 repository"]
    );
    await pool.query(
      `INSERT INTO source_snapshots
         (id, workspace_id, repository_id, commit_sha, ref, commit_timestamp, storage_path)
       VALUES ($1, $2, $3, $4, 'main', now(), $5)`,
      [snapshotId, workspaceId, repositoryId, "a".repeat(40), legacyView]
    );
    for (const source of sourceRows) {
      await pool.query(
        `INSERT INTO source_files (id, workspace_id, snapshot_id, path, content_hash, byte_size)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [source.id, workspaceId, snapshotId, source.path, hash(source.bytes), source.bytes.length]
      );
    }
    await pool.query(
      `INSERT INTO build_jobs
         (id, workspace_id, repository_id, snapshot_id, snapshot_path, commit_sha, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'ready')`,
      [buildId, workspaceId, repositoryId, snapshotId, legacyView, "a".repeat(40)]
    );
    await pool.query(
      `INSERT INTO releases
         (id, workspace_id, repository_id, build_job_id, snapshot_id, version, kernel_mode,
          release_artifact_family)
       VALUES ($1, $2, $3, $4, $5, 'fk16.1-integration', 'legacy', 'knowledge-v1')`,
      [releaseId, workspaceId, repositoryId, buildId, snapshotId]
    );
    const releaseBefore = (await pool.query("SELECT to_jsonb(release) AS value FROM releases release WHERE id = $1", [releaseId])).rows[0].value;
    const expectedView = path.join(snapshotData, "snapshots", snapshotId, "files");

    const tupleCompetitor = await pool.connect();
    let sourceLockSignal;
    const reachedSourceLock = new Promise((resolve) => { sourceLockSignal = resolve; });
    try {
      await tupleCompetitor.query("BEGIN");
      await tupleCompetitor.query(
        "UPDATE source_files SET byte_size = byte_size + 1 WHERE id = $1",
        [sourceRows[0].id]
      );
      const tupleRace = runBackfill({
        pool,
        dataDir,
        batchSize: 1,
        observer: (event) => {
          if (event.type === "before-source-files-lock") sourceLockSignal();
        }
      });
      await Promise.race([
        reachedSourceLock,
        new Promise((_, reject) => setTimeout(() => reject(new Error("backfill did not reach source file lock")), 5_000))
      ]);
      let settled = false;
      void tupleRace.finally(() => { settled = true; }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(settled, false);
      await tupleCompetitor.query("COMMIT");
      await assert.rejects(tupleRace, /source file tuple changed/);
    } finally {
      await tupleCompetitor.query("ROLLBACK").catch(() => undefined);
      tupleCompetitor.release();
    }
    assert.equal((await pool.query("SELECT storage_path FROM source_snapshots WHERE id = $1", [snapshotId])).rows[0].storage_path,
      legacyView);
    assert.ok((await pool.query("SELECT source_blob_id FROM source_files WHERE snapshot_id = $1", [snapshotId])).rows
      .every((row) => row.source_blob_id === null));
    await assert.rejects(lstat(path.dirname(expectedView)), { code: "ENOENT" });
    await pool.query("UPDATE source_files SET byte_size = byte_size - 1 WHERE id = $1", [sourceRows[0].id]);

    let rollbackBindingMutations = 0;
    await assert.rejects(runBackfill({
      pool,
      dataDir,
      batchSize: 1,
      observer: (event) => {
        if (event.type === "source-file-bound" && ++rollbackBindingMutations === 1) {
          throw new Error("integration bind rollback");
        }
      }
    }), /integration bind rollback/);
    assert.equal(rollbackBindingMutations, 1);
    const rolledBackSnapshot = await pool.query("SELECT storage_path FROM source_snapshots WHERE id = $1", [snapshotId]);
    assert.equal(rolledBackSnapshot.rows[0].storage_path, legacyView);
    const rolledBackFiles = await pool.query(
      "SELECT source_blob_id FROM source_files WHERE snapshot_id = $1 ORDER BY id",
      [snapshotId]
    );
    assert.ok(rolledBackFiles.rows.every((row) => row.source_blob_id === null));
    assert.equal((await pool.query(
      "SELECT count(*)::int AS count FROM audit_events WHERE action = 'source_blob.snapshot_backfilled' AND resource_id = $1",
      [snapshotId]
    )).rows[0].count, 0);

    await removeReadOnlyTree(path.dirname(expectedView));
    const raceFile = path.join(expectedView, sourceRows[0].path);
    await mkdir(path.dirname(raceFile), { recursive: true });
    await writeFile(raceFile, "competing view\n");
    await chmod(raceFile, 0o444);
    await chmod(path.dirname(raceFile), 0o555);
    await chmod(expectedView, 0o555);
    await chmod(path.dirname(expectedView), 0o555);
    const competing = await pool.connect();
    let releaseLockSignal;
    const reachedSnapshotLock = new Promise((resolve) => { releaseLockSignal = resolve; });
    try {
      await competing.query("BEGIN");
      await competing.query("SELECT id FROM source_snapshots WHERE id = $1 FOR UPDATE", [snapshotId]);
      await competing.query("UPDATE source_snapshots SET storage_path = $1 WHERE id = $2", [expectedView, snapshotId]);
      const racedBackfill = runBackfill({
        pool,
        dataDir,
        batchSize: 1,
        observer: (event) => {
          if (event.type === "before-snapshot-lock") releaseLockSignal();
        }
      });
      await Promise.race([
        reachedSnapshotLock,
        new Promise((_, reject) => setTimeout(() => reject(new Error("backfill did not reach snapshot lock")), 5_000))
      ]);
      let settled = false;
      void racedBackfill.finally(() => { settled = true; }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(settled, false);
      await competing.query("COMMIT");
      await assert.rejects(racedBackfill, /file set is inconsistent|not a source blob hardlink/);
    } finally {
      await competing.query("ROLLBACK").catch(() => undefined);
      competing.release();
    }
    assert.equal((await pool.query("SELECT storage_path FROM source_snapshots WHERE id = $1", [snapshotId])).rows[0].storage_path,
      expectedView);
    assert.equal(await readFile(raceFile, "utf8"), "competing view\n");
    assert.ok((await pool.query("SELECT source_blob_id FROM source_files WHERE snapshot_id = $1", [snapshotId])).rows
      .every((row) => row.source_blob_id === null));
    await pool.query("UPDATE source_snapshots SET storage_path = $1 WHERE id = $2", [legacyView, snapshotId]);
    await removeReadOnlyTree(path.dirname(expectedView));

    const report = await runBackfill({ pool, dataDir, batchSize: 1 });

    assert.equal(report.processed, 1);
    assert.equal(report.reused, sourceRows.length);
    assert.equal(report.created, 0);
    const persistedSnapshot = await pool.query("SELECT storage_path FROM source_snapshots WHERE id = $1", [snapshotId]);
    assert.equal(persistedSnapshot.rows[0].storage_path, expectedView);
    const persistedFiles = await pool.query(
      `SELECT file.id, file.source_blob_id, blob.workspace_id, blob.content_hash, blob.byte_size,
              blob.generation, blob.status, blob.storage_key
       FROM source_files file
       JOIN source_blobs blob ON blob.id = file.source_blob_id AND blob.workspace_id = file.workspace_id
       WHERE file.snapshot_id = $1
       ORDER BY file.path`,
      [snapshotId]
    );
    assert.equal(persistedFiles.rows.length, sourceRows.length);
    assert.ok(persistedFiles.rows.every((row) => row.source_blob_id && row.workspace_id === workspaceId
      && row.status === "active" && Number(row.generation) === 1));
    for (const row of persistedFiles.rows) {
      const source = sourceRows.find((candidate) => candidate.id === row.id);
      assert.equal(row.content_hash, hash(source.bytes));
      assert.equal(Number(row.byte_size), source.bytes.length);
      const [blobStat, viewStat] = await Promise.all([
        lstat(path.join(snapshotData, row.storage_key)),
        lstat(path.join(expectedView, source.path))
      ]);
      assert.equal(viewStat.dev, blobStat.dev);
      assert.equal(viewStat.ino, blobStat.ino);
    }
    const releaseAfter = (await pool.query("SELECT to_jsonb(release) AS value FROM releases release WHERE id = $1", [releaseId])).rows[0].value;
    assert.deepEqual(releaseAfter, releaseBefore);
    const checkpoints = await pool.query(
      `SELECT metadata FROM audit_events
       WHERE workspace_id = $1 AND action = 'source_blob.snapshot_backfilled'
         AND resource_type = 'source_snapshot' AND resource_id = $2`,
      [workspaceId, snapshotId]
    );
    assert.equal(checkpoints.rows.length, 1);
    assert.deepEqual(checkpoints.rows[0].metadata, {
      projectId,
      repositoryId,
      reused: sourceRows.length,
      created: 0,
      workspaceId,
      snapshotId
    });
    const repeated = await runBackfill({ pool, dataDir, batchSize: 1 });
    assert.deepEqual(repeated, { ...report, completedAt: repeated.completedAt });
  } finally {
    await pool.query("DELETE FROM releases WHERE workspace_id = $1", [workspaceId]).catch(() => undefined);
    await pool.query("DELETE FROM build_jobs WHERE workspace_id = $1", [workspaceId]).catch(() => undefined);
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]).catch(() => undefined);
    await pool.end();
  }
});
