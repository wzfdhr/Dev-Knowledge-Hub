import { randomUUID } from "node:crypto";
import { lstat, rename, unlink } from "node:fs/promises";

import {
  SourceBlobIntegrityError,
  assertSourceBlobFile,
  ensureSafeDirectoryChain,
  sourceBlobDirectorySegments,
  sourceBlobFileLocations,
  sourceBlobTrashDirectorySegments
} from "./source-blob-store.js";
import type { SourceBlobLstatFile, SourceBlobOpenFile } from "./source-blob-store.js";
import { syncDirectory } from "./folder-import.js";
import { normalizeSourceBlobGcCandidateLimit, sourceBlobGcCursor } from "../persistence/store.js";
import type {
  LockedSourceBlobCatalog,
  SourceBlobCatalog,
  SourceBlobGcCursor,
  SourceBlobRecord
} from "../persistence/store.js";

const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1_000;

export interface SourceBlobGcRunResult {
  scanned: number;
  tombstoned: number;
  restored: number;
  trashed: number;
  deleted: number;
  inconsistent: number;
}

function emptyResult(): SourceBlobGcRunResult {
  return { scanned: 0, tombstoned: 0, restored: 0, trashed: 0, deleted: 0, inconsistent: 0 };
}

async function exists(candidate: string, lstatFile: SourceBlobLstatFile = lstat): Promise<boolean> {
  try {
    await lstatFile(candidate);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) {
      throw new SourceBlobIntegrityError("SOURCE_BLOB_INACCESSIBLE", "Source blob file is inaccessible");
    }
    throw error;
  }
}

function graceElapsed(timestamp: Date | null, graceMs: number, now: Date): boolean {
  return timestamp !== null && now.getTime() - timestamp.getTime() >= graceMs;
}

function cursorsEqual(left: SourceBlobGcCursor, right: SourceBlobGcCursor): boolean {
  return left.workspaceId === right.workspaceId
    && left.contentHash === right.contentHash
    && left.generation === right.generation
    && left.id === right.id;
}

export class SourceBlobGarbageCollector {
  private readonly enabled: boolean;
  private readonly tombstoneGraceMs: number;
  private readonly trashGraceMs: number;
  private readonly now: () => Date;
  private readonly syncDir: typeof syncDirectory;
  private readonly renameFile: typeof rename;
  private readonly candidateLimit: number;

  constructor(private readonly options: {
    dataDir: string;
    catalog: SourceBlobCatalog;
    enabled?: boolean;
    tombstoneGraceMs?: number;
    trashGraceMs?: number;
    now?: () => Date;
    syncDirectory?: typeof syncDirectory;
    renameFile?: typeof rename;
    lstatFile?: SourceBlobLstatFile;
    openFile?: SourceBlobOpenFile;
    candidateLimit?: number;
  }) {
    this.enabled = options.enabled ?? false;
    this.tombstoneGraceMs = options.tombstoneGraceMs ?? DEFAULT_GRACE_MS;
    this.trashGraceMs = options.trashGraceMs ?? DEFAULT_GRACE_MS;
    this.now = options.now ?? (() => new Date());
    this.syncDir = options.syncDirectory ?? syncDirectory;
    this.renameFile = options.renameFile ?? rename;
    this.candidateLimit = normalizeSourceBlobGcCandidateLimit(options.candidateLimit);
    if (this.tombstoneGraceMs < 0 || this.trashGraceMs < 0) {
      throw new RangeError("Source blob GC grace periods must be non-negative");
    }
  }

  async runOnce(): Promise<SourceBlobGcRunResult> {
    if (!this.enabled) return emptyResult();
    const result = emptyResult();
    const boundary = await this.options.catalog.findSourceBlobGcRunBoundary();
    if (!boundary) return result;
    const { through } = boundary;
    const now = this.now();
    let after: SourceBlobGcCursor | undefined;
    while (true) {
      const candidates = await this.options.catalog.listSourceBlobGcCandidates({
        ...(after ? { after } : {}),
        ...boundary,
        limit: this.candidateLimit
      });
      if (candidates.length === 0) break;
      result.scanned += candidates.length;
      for (const candidate of candidates) {
        const processed = await this.options.catalog.withSourceBlobLock(
          candidate.workspaceId,
          candidate.contentHash,
          async (catalog) => this.processGeneration(catalog, candidate, now)
        );
        result.tombstoned += processed.tombstoned;
        result.restored += processed.restored;
        result.trashed += processed.trashed;
        result.deleted += processed.deleted;
        result.inconsistent += processed.inconsistent;
      }
      after = sourceBlobGcCursor(candidates.at(-1)!);
      if (candidates.length < this.candidateLimit || cursorsEqual(after, through)) break;
    }
    return result;
  }

  private async processGeneration(
    catalog: LockedSourceBlobCatalog,
    candidate: SourceBlobRecord,
    now: Date
  ): Promise<SourceBlobGcRunResult> {
    const result = emptyResult();
    const current = await catalog.findById(candidate.id);
    if (!current || current.generation !== candidate.generation) return result;
    const references = await catalog.countReferences(current.id);

    if (current.status === "active") {
      if (references > 0) return result;
      try {
        const locations = sourceBlobFileLocations(this.options.dataDir, current);
        const sourceDirectoryExists = await this.ensureDirectoryChain({
          dataDir: this.options.dataDir,
          segments: sourceBlobDirectorySegments(current)
        });
        if (!sourceDirectoryExists) {
          throw new SourceBlobIntegrityError("SOURCE_BLOB_MISSING", "Source blob directory is missing");
        }
        await this.assertFile(locations.source, current);
      } catch (error) {
        if (error instanceof SourceBlobIntegrityError
          || error instanceof Error && "code" in error && error.code === "ENOENT") {
          const reason = error instanceof SourceBlobIntegrityError
            && error.code === "SOURCE_BLOB_INACCESSIBLE"
            ? "active_file_inaccessible"
            : "active_file_inconsistent";
          await this.inconsistent(catalog, current, reason, result);
          return result;
        }
        throw error;
      }
      const tombstoned = await catalog.tombstoneIfUnreferenced(current.id, randomUUID(), now);
      if (tombstoned) result.tombstoned = 1;
      return result;
    }
    if (current.status === "deleted") return result;

    let locations: ReturnType<typeof sourceBlobFileLocations>;
    try {
      locations = sourceBlobFileLocations(this.options.dataDir, current);
    } catch (error) {
      if (error instanceof SourceBlobIntegrityError) {
        await this.inconsistent(catalog, current, "invalid_storage_key", result);
        return result;
      }
      throw error;
    }

    try {
      const sourceDirectoryExists = await this.ensureDirectoryChain({
        dataDir: this.options.dataDir,
        segments: sourceBlobDirectorySegments(current)
      });
      if (!sourceDirectoryExists) {
        await this.inconsistent(catalog, current, "source_directory_missing", result);
        return result;
      }
      const trashDirectoryExists = await this.ensureDirectoryChain({
        dataDir: this.options.dataDir,
        segments: sourceBlobTrashDirectorySegments(current)
      });
      if (current.status === "tombstoned") {
        await this.processTombstone(
          catalog, current, references, locations, trashDirectoryExists, now, result
        );
      } else {
        await this.processTrash(catalog, current, references, locations, trashDirectoryExists, now, result);
      }
    } catch (error) {
      if (error instanceof SourceBlobIntegrityError
        || error instanceof Error && "code" in error && error.code === "ENOENT") {
        await this.inconsistent(catalog, current, "file_verification_failed", result);
        return result;
      }
      throw error;
    }
    return result;
  }

  private async processTombstone(
    catalog: LockedSourceBlobCatalog,
    record: SourceBlobRecord,
    references: number,
    locations: ReturnType<typeof sourceBlobFileLocations>,
    trashDirectoryExists: boolean,
    now: Date,
    result: SourceBlobGcRunResult
  ): Promise<void> {
    if (!record.fencingToken || !record.tombstonedAt) {
      await this.inconsistent(catalog, record, "invalid_tombstone_state", result);
      return;
    }
    const [sourceExists, trashExists] = await Promise.all([
      exists(locations.source, this.options.lstatFile),
      trashDirectoryExists ? exists(locations.trash, this.options.lstatFile) : false
    ]);
    if (sourceExists === trashExists) {
      await this.inconsistent(catalog, record, "tombstone_location_inconsistent", result);
      return;
    }

    if (references > 0) {
      if (sourceExists) {
        await this.assertFile(locations.source, record);
        const restored = await catalog.restoreTombstoned(record.id, record.fencingToken);
        if (restored) result.restored = 1;
        else await this.inconsistent(catalog, record, "restore_fence_conflict", result);
      } else {
        await this.assertFile(locations.trash, record);
        await this.inconsistent(catalog, record, "referenced_tombstone_moved", result);
      }
      return;
    }

    if (sourceExists) {
      await this.assertFile(locations.source, record);
      if (!graceElapsed(record.tombstonedAt, this.tombstoneGraceMs, now)) return;
      await this.ensureDirectoryChain({
        dataDir: this.options.dataDir,
        segments: sourceBlobTrashDirectorySegments(record),
        createMissing: true,
        syncFinal: true,
        syncDirectory: this.syncDir
      });
      if (!await this.ensureDirectoryChain({
        dataDir: this.options.dataDir,
        segments: sourceBlobDirectorySegments(record)
      })) {
        throw new SourceBlobIntegrityError("SOURCE_BLOB_MISSING", "Source blob directory is missing");
      }
      await this.renameFile(locations.source, locations.trash);
      await Promise.all([
        this.syncDir(locations.sourceParent),
        this.syncDir(locations.trashParent)
      ]);
    } else {
      await this.assertFile(locations.trash, record);
      await Promise.all([
        this.syncDir(locations.sourceParent),
        this.syncDir(locations.trashParent)
      ]);
    }

    const trashed = await catalog.markTrash(record.id, record.fencingToken, now);
    if (trashed) result.trashed = 1;
    else await this.inconsistent(catalog, record, "trash_fence_conflict", result);
  }

  private async processTrash(
    catalog: LockedSourceBlobCatalog,
    record: SourceBlobRecord,
    references: number,
    locations: ReturnType<typeof sourceBlobFileLocations>,
    trashDirectoryExists: boolean,
    now: Date,
    result: SourceBlobGcRunResult
  ): Promise<void> {
    if (!record.fencingToken || !record.trashedAt) {
      await this.inconsistent(catalog, record, "invalid_trash_state", result);
      return;
    }
    if (references > 0) {
      await this.inconsistent(catalog, record, "referenced_trash", result);
      return;
    }
    const [sourceExists, trashExists] = await Promise.all([
      exists(locations.source, this.options.lstatFile),
      trashDirectoryExists ? exists(locations.trash, this.options.lstatFile) : false
    ]);
    if (sourceExists) {
      await this.inconsistent(catalog, record, "trash_source_present", result);
      return;
    }
    if (!trashExists) {
      await this.ensureDirectoryChain({
        dataDir: this.options.dataDir,
        segments: sourceBlobTrashDirectorySegments(record),
        createMissing: true,
        syncFinal: true,
        syncDirectory: this.syncDir
      });
      const deleted = await catalog.markDeletedIfUnreferenced(record.id, record.fencingToken, now);
      if (deleted) result.deleted = 1;
      else await this.inconsistent(catalog, record, "delete_fence_conflict", result);
      return;
    }

    await this.assertFile(locations.trash, record);
    if (!graceElapsed(record.trashedAt, this.trashGraceMs, now)) return;
    if (!await this.ensureDirectoryChain({
      dataDir: this.options.dataDir,
      segments: sourceBlobTrashDirectorySegments(record)
    })) {
      throw new SourceBlobIntegrityError("SOURCE_BLOB_MISSING", "Source blob trash directory is missing");
    }
    await unlink(locations.trash);
    await this.syncDir(locations.trashParent);
    const deleted = await catalog.markDeletedIfUnreferenced(record.id, record.fencingToken, now);
    if (deleted) result.deleted = 1;
    else await this.inconsistent(catalog, record, "delete_fence_conflict", result);
  }

  private async inconsistent(
    catalog: LockedSourceBlobCatalog,
    record: SourceBlobRecord,
    reason: string,
    result: SourceBlobGcRunResult
  ): Promise<void> {
    await catalog.recordGcInconsistency(record.id, reason);
    result.inconsistent = 1;
  }

  private ensureDirectoryChain(
    input: Omit<Parameters<typeof ensureSafeDirectoryChain>[0], "lstatFile">
  ): Promise<boolean> {
    return ensureSafeDirectoryChain({ ...input, lstatFile: this.options.lstatFile });
  }

  private assertFile(
    candidate: string,
    record: Pick<SourceBlobRecord, "contentHash" | "byteSize">
  ): Promise<Buffer> {
    return assertSourceBlobFile(candidate, record, this.options.openFile, this.options.lstatFile);
  }
}
