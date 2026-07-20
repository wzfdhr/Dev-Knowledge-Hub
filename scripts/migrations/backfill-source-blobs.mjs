import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

const DEFAULT_BATCH_SIZE = 500;
const REPORT_NAME = "source-blob-backfill.json";
const SOURCE_BLOB_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeIdentifier(value, label) {
  if (typeof value !== "string" || !/^[0-9a-z_-]+$/i.test(value) || value === "." || value === "..") {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function safeSourcePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")
    || value.startsWith("/") || /^[a-zA-Z]:\//.test(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")
    || path.posix.normalize(value) !== value) {
    throw new Error("unsafe source file path");
  }
  return value;
}

function asSafeSize(value, label) {
  const size = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${label} is invalid`);
  return size;
}

function blobStorageKey(workspaceId, contentHash, generation) {
  safeIdentifier(workspaceId, "Workspace identifier");
  if (!/^[0-9a-f]{64}$/.test(contentHash) || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Source blob identity is invalid");
  }
  return path.posix.join("blobs", workspaceId, contentHash.slice(0, 2), contentHash, String(generation));
}

function hasErrorCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

function observe(observer, event) {
  observer?.(event);
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFile(filePath) {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertRealDirectory(directory, label = "Snapshot directory") {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  return metadata;
}

async function assertRealDirectoryChain(root, segments) {
  await assertRealDirectory(root, "Snapshot data root");
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    await assertRealDirectory(current, "Snapshot path directory");
  }
  return current;
}

async function ensureDurableDirectory(root, segments, observer) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertRealDirectory(root, "Storage root");
  let current = root;
  for (const segment of segments) {
    const next = path.join(current, segment);
    let created = false;
    try {
      await mkdir(next, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
    }
    await assertRealDirectory(next, "Storage directory");
    if (created) {
      await syncDirectory(current);
      observe(observer, { type: "ancestor-directory-fsync", path: current });
    }
    current = next;
  }
  await syncDirectory(current);
  observe(observer, { type: "ancestor-directory-fsync", path: current });
  return current;
}

async function withTransaction(pool, operation) {
  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release?.();
  }
}

function snapshotPaths(dataDir, snapshotId) {
  safeIdentifier(snapshotId, "Snapshot identifier");
  const snapshotData = path.resolve(dataDir, "snapshots");
  return {
    snapshotData,
    legacyView: path.join(snapshotData, snapshotId, "files"),
    viewRoot: path.join(snapshotData, "snapshots"),
    view: path.join(snapshotData, "snapshots", snapshotId, "files")
  };
}

async function assertRegularFile(filePath, label) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  return metadata;
}

async function hashSourceFile(sourcePath, label) {
  const before = await assertRegularFile(sourcePath, label);
  const hasher = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(sourcePath)) {
    byteSize += chunk.length;
    hasher.update(chunk);
  }
  const after = await assertRegularFile(sourcePath, label);
  if (before.dev !== after.dev || before.ino !== after.ino) throw new Error(`${label} changed during verification`);
  return { byteSize, contentHash: hasher.digest("hex"), dev: after.dev, ino: after.ino };
}

async function preflightSourceFile(viewPath, file) {
  const relativePath = safeSourcePath(file.path);
  const expectedHash = file.content_hash;
  const expectedSize = asSafeSize(file.byte_size, "Source file size");
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) throw new Error("Source file hash is invalid");
  await assertRealDirectoryChain(viewPath, relativePath.split("/").slice(0, -1));
  const sourcePath = path.resolve(viewPath, ...relativePath.split("/"));
  if (!sourcePath.startsWith(`${viewPath}${path.sep}`)) throw new Error("unsafe source file path");
  const verified = await hashSourceFile(sourcePath, "Snapshot source file");
  if (verified.byteSize !== expectedSize) throw new Error("Snapshot source file size mismatch");
  if (verified.contentHash !== expectedHash) throw new Error("Snapshot source file hash mismatch");
  return {
    ...file,
    path: relativePath,
    byteSize: expectedSize,
    sourcePath,
    viewPath,
    dev: verified.dev,
    ino: verified.ino
  };
}

async function readVerifiedSourceFile(file) {
  await assertRealDirectoryChain(file.viewPath, file.path.split("/").slice(0, -1));
  const before = await assertRegularFile(file.sourcePath, "Snapshot source file");
  if (before.dev !== file.dev || before.ino !== file.ino) throw new Error("Snapshot source file changed after preflight");
  const bytes = await readFile(file.sourcePath);
  const after = await assertRegularFile(file.sourcePath, "Snapshot source file");
  if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("Snapshot source file changed during verification");
  if (bytes.length !== file.byteSize) throw new Error("Snapshot source file size mismatch");
  if (digest(bytes) !== file.content_hash) throw new Error("Snapshot source file hash mismatch");
  return bytes;
}

async function verifyBlobAt(snapshotData, blob, candidate) {
  const generation = Number(blob.generation);
  const byteSize = asSafeSize(blob.byte_size, "Source blob size");
  const expectedKey = blobStorageKey(blob.workspace_id, blob.content_hash, generation);
  if (blob.storage_key !== expectedKey) throw new Error("Active source blob storage key is inconsistent");
  const blobPath = candidate ?? path.join(snapshotData, ...expectedKey.split("/"));
  const metadata = await assertRegularFile(blobPath, "Source blob");
  if ((metadata.mode & 0o222) !== 0) throw new Error("Source blob is not read-only");
  const bytes = await readFile(blobPath);
  if (bytes.length !== byteSize || digest(bytes) !== blob.content_hash) {
    throw new Error("Source blob physical bytes are inconsistent");
  }
  return { ...blob, generation, byteSize, storageKey: expectedKey, blobPath };
}

async function verifyBlob(snapshotData, blob) {
  return verifyBlobAt(snapshotData, blob);
}

function blobLocations(snapshotData, blob) {
  const storageKey = blobStorageKey(blob.workspace_id, blob.content_hash, Number(blob.generation));
  if (blob.storage_key !== storageKey) throw new Error("Source blob storage key is inconsistent");
  return {
    source: path.join(snapshotData, ...storageKey.split("/")),
    trash: path.join(snapshotData, ".trash", blob.workspace_id, blob.content_hash, String(blob.generation))
  };
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function auditBlobInconsistency(client, blob, reason) {
  await client.query(
    `INSERT INTO audit_events (workspace_id, actor_id, action, resource_type, resource_id, metadata)
     VALUES ($1, NULL, 'source_blob.gc_inconsistent', 'source_blob', $2, $3::jsonb)`,
    [blob.workspace_id, blob.id, JSON.stringify({ reason, status: blob.status, generation: Number(blob.generation) })]
  );
}

async function writeBlobGeneration(snapshotData, input, observer) {
  const storageKey = blobStorageKey(input.workspaceId, input.contentHash, input.generation);
  const destination = path.join(snapshotData, ...storageKey.split("/"));
  const directory = await ensureDurableDirectory(snapshotData, storageKey.split("/").slice(0, -1), observer);
  const temporary = path.join(directory, `.${input.generation}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(input.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const written = await readFile(temporary);
    if (written.length !== input.byteSize || digest(written) !== input.contentHash) {
      throw new Error("Written source blob failed verification");
    }
    await chmod(temporary, 0o444);
    await syncFile(temporary);
    const immutable = await lstat(temporary);
    observe(observer, { type: "blob-file-fsync", path: temporary, mode: immutable.mode & 0o777 });
    try {
      await link(temporary, destination);
      observe(observer, { type: "blob-link", source: temporary, destination });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      await verifyBlob(snapshotData, {
        workspace_id: input.workspaceId,
        content_hash: input.contentHash,
        generation: input.generation,
        byte_size: input.byteSize,
        storage_key: storageKey
      });
    }
    await rm(temporary, { force: true });
    await syncDirectory(directory);
    observe(observer, { type: "blob-directory-fsync", path: directory });
    return { storageKey, blobPath: destination };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function resolveBlob(pool, snapshotData, file, observer) {
  const outcome = await withTransaction(pool, async (client) => {
    await client.query(SOURCE_BLOB_LOCK_SQL, [file.workspace_id, file.content_hash]);
    const live = await client.query(
      `SELECT id, workspace_id, content_hash, generation, byte_size, storage_key, status,
              fencing_token, tombstoned_at, trashed_at
       FROM source_blobs
       WHERE workspace_id = $1 AND content_hash = $2 AND status IN ('active', 'tombstoned')
       ORDER BY generation
       FOR UPDATE`,
      [file.workspace_id, file.content_hash]
    );
    if (live.rows.length > 1) {
      await auditBlobInconsistency(client, live.rows[0], "multiple_live_generations");
      return { integrityError: "Multiple live source blobs exist for one content hash" };
    }
    if (live.rows.length === 1) {
      const candidate = live.rows[0];
      try {
        const locations = blobLocations(snapshotData, candidate);
        const [sourceExists, trashExists] = await Promise.all([
          pathExists(locations.source),
          pathExists(locations.trash)
        ]);
        if (candidate.status === "active") {
          if (!sourceExists || trashExists) throw new Error("Active source blob location is inconsistent");
          const blob = await verifyBlobAt(snapshotData, candidate, locations.source);
          if (blob.byteSize !== file.byteSize || blob.content_hash !== file.content_hash) {
            throw new Error("Active source blob metadata is inconsistent");
          }
          return { blob: { ...blob, reused: true } };
        }
        if (!candidate.fencing_token || sourceExists === trashExists) {
          throw new Error("Tombstoned source blob location is inconsistent");
        }
        if (sourceExists) {
          await verifyBlobAt(snapshotData, candidate, locations.source);
          const restored = await client.query(
            `UPDATE source_blobs
             SET status = 'active', fencing_token = NULL, tombstoned_at = NULL,
                 trashed_at = NULL, deleted_at = NULL, updated_at = now()
             WHERE workspace_id = $1 AND content_hash = $2 AND id = $3
               AND status = 'tombstoned' AND fencing_token = $4
             RETURNING id, workspace_id, content_hash, generation, byte_size, storage_key, status,
                       fencing_token, tombstoned_at, trashed_at`,
            [candidate.workspace_id, candidate.content_hash, candidate.id, candidate.fencing_token]
          );
          if (restored.rows.length !== 1) throw new Error("Tombstoned source blob fence restore failed");
          const blob = await verifyBlob(snapshotData, restored.rows[0]);
          return { blob: { ...blob, reused: true } };
        }
        await verifyBlobAt(snapshotData, candidate, locations.trash);
        const trashed = await client.query(
          `UPDATE source_blobs
           SET status = 'trash', trashed_at = now(), updated_at = now()
           WHERE workspace_id = $1 AND content_hash = $2 AND id = $3
             AND status = 'tombstoned' AND fencing_token = $4
           RETURNING id`,
          [candidate.workspace_id, candidate.content_hash, candidate.id, candidate.fencing_token]
        );
        if (trashed.rows.length !== 1) throw new Error("Tombstoned source blob trash fence reconciliation failed");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await auditBlobInconsistency(client, candidate, "backfill_state_location_inconsistent");
        return { integrityError: message };
      }
    }
    const generationResult = await client.query(
      "SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM source_blobs WHERE workspace_id = $1 AND content_hash = $2",
      [file.workspace_id, file.content_hash]
    );
    const generation = Number(generationResult.rows[0]?.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Next source blob generation is invalid");
    const written = await writeBlobGeneration(snapshotData, {
      workspaceId: file.workspace_id,
      contentHash: file.content_hash,
      generation,
      byteSize: file.byteSize,
      bytes: file.bytes
    }, observer);
    const inserted = await client.query(
      `INSERT INTO source_blobs (workspace_id, content_hash, generation, byte_size, storage_key, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       RETURNING id, workspace_id, content_hash, generation, byte_size, storage_key, status`,
      [file.workspace_id, file.content_hash, generation, file.byteSize, written.storageKey]
    );
    if (inserted.rows.length !== 1) throw new Error("Source blob creation did not return one row");
    const blob = await verifyBlob(snapshotData, inserted.rows[0]);
    return { blob: { ...blob, reused: false } };
  });
  if (outcome.integrityError) throw new Error(outcome.integrityError);
  return outcome.blob;
}

async function makeDirectoriesReadOnly(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) await makeDirectoriesReadOnly(path.join(root, entry.name));
  }
  await chmod(root, 0o555);
}

async function syncDirectoryTree(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) await syncDirectoryTree(path.join(root, entry.name));
  }
  await syncDirectory(root);
}

async function assertReadonlyTree(root) {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o222) !== 0) {
    throw new Error("Orphan snapshot view is not a read-only real directory");
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    const child = await lstat(candidate);
    if (child.isSymbolicLink() || (child.mode & 0o222) !== 0) {
      throw new Error("Orphan snapshot view contains an unsafe entry");
    }
    if (child.isDirectory()) await assertReadonlyTree(candidate);
    else if (!child.isFile()) throw new Error("Orphan snapshot view contains a non-file entry");
  }
}

async function removeReadonlyTree(root) {
  await chmod(root, 0o700);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) await removeReadonlyTree(path.join(root, entry.name));
  }
  await rm(root, { recursive: true, force: true });
}

async function listViewFiles(root, current = "") {
  const directory = current ? path.join(root, ...current.split("/")) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = current ? `${current}/${entry.name}` : entry.name;
    const entryPath = path.join(directory, entry.name);
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink()) throw new Error("Snapshot view contains a symbolic link");
    if (metadata.isDirectory()) {
      files.push(...await listViewFiles(root, relative));
    } else if (metadata.isFile()) {
      files.push(relative);
    } else {
      throw new Error("Snapshot view contains a non-file entry");
    }
  }
  return files;
}

async function verifySnapshotView(view, files) {
  const expectedPaths = new Set(files.map((file) => file.path));
  const actualPaths = new Set(await listViewFiles(view));
  if (actualPaths.size !== expectedPaths.size || [...actualPaths].some((filePath) => !expectedPaths.has(filePath))) {
    throw new Error("Snapshot view file set is inconsistent");
  }
  for (const file of files) {
    const viewPath = path.join(view, ...file.path.split("/"));
    const [viewStat, blobStat] = await Promise.all([
      assertRegularFile(viewPath, "Snapshot view file"),
      assertRegularFile(file.blob.blobPath, "Source blob")
    ]);
    if (viewStat.dev !== blobStat.dev || viewStat.ino !== blobStat.ino) {
      throw new Error("Snapshot view file is not a source blob hardlink");
    }
    const bytes = await readFile(viewPath);
    if (bytes.length !== file.byteSize || digest(bytes) !== file.content_hash) {
      throw new Error("Snapshot view file is inconsistent");
    }
  }
}

async function materializeSnapshotView(paths, files, { allowOrphanReplacement, observer }) {
  await ensureDurableDirectory(paths.snapshotData, ["snapshots"], observer);
  try {
    await lstat(path.dirname(paths.view));
    try {
      await verifySnapshotView(paths.view, files);
      return;
    } catch (error) {
      if (!allowOrphanReplacement) throw error;
      await assertReadonlyTree(path.dirname(paths.view));
      await removeReadonlyTree(path.dirname(paths.view));
      await syncDirectory(paths.viewRoot);
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  const temporary = path.join(paths.viewRoot, `.${path.basename(path.dirname(paths.view))}.${randomUUID()}.tmp`);
  const temporaryView = path.join(temporary, "files");
  try {
    await ensureDurableDirectory(paths.viewRoot, [path.basename(temporary), "files"], observer);
    for (const file of files) {
      const target = path.join(temporaryView, ...file.path.split("/"));
      await ensureDurableDirectory(temporaryView, file.path.split("/").slice(0, -1), observer);
      await link(file.blob.blobPath, target);
      observe(observer, { type: "view-link", source: file.blob.blobPath, destination: target });
    }
    await verifySnapshotView(temporaryView, files);
    await makeDirectoriesReadOnly(temporary);
    await syncDirectoryTree(temporary);
    observe(observer, { type: "view-tree-fsync", path: temporary });
    await rename(temporary, path.dirname(paths.view));
    observe(observer, { type: "view-rename", source: temporary, destination: path.dirname(paths.view) });
    await syncDirectory(paths.viewRoot);
    observe(observer, { type: "view-root-fsync", path: paths.viewRoot });
    await verifySnapshotView(paths.view, files);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function bindSnapshot(pool, snapshot, paths, files) {
  await withTransaction(pool, async (client) => {
    const expectedBlobs = [...new Map(files.map((file) => [
      `${file.blob.workspace_id}:${file.blob.content_hash}`,
      file.blob
    ])).values()].sort((left, right) => left.workspace_id.localeCompare(right.workspace_id)
      || left.content_hash.localeCompare(right.content_hash));
    for (const blob of expectedBlobs) {
      await client.query(SOURCE_BLOB_LOCK_SQL, [blob.workspace_id, blob.content_hash]);
    }
    const lockedBlobs = await client.query(
      `SELECT blob.id, blob.workspace_id, blob.content_hash, blob.generation, blob.byte_size, blob.status
       FROM source_blobs blob
       JOIN jsonb_to_recordset($1::jsonb)
         AS expected(id uuid, workspace_id uuid, content_hash text, generation integer, byte_size bigint)
         ON expected.id = blob.id
        AND expected.workspace_id = blob.workspace_id
        AND expected.content_hash = blob.content_hash
        AND expected.generation = blob.generation
        AND expected.byte_size = blob.byte_size
       FOR UPDATE OF blob`,
      [JSON.stringify(expectedBlobs.map((blob) => ({
        id: blob.id,
        workspace_id: blob.workspace_id,
        content_hash: blob.content_hash,
        generation: blob.generation,
        byte_size: blob.byteSize
      })))]
    );
    if (lockedBlobs.rows.length !== expectedBlobs.length) {
      throw new Error("Expected source blob generation is missing during snapshot binding");
    }
    const lockedById = new Map(lockedBlobs.rows.map((blob) => [blob.id, blob]));
    for (const expected of expectedBlobs) {
      const actual = lockedById.get(expected.id);
      if (!actual || actual.workspace_id !== expected.workspace_id || actual.content_hash !== expected.content_hash
        || Number(actual.generation) !== expected.generation || asSafeSize(actual.byte_size, "Source blob size") !== expected.byteSize
        || actual.status !== "active") {
        throw new Error("Expected source blob is not active during snapshot binding");
      }
    }
    const current = await client.query(
      `SELECT file.id, file.source_blob_id
       FROM source_files file
       WHERE file.snapshot_id = $1 AND file.workspace_id = $2
       ORDER BY file.id
       FOR UPDATE`,
      [snapshot.snapshot_id, snapshot.workspace_id]
    );
    if (current.rows.length !== files.length) throw new Error("Snapshot source file set changed during backfill");
    const expectedById = new Map(files.map((file) => [file.id, file.blob.id]));
    for (const row of current.rows) {
      const expected = expectedById.get(row.file_id ?? row.id);
      if (!expected || (row.source_blob_id !== null && row.source_blob_id !== expected)) {
        throw new Error("Snapshot source file has an inconsistent source blob binding");
      }
    }
    for (const file of files) {
      if (current.rows.find((row) => (row.file_id ?? row.id) === file.id)?.source_blob_id !== null) continue;
      const updated = await client.query(
        `UPDATE source_files
         SET source_blob_id = $1
         WHERE id = $2 AND workspace_id = $3 AND snapshot_id = $4 AND source_blob_id IS NULL
         RETURNING source_blob_id`,
        [file.blob.id, file.id, snapshot.workspace_id, snapshot.snapshot_id]
      );
      if (updated.rows.length === 0) {
        const observed = await client.query(
          `SELECT source_blob_id
           FROM source_files
           WHERE id = $1 AND workspace_id = $2 AND snapshot_id = $3`,
          [file.id, snapshot.workspace_id, snapshot.snapshot_id]
        );
        if (observed.rows.length !== 1 || observed.rows[0].source_blob_id !== file.blob.id) {
          throw new Error("Snapshot source file binding changed during backfill");
        }
      }
    }
    const switched = await client.query(
      `UPDATE source_snapshots
       SET storage_path = $1
       WHERE id = $2 AND workspace_id = $3 AND storage_path IN ($4, $5)
       RETURNING id`,
      [paths.view, snapshot.snapshot_id, snapshot.workspace_id, paths.legacyView, paths.view]
    );
    if (switched.rows.length !== 1) throw new Error("Snapshot storage path changed during backfill");
  });
}

async function writePrivateReport(dataDir, payload) {
  const reportRoot = path.resolve(dataDir, "reports");
  await mkdir(reportRoot, { recursive: true, mode: 0o700 });
  const metadata = await lstat(reportRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("DEVKH_DATA_DIR/reports must be a real directory");
  await chmod(reportRoot, 0o700);
  const destination = path.join(reportRoot, REPORT_NAME);
  const temporary = path.join(reportRoot, `.${REPORT_NAME}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(payload)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
    await syncDirectory(reportRoot);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readPrivateReport(dataDir, pool) {
  const reportPath = path.resolve(dataDir, "reports", REPORT_NAME);
  let metadata;
  try {
    metadata = await lstat(reportPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("Existing source blob backfill report is not a private regular file");
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const emptyCursor = report.lastCursor === null
    && report.processed === 0 && report.reused === 0 && report.created === 0;
  const populatedCursor = report.lastCursor && typeof report.lastCursor.workspaceId === "string"
    && typeof report.lastCursor.snapshotId === "string";
  if (report.schemaVersion !== 1 || !Number.isSafeInteger(report.processed) || report.processed < 0
    || !Number.isSafeInteger(report.reused) || report.reused < 0
    || !Number.isSafeInteger(report.created) || report.created < 0
    || !Number.isSafeInteger(report.batchSize) || report.batchSize < 1
    || typeof report.completedAt !== "string" || Number.isNaN(Date.parse(report.completedAt))
    || (!emptyCursor && !populatedCursor)) {
    throw new Error("Existing source blob backfill report is invalid");
  }
  if (emptyCursor) return report;
  const paths = snapshotPaths(dataDir, report.lastCursor.snapshotId);
  const proof = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM source_snapshots snapshot
       WHERE snapshot.workspace_id = $1 AND snapshot.id = $2 AND snapshot.storage_path = $3
         AND NOT EXISTS (
           SELECT 1 FROM source_files file
           WHERE file.workspace_id = snapshot.workspace_id AND file.snapshot_id = snapshot.id
             AND file.source_blob_id IS NULL
         )
     ) AS checkpoint_complete`,
    [report.lastCursor.workspaceId, report.lastCursor.snapshotId, paths.view]
  );
  if (proof.rows[0]?.checkpoint_complete !== true) {
    throw new Error("Existing source blob backfill checkpoint cannot be proven from the database");
  }
  return report;
}

function completedReport(state, batchSize) {
  return {
    schemaVersion: 1,
    batchSize,
    processed: state.processed,
    reused: state.reused,
    created: state.created,
    lastCursor: state.lastCursor,
    completedAt: new Date().toISOString()
  };
}

export function createBackfillConfig(env = process.env) {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const batchText = env.DEVKH_SOURCE_BLOB_BACKFILL_BATCH_SIZE?.trim();
  const batchSize = batchText ? Number(batchText) : DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error("DEVKH_SOURCE_BLOB_BACKFILL_BATCH_SIZE must be a positive safe integer");
  }
  return { databaseUrl, dataDir: path.resolve(env.DEVKH_DATA_DIR?.trim() || "var"), batchSize };
}

export async function runBackfill({
  pool,
  dataDir,
  batchSize = DEFAULT_BATCH_SIZE,
  writeReport = true,
  observer
}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error("batchSize must be a positive safe integer");
  const snapshotData = path.resolve(dataDir, "snapshots");
  const prior = writeReport ? await readPrivateReport(dataDir, pool) : null;
  const state = {
    processed: prior?.processed ?? 0,
    reused: prior?.reused ?? 0,
    created: prior?.created ?? 0,
    lastCursor: prior?.lastCursor ?? null
  };
  let cursor = null;
  for (;;) {
    const batch = await pool.query(
      `SELECT snapshot.id AS snapshot_id, snapshot.workspace_id, snapshot.storage_path
       FROM source_snapshots snapshot
       WHERE (
         ($1::uuid IS NULL AND $2::uuid IS NULL)
         OR (snapshot.workspace_id, snapshot.id) > ($1::uuid, $2::uuid)
       )
         AND (
           snapshot.storage_path IS DISTINCT FROM ($3 || '/snapshots/' || snapshot.id || '/files')
           OR EXISTS (
             SELECT 1 FROM source_files file
             WHERE file.snapshot_id = snapshot.id AND file.workspace_id = snapshot.workspace_id
               AND file.source_blob_id IS NULL
           )
         )
       ORDER BY snapshot.workspace_id, snapshot.id
       LIMIT $4`,
      [cursor?.workspaceId ?? null, cursor?.snapshotId ?? null, snapshotData, batchSize]
    );
    if (batch.rows.length === 0) break;
    for (const snapshot of batch.rows) {
      safeIdentifier(snapshot.workspace_id, "Workspace identifier");
      const paths = snapshotPaths(dataDir, snapshot.snapshot_id);
      if (snapshot.storage_path !== paths.legacyView && snapshot.storage_path !== paths.view) {
        throw new Error("Snapshot storage path is outside the supported snapshot layout");
      }
      const sourceFiles = await pool.query(
        `SELECT file.id, file.workspace_id, file.snapshot_id, file.path, file.content_hash, file.byte_size
         FROM source_files file
         WHERE file.snapshot_id = $1 AND file.workspace_id = $2
         ORDER BY file.path, file.id`,
        [snapshot.snapshot_id, snapshot.workspace_id]
      );
      const sourceViewSegments = path.relative(paths.snapshotData, snapshot.storage_path).split(path.sep);
      if (sourceViewSegments.some((segment) => !segment || segment === "." || segment === "..")) {
        throw new Error("Snapshot storage path is outside the supported snapshot layout");
      }
      await assertRealDirectoryChain(paths.snapshotData, sourceViewSegments);
      const preflight = [];
      const seenPaths = new Set();
      for (const sourceFile of sourceFiles.rows) {
        if (sourceFile.workspace_id !== snapshot.workspace_id || sourceFile.snapshot_id !== snapshot.snapshot_id) {
          throw new Error("Snapshot source file scope is inconsistent");
        }
        const file = await preflightSourceFile(snapshot.storage_path, sourceFile);
        if (seenPaths.has(file.path)) throw new Error("Snapshot contains duplicate source file paths");
        seenPaths.add(file.path);
        preflight.push(file);
      }
      observe(observer, { type: "snapshot-preflight", files: preflight });
      const bound = [];
      let snapshotReused = 0;
      let snapshotCreated = 0;
      for (const file of preflight) {
        const bytes = await readVerifiedSourceFile(file);
        observe(observer, { type: "file-buffered", path: file.path, byteSize: bytes.length });
        const blob = await resolveBlob(pool, snapshotData, { ...file, bytes }, observer);
        observe(observer, { type: "file-released", path: file.path });
        if (blob.reused) snapshotReused += 1;
        else snapshotCreated += 1;
        bound.push({ ...file, blob });
      }
      await materializeSnapshotView(paths, bound, {
        allowOrphanReplacement: snapshot.storage_path === paths.legacyView,
        observer
      });
      await bindSnapshot(pool, snapshot, paths, bound);
      state.processed += 1;
      state.reused += snapshotReused;
      state.created += snapshotCreated;
      cursor = { workspaceId: snapshot.workspace_id, snapshotId: snapshot.snapshot_id };
      state.lastCursor = cursor;
      if (writeReport) await writePrivateReport(dataDir, completedReport(state, batchSize));
    }
  }
  const report = completedReport(state, batchSize);
  if (writeReport) await writePrivateReport(dataDir, report);
  return report;
}

async function main() {
  const config = createBackfillConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const report = await runBackfill({ pool, dataDir: config.dataDir, batchSize: config.batchSize });
    console.log(`Backfilled ${report.processed} snapshots (${report.reused} reused blobs, ${report.created} created blobs).`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
