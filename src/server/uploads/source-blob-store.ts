import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import path from "node:path";

import { safeFolderUploadPath, syncDirectory } from "./folder-import.js";

export type SourceBlobStatus = "active" | "tombstoned" | "trash" | "deleted";

export interface SourceBlobRecord {
  id: string;
  workspaceId: string;
  contentHash: string;
  generation: number;
  byteSize: number;
  status: SourceBlobStatus;
  storageKey: string;
  fencingToken: string | null;
  tombstonedAt: Date | null;
  trashedAt: Date | null;
  deletedAt: Date | null;
}

export interface CreateSourceBlobRecordInput {
  workspaceId: string;
  contentHash: string;
  generation: number;
  byteSize: number;
  storageKey: string;
}

export interface LockedSourceBlobCatalog {
  findActive(): Promise<SourceBlobRecord | null>;
  nextGeneration(): Promise<number>;
  create(input: CreateSourceBlobRecordInput): Promise<SourceBlobRecord>;
}

export interface SourceBlobCatalog {
  withSourceBlobLock<T>(
    workspaceId: string,
    contentHash: string,
    operation: (catalog: LockedSourceBlobCatalog) => Promise<T>
  ): Promise<T>;
}

export class SourceBlobIntegrityError extends Error {
  constructor(
    readonly code:
      | "INVALID_SOURCE_BLOB_SCOPE"
      | "SOURCE_BLOB_MISSING"
      | "SOURCE_BLOB_INTEGRITY_FAILED"
      | "SNAPSHOT_VIEW_FAILED",
    message: string
  ) {
    super(message);
    this.name = "SourceBlobIntegrityError";
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeIdentifier(value: string, label: string): string {
  if (!/^[0-9a-z_-]+$/i.test(value) || value === "." || value === "..") {
    throw new SourceBlobIntegrityError("INVALID_SOURCE_BLOB_SCOPE", `${label} is invalid`);
  }
  return value;
}

function storageKey(workspaceId: string, contentHash: string, generation: number): string {
  safeIdentifier(workspaceId, "Workspace identifier");
  if (!/^[0-9a-f]{64}$/.test(contentHash) || !Number.isSafeInteger(generation) || generation < 1) {
    throw new SourceBlobIntegrityError("INVALID_SOURCE_BLOB_SCOPE", "Source blob identity is invalid");
  }
  return path.posix.join("blobs", workspaceId, contentHash.slice(0, 2), contentHash, String(generation));
}

async function makeDirectoriesReadOnly(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) await makeDirectoriesReadOnly(path.join(root, entry.name));
  }
  await chmod(root, 0o555);
}

export class SourceBlobStore {
  constructor(private readonly options: { dataDir: string; catalog: SourceBlobCatalog }) {}

  async initialize(): Promise<void> {
    await mkdir(path.join(this.options.dataDir, "blobs"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.options.dataDir, "snapshots"), { recursive: true, mode: 0o700 });
  }

  async put(input: { workspaceId: string; bytes: Uint8Array }): Promise<{
    record: SourceBlobRecord;
    reused: boolean;
  }> {
    const bytes = Buffer.from(input.bytes);
    const contentHash = digest(bytes);
    safeIdentifier(input.workspaceId, "Workspace identifier");
    return this.options.catalog.withSourceBlobLock(input.workspaceId, contentHash, async (catalog) => {
      const active = await catalog.findActive();
      if (active) {
        await this.read(active);
        return { record: active, reused: true };
      }

      const generation = await catalog.nextGeneration();
      const key = storageKey(input.workspaceId, contentHash, generation);
      const destination = path.join(this.options.dataDir, ...key.split("/"));
      const directory = path.dirname(destination);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, `.${generation}.${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (digest(await readFile(temporary)) !== contentHash) {
          throw new SourceBlobIntegrityError("SOURCE_BLOB_INTEGRITY_FAILED", "Written source blob failed verification");
        }
        await chmod(temporary, 0o444);
        await link(temporary, destination);
        await unlink(temporary);
        await syncDirectory(directory);
        try {
          const record = await catalog.create({
            workspaceId: input.workspaceId,
            contentHash,
            generation,
            byteSize: bytes.length,
            storageKey: key
          });
          return { record, reused: false };
        } catch (error) {
          await unlink(destination).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async read(record: SourceBlobRecord): Promise<Buffer> {
    const expectedKey = storageKey(record.workspaceId, record.contentHash, record.generation);
    if (record.storageKey !== expectedKey || record.status === "deleted") {
      throw new SourceBlobIntegrityError("SOURCE_BLOB_INTEGRITY_FAILED", "Source blob record is not readable");
    }
    const absolutePath = path.join(this.options.dataDir, ...expectedKey.split("/"));
    let metadata;
    try {
      metadata = await lstat(absolutePath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new SourceBlobIntegrityError("SOURCE_BLOB_MISSING", "Source blob bytes are missing");
      }
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new SourceBlobIntegrityError("SOURCE_BLOB_INTEGRITY_FAILED", "Source blob is not a regular file");
    }
    const bytes = await readFile(absolutePath);
    if (bytes.length !== record.byteSize || digest(bytes) !== record.contentHash) {
      throw new SourceBlobIntegrityError("SOURCE_BLOB_INTEGRITY_FAILED", "Source blob bytes do not match metadata");
    }
    return bytes;
  }

  async materializeSnapshotView(input: {
    workspaceId: string;
    snapshotId: string;
    files: Array<{ path: string; blob: SourceBlobRecord }>;
  }): Promise<string> {
    safeIdentifier(input.workspaceId, "Workspace identifier");
    safeIdentifier(input.snapshotId, "Snapshot identifier");
    let files: Array<{ path: string; blob: SourceBlobRecord }>;
    try {
      files = input.files.map((file) => ({ ...file, path: safeFolderUploadPath(file.path) }));
    } catch {
      throw new SourceBlobIntegrityError("SNAPSHOT_VIEW_FAILED", "Snapshot contains an unsafe path");
    }
    if (new Set(files.map((file) => file.path)).size !== files.length) {
      throw new SourceBlobIntegrityError("SNAPSHOT_VIEW_FAILED", "Snapshot contains duplicate paths");
    }
    for (const file of files) {
      if (file.blob.workspaceId !== input.workspaceId) {
        throw new SourceBlobIntegrityError("INVALID_SOURCE_BLOB_SCOPE", "Snapshot blob belongs to another workspace");
      }
      await this.read(file.blob);
    }

    const snapshotsRoot = path.join(this.options.dataDir, "snapshots");
    const destination = path.join(snapshotsRoot, input.snapshotId);
    const temporary = path.join(snapshotsRoot, `.${input.snapshotId}.${randomUUID()}.tmp`);
    const view = path.join(temporary, "files");
    await mkdir(view, { recursive: true, mode: 0o700 });
    try {
      for (const file of files) {
        const blobPath = path.join(this.options.dataDir, ...file.blob.storageKey.split("/"));
        const target = path.join(view, ...file.path.split("/"));
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        try {
          await link(blobPath, target);
        } catch (error) {
          throw new SourceBlobIntegrityError(
            "SNAPSHOT_VIEW_FAILED",
            error instanceof Error && "code" in error && error.code === "EXDEV"
              ? "Source blobs and snapshot views must use the same filesystem"
              : "Snapshot hardlink creation failed"
          );
        }
      }
      await makeDirectoriesReadOnly(temporary);
      await rename(temporary, destination);
      await syncDirectory(snapshotsRoot);
      return path.join(destination, "files");
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
}
