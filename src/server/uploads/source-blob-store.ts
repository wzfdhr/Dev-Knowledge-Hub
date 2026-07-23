import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
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
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { safeFolderUploadPath, syncDirectory } from "./folder-import.js";
import type {
  SourceBlobCatalog,
  SourceBlobRecord
} from "../persistence/store.js";

export type {
  CreateSourceBlobRecordInput,
  LockedSourceBlobCatalog,
  SourceBlobCatalog,
  SourceBlobRecord,
  SourceBlobStatus
} from "../persistence/store.js";

export class SourceBlobIntegrityError extends Error {
  constructor(
    readonly code:
      | "INVALID_SOURCE_BLOB_SCOPE"
      | "SOURCE_BLOB_MISSING"
      | "SOURCE_BLOB_INACCESSIBLE"
      | "SOURCE_BLOB_INTEGRITY_FAILED"
      | "SNAPSHOT_VIEW_FAILED",
    message: string,
    readonly auditReason?: string
  ) {
    super(message);
    this.name = "SourceBlobIntegrityError";
  }
}

export type SourceBlobLstatFile = (candidate: string) => Promise<Stats>;
export type SourceBlobOpenFile = (candidate: string, flags: number) => Promise<FileHandle>;

export function classifySourceBlobAccessError(
  error: unknown,
  message: string,
  auditReason?: string
): unknown {
  if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) {
    return new SourceBlobIntegrityError("SOURCE_BLOB_INACCESSIBLE", message, auditReason);
  }
  return error;
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

export function sourceBlobStorageKey(workspaceId: string, contentHash: string, generation: number): string {
  safeIdentifier(workspaceId, "Workspace identifier");
  if (!/^[0-9a-f]{64}$/.test(contentHash) || !Number.isSafeInteger(generation) || generation < 1) {
    throw new SourceBlobIntegrityError("INVALID_SOURCE_BLOB_SCOPE", "Source blob identity is invalid");
  }
  return path.posix.join("blobs", workspaceId, contentHash.slice(0, 2), contentHash, String(generation));
}

export function sourceBlobFileLocations(dataDir: string, record: SourceBlobRecord): {
  source: string;
  trash: string;
  sourceParent: string;
  trashParent: string;
} {
  const expectedKey = sourceBlobStorageKey(record.workspaceId, record.contentHash, record.generation);
  if (record.storageKey !== expectedKey) {
    throw new SourceBlobIntegrityError("SOURCE_BLOB_INTEGRITY_FAILED", "Source blob storage key is invalid");
  }
  const source = path.join(dataDir, ...expectedKey.split("/"));
  const trash = path.join(
    dataDir,
    ".trash",
    safeIdentifier(record.workspaceId, "Workspace identifier"),
    record.contentHash,
    String(record.generation)
  );
  return { source, trash, sourceParent: path.dirname(source), trashParent: path.dirname(trash) };
}

export async function ensureSafeDirectoryChain(input: {
  dataDir: string;
  segments: string[];
  createMissing?: boolean;
  prepareRoot?: boolean;
  syncFinal?: boolean;
  syncDirectory?: typeof syncDirectory;
  lstatFile?: SourceBlobLstatFile;
}): Promise<boolean> {
  const syncDir = input.syncDirectory ?? syncDirectory;
  const lstatFile = input.lstatFile ?? lstat;
  let current = path.resolve(input.dataDir);
  const inspect = async (candidate: string): Promise<Stats> => {
    try {
      return await lstatFile(candidate);
    } catch (error) {
      throw classifySourceBlobAccessError(
        error,
        "Source blob directory chain is inaccessible",
        "directory_access_inaccessible"
      );
    }
  };
  const assertDirectory = async (candidate: string): Promise<"directory" | "missing"> => {
    try {
      const metadata = await inspect(candidate);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new SourceBlobIntegrityError(
          "SOURCE_BLOB_INTEGRITY_FAILED",
          "Source blob directory chain is unsafe"
        );
      }
      return "directory";
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
      throw error;
    }
  };

  if (await assertDirectory(current) !== "directory") {
    if (!input.createMissing) {
      throw new SourceBlobIntegrityError("SOURCE_BLOB_MISSING", "Source blob data directory is missing");
    }
    const parent = path.dirname(current);
    if (await assertDirectory(parent) !== "directory") {
      throw new SourceBlobIntegrityError(
        "SOURCE_BLOB_MISSING",
        "Source blob data directory parent is missing"
      );
    }
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw classifySourceBlobAccessError(
          error,
          "Source blob directory chain is inaccessible",
          "directory_access_inaccessible"
        );
      }
    }
    if (await assertDirectory(current) !== "directory") {
      throw new SourceBlobIntegrityError(
        "SOURCE_BLOB_INTEGRITY_FAILED",
        "Source blob data directory was not created safely"
      );
    }
    await syncDir(parent);
  }
  const rootMetadata = await inspect(current);
  const processUserId = process.getuid?.();
  if (processUserId !== undefined) {
    if (rootMetadata.uid !== processUserId) {
      throw new SourceBlobIntegrityError(
        "SOURCE_BLOB_INTEGRITY_FAILED",
        "Source blob data directory is not owned by the application user"
      );
    }
    // FK16 trusts a private application-owned root; persisted artifacts below it are still revalidated.
    if (input.prepareRoot && (rootMetadata.mode & 0o077) !== 0) {
      await chmod(current, 0o700);
      await syncDir(current);
    }
    const privateRootMetadata = input.prepareRoot ? await inspect(current) : rootMetadata;
    if ((privateRootMetadata.mode & 0o077) !== 0) {
      throw new SourceBlobIntegrityError(
        "SOURCE_BLOB_INTEGRITY_FAILED",
        "Source blob data directory must be private to the application user"
      );
    }
  }
  for (const segment of input.segments) {
    if (!segment || segment === "." || segment === ".." || path.isAbsolute(segment)
      || segment.includes("/") || segment.includes("\\")) {
      throw new SourceBlobIntegrityError("INVALID_SOURCE_BLOB_SCOPE", "Source blob directory segment is invalid");
    }
    const child = path.join(current, segment);
    if (await assertDirectory(child) === "missing") {
      if (!input.createMissing) return false;
      try {
        await mkdir(child, { mode: 0o700 });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
          throw classifySourceBlobAccessError(
            error,
            "Source blob directory chain is inaccessible",
            "directory_access_inaccessible"
          );
        }
      }
      if (await assertDirectory(child) !== "directory") {
        throw new SourceBlobIntegrityError(
          "SOURCE_BLOB_INTEGRITY_FAILED",
          "Source blob directory was not created safely"
        );
      }
      await syncDir(current);
    }
    current = child;
  }
  if (input.syncFinal) await syncDir(current);
  return true;
}

export function sourceBlobDirectorySegments(
  record: Pick<SourceBlobRecord, "workspaceId" | "contentHash">
): string[] {
  sourceBlobStorageKey(record.workspaceId, record.contentHash, 1);
  return ["blobs", record.workspaceId, record.contentHash.slice(0, 2), record.contentHash];
}

export function sourceBlobTrashDirectorySegments(
  record: Pick<SourceBlobRecord, "workspaceId" | "contentHash">
): string[] {
  sourceBlobStorageKey(record.workspaceId, record.contentHash, 1);
  return [".trash", record.workspaceId, record.contentHash];
}

export async function assertSourceBlobFile(
  candidate: string,
  record: Pick<SourceBlobRecord, "contentHash" | "byteSize">,
  openFile: SourceBlobOpenFile = open,
  lstatFile: SourceBlobLstatFile = lstat
): Promise<Buffer> {
  let pathMetadata: Stats;
  try {
    pathMetadata = await lstatFile(candidate);
  } catch (error) {
    throw classifySourceBlobAccessError(error, "Source blob final file is inaccessible", "file_access_inaccessible");
  }
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    throw new SourceBlobIntegrityError(
      "SOURCE_BLOB_INTEGRITY_FAILED",
      "Source blob is not an immutable regular file"
    );
  }
  let handle: FileHandle;
  try {
    handle = await openFile(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new SourceBlobIntegrityError(
        "SOURCE_BLOB_INTEGRITY_FAILED",
        "Source blob final path must not be a symbolic link"
      );
    }
    throw classifySourceBlobAccessError(error, "Source blob final file is inaccessible", "file_access_inaccessible");
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o222) !== 0) {
      throw new SourceBlobIntegrityError(
        "SOURCE_BLOB_INTEGRITY_FAILED",
        "Source blob is not an immutable regular file"
      );
    }
    const bytes = await handle.readFile();
    if (bytes.length !== record.byteSize || digest(bytes) !== record.contentHash) {
      throw new SourceBlobIntegrityError("SOURCE_BLOB_INTEGRITY_FAILED", "Source blob bytes do not match metadata");
    }
    return bytes;
  } catch (error) {
    if (error instanceof SourceBlobIntegrityError) throw error;
    throw classifySourceBlobAccessError(error, "Source blob final file is inaccessible", "file_access_inaccessible");
  } finally {
    await handle.close();
  }
}

async function makeDirectoriesReadOnly(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) await makeDirectoriesReadOnly(path.join(root, entry.name));
  }
  await chmod(root, 0o555);
}

async function assertRecoverableOrphan(destination: string, expectedHash: string, expectedSize: number): Promise<void> {
  const metadata = await lstat(destination);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o222) !== 0) {
    throw new SourceBlobIntegrityError(
      "SOURCE_BLOB_INTEGRITY_FAILED",
      "Orphaned source blob is not an immutable regular file"
    );
  }
  await assertSourceBlobFile(destination, { contentHash: expectedHash, byteSize: expectedSize });
}

export class SourceBlobStore {
  constructor(private readonly options: {
    dataDir: string;
    catalog: SourceBlobCatalog;
    linkFile?: typeof link;
    lstatFile?: SourceBlobLstatFile;
    openFile?: SourceBlobOpenFile;
    syncDirectory?: typeof syncDirectory;
  }) {}

  async initialize(): Promise<void> {
    await this.ensureDirectoryChain({
      dataDir: this.options.dataDir,
      segments: ["blobs"],
      createMissing: true,
      prepareRoot: true,
      syncFinal: true
    });
    await this.ensureDirectoryChain({
      dataDir: this.options.dataDir,
      segments: ["snapshots"],
      createMissing: true,
      prepareRoot: true,
      syncFinal: true
    });
  }

  async verifyHardlinkSupport(): Promise<void> {
    const probeId = randomUUID();
    const blobsRoot = path.join(this.options.dataDir, "blobs");
    const snapshotsRoot = path.join(this.options.dataDir, "snapshots");
    const source = path.join(blobsRoot, `.hardlink-probe-${probeId}`);
    const target = path.join(snapshotsRoot, `.hardlink-probe-${probeId}`);
    try {
      if (!await this.ensureDirectoryChain({ dataDir: this.options.dataDir, segments: ["blobs"] })
        || !await this.ensureDirectoryChain({ dataDir: this.options.dataDir, segments: ["snapshots"] })) {
        throw new SourceBlobIntegrityError("SOURCE_BLOB_MISSING", "Source blob storage roots are missing");
      }
      const handle = await open(source, "wx", 0o600);
      try {
        await handle.writeFile("devkh-hardlink-probe");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await (this.options.linkFile ?? link)(source, target);
      const [sourceStat, targetStat] = await Promise.all([lstat(source), lstat(target)]);
      if (!sourceStat.isFile() || !targetStat.isFile() || sourceStat.dev !== targetStat.dev
        || sourceStat.ino !== targetStat.ino) {
        throw new SourceBlobIntegrityError(
          "SNAPSHOT_VIEW_FAILED",
          "Source blob storage does not preserve same-volume hardlinks"
        );
      }
    } catch (error) {
      if (error instanceof SourceBlobIntegrityError) throw error;
      const detail = error instanceof Error && "code" in error ? ` (${String(error.code)})` : "";
      throw new SourceBlobIntegrityError(
        "SNAPSHOT_VIEW_FAILED",
        `Source blob storage does not support required same-volume hardlinks${detail}`
      );
    } finally {
      await Promise.all([unlink(target).catch(() => undefined), unlink(source).catch(() => undefined)]);
      await Promise.all([syncDirectory(blobsRoot), syncDirectory(snapshotsRoot)]);
    }
  }

  async put(input: { workspaceId: string; bytes: Uint8Array }): Promise<{
    record: SourceBlobRecord;
    reused: boolean;
  }> {
    type PutOutcome =
      | { ok: true; value: { record: SourceBlobRecord; reused: boolean } }
      | { ok: false; error: SourceBlobIntegrityError };
    const bytes = Buffer.from(input.bytes);
    const contentHash = digest(bytes);
    safeIdentifier(input.workspaceId, "Workspace identifier");
    const outcome = await this.options.catalog.withSourceBlobWriterLock<PutOutcome>(
      input.workspaceId,
      contentHash,
      async (catalog) => {
      const active = await catalog.findActive();
      if (active) {
        try {
          await this.read(active);
          return { ok: true, value: { record: active, reused: true } };
        } catch (error) {
          if (!(error instanceof SourceBlobIntegrityError)) throw error;
          const reason = error.code === "SOURCE_BLOB_INACCESSIBLE"
            ? "active_file_inaccessible"
            : "active_content_inconsistent";
          await catalog.recordGcInconsistency(active.id, reason);
          return { ok: false, error };
        }
      }

      const tombstoned = await catalog.findTombstoned();
      if (tombstoned) {
        let locations: ReturnType<typeof sourceBlobFileLocations>;
        try {
          locations = sourceBlobFileLocations(this.options.dataDir, tombstoned);
          const sourceDirectoryExists = await this.ensureDirectoryChain({
            dataDir: this.options.dataDir,
            segments: sourceBlobDirectorySegments(tombstoned)
          });
          if (!sourceDirectoryExists) {
            throw new SourceBlobIntegrityError("SOURCE_BLOB_MISSING", "Source blob directory is missing");
          }
          const trashDirectoryExists = await this.ensureDirectoryChain({
            dataDir: this.options.dataDir,
            segments: sourceBlobTrashDirectorySegments(tombstoned)
          });
          const sourceExists = await this.lstatFile(locations.source).then(() => true, (error) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
            throw error;
          });
          const trashExists = trashDirectoryExists && await this.lstatFile(locations.trash).then(() => true, (error) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
            throw error;
          });
          if (sourceExists === trashExists || !tombstoned.fencingToken) {
            throw new SourceBlobIntegrityError(
              "SOURCE_BLOB_INTEGRITY_FAILED",
              "Tombstoned source blob location is inconsistent"
            );
          }
          if (sourceExists) {
            await this.assertFile(locations.source, tombstoned);
            const restored = await catalog.restoreTombstoned(tombstoned.id, tombstoned.fencingToken);
            if (!restored) throw new SourceBlobIntegrityError(
              "SOURCE_BLOB_INTEGRITY_FAILED",
              "Tombstoned source blob could not be restored"
            );
            return { ok: true, value: { record: restored, reused: true } };
          }
          if (await catalog.countReferences(tombstoned.id) > 0) {
            const error = new SourceBlobIntegrityError(
              "SOURCE_BLOB_INTEGRITY_FAILED",
              "Referenced tombstoned source blob has already moved"
            );
            await catalog.recordGcInconsistency(tombstoned.id, "referenced_tombstone_moved");
            return { ok: false, error };
          }
          await this.assertFile(locations.trash, tombstoned);
          await Promise.all([
            this.syncDir(locations.sourceParent),
            this.syncDir(locations.trashParent)
          ]);
          const trashed = await catalog.markTrash(tombstoned.id, tombstoned.fencingToken, new Date());
          if (!trashed) throw new SourceBlobIntegrityError(
            "SOURCE_BLOB_INTEGRITY_FAILED",
            "Moved source blob could not be reconciled"
          );
        } catch (error) {
          if (error instanceof SourceBlobIntegrityError) {
            await catalog.recordGcInconsistency(
              tombstoned.id,
              error.code === "SOURCE_BLOB_INACCESSIBLE"
                ? "tombstone_file_inaccessible"
                : "tombstone_content_inconsistent"
            );
            return { ok: false, error };
          }
          throw error;
        }
      }

      const generation = await catalog.nextGeneration();
      const key = sourceBlobStorageKey(input.workspaceId, contentHash, generation);
      const destination = path.join(this.options.dataDir, ...key.split("/"));
      const directory = path.dirname(destination);
      await this.ensureDirectoryChain({
        dataDir: this.options.dataDir,
        segments: ["blobs", input.workspaceId, contentHash.slice(0, 2), contentHash],
        createMissing: true,
        syncFinal: true
      });
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
        try {
          await link(temporary, destination);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
          await assertRecoverableOrphan(destination, contentHash, bytes.length);
        }
        await unlink(temporary);
        await this.syncDir(directory);
        try {
          const record = await catalog.create({
            workspaceId: input.workspaceId,
            contentHash,
            generation,
            byteSize: bytes.length,
            storageKey: key
          });
          return { ok: true, value: { record, reused: false } };
        } catch (error) {
          await unlink(destination).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  async read(record: SourceBlobRecord): Promise<Buffer> {
    const expectedKey = sourceBlobStorageKey(record.workspaceId, record.contentHash, record.generation);
    if (record.storageKey !== expectedKey || record.status === "deleted") {
      throw new SourceBlobIntegrityError("SOURCE_BLOB_INTEGRITY_FAILED", "Source blob record is not readable");
    }
    const absolutePath = path.join(this.options.dataDir, ...expectedKey.split("/"));
    if (!await this.ensureDirectoryChain({
      dataDir: this.options.dataDir,
      segments: sourceBlobDirectorySegments(record)
    })) {
      throw new SourceBlobIntegrityError("SOURCE_BLOB_MISSING", "Source blob directory is missing");
    }
    try {
      return await this.assertFile(absolutePath, record);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new SourceBlobIntegrityError("SOURCE_BLOB_MISSING", "Source blob bytes are missing");
      }
      throw error;
    }
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

  private ensureDirectoryChain(
    input: Omit<Parameters<typeof ensureSafeDirectoryChain>[0], "lstatFile" | "syncDirectory">
  ): Promise<boolean> {
    return ensureSafeDirectoryChain({
      ...input,
      lstatFile: this.options.lstatFile,
      syncDirectory: (directory) => this.syncDir(directory)
    });
  }

  private async lstatFile(candidate: string): Promise<Stats> {
    try {
      return await (this.options.lstatFile ?? lstat)(candidate);
    } catch (error) {
      throw classifySourceBlobAccessError(
        error,
        "Source blob filesystem path is inaccessible",
        "file_access_inaccessible"
      );
    }
  }

  private assertFile(
    candidate: string,
    record: Pick<SourceBlobRecord, "contentHash" | "byteSize">
  ): Promise<Buffer> {
    return assertSourceBlobFile(candidate, record, this.options.openFile, this.options.lstatFile);
  }

  private async syncDir(directory: string): Promise<void> {
    try {
      await (this.options.syncDirectory ?? syncDirectory)(directory);
    } catch (error) {
      throw classifySourceBlobAccessError(
        error,
        "Source blob directory could not be synchronized",
        "directory_sync_inaccessible"
      );
    }
  }
}
