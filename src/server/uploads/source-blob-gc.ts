import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, unlink } from "node:fs/promises";

import {
  SourceBlobIntegrityError,
  assertSourceBlobFile,
  sourceBlobFileLocations
} from "./source-blob-store.js";
import { syncDirectory } from "./folder-import.js";
import { normalizeSourceBlobGcCandidateLimit } from "../persistence/store.js";
import type {
  LockedSourceBlobCatalog,
  SourceBlobCatalog,
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

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function graceElapsed(timestamp: Date | null, graceMs: number, now: Date): boolean {
  return timestamp !== null && now.getTime() - timestamp.getTime() >= graceMs;
}

export class SourceBlobGarbageCollector {
  private readonly enabled: boolean;
  private readonly tombstoneGraceMs: number;
  private readonly trashGraceMs: number;
  private readonly now: () => Date;
  private readonly syncDir: typeof syncDirectory;
  private readonly candidateLimit: number;

  constructor(private readonly options: {
    dataDir: string;
    catalog: SourceBlobCatalog;
    enabled?: boolean;
    tombstoneGraceMs?: number;
    trashGraceMs?: number;
    now?: () => Date;
    syncDirectory?: typeof syncDirectory;
    candidateLimit?: number;
  }) {
    this.enabled = options.enabled ?? false;
    this.tombstoneGraceMs = options.tombstoneGraceMs ?? DEFAULT_GRACE_MS;
    this.trashGraceMs = options.trashGraceMs ?? DEFAULT_GRACE_MS;
    this.now = options.now ?? (() => new Date());
    this.syncDir = options.syncDirectory ?? syncDirectory;
    this.candidateLimit = normalizeSourceBlobGcCandidateLimit(options.candidateLimit);
    if (this.tombstoneGraceMs < 0 || this.trashGraceMs < 0) {
      throw new RangeError("Source blob GC grace periods must be non-negative");
    }
  }

  async runOnce(): Promise<SourceBlobGcRunResult> {
    if (!this.enabled) return emptyResult();
    const candidates = await this.options.catalog.listSourceBlobGcCandidates(this.candidateLimit);
    const result = emptyResult();
    result.scanned = candidates.length;
    const now = this.now();
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
      if (current.status === "tombstoned") {
        await this.processTombstone(catalog, current, references, locations, now, result);
      } else {
        await this.processTrash(catalog, current, references, locations, now, result);
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
    now: Date,
    result: SourceBlobGcRunResult
  ): Promise<void> {
    if (!record.fencingToken || !record.tombstonedAt) {
      await this.inconsistent(catalog, record, "invalid_tombstone_state", result);
      return;
    }
    const [sourceExists, trashExists] = await Promise.all([
      exists(locations.source),
      exists(locations.trash)
    ]);
    if (sourceExists === trashExists) {
      await this.inconsistent(catalog, record, "tombstone_location_inconsistent", result);
      return;
    }

    if (references > 0) {
      if (sourceExists) {
        await assertSourceBlobFile(locations.source, record);
        const restored = await catalog.restoreTombstoned(record.id, record.fencingToken);
        if (restored) result.restored = 1;
        else await this.inconsistent(catalog, record, "restore_fence_conflict", result);
      } else {
        await assertSourceBlobFile(locations.trash, record);
        await this.inconsistent(catalog, record, "referenced_tombstone_moved", result);
      }
      return;
    }

    if (sourceExists) {
      await assertSourceBlobFile(locations.source, record);
      if (!graceElapsed(record.tombstonedAt, this.tombstoneGraceMs, now)) return;
      await mkdir(locations.trashParent, { recursive: true, mode: 0o700 });
      await rename(locations.source, locations.trash);
      await Promise.all([
        this.syncDir(locations.sourceParent),
        this.syncDir(locations.trashParent)
      ]);
    } else {
      await assertSourceBlobFile(locations.trash, record);
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
      exists(locations.source),
      exists(locations.trash)
    ]);
    if (sourceExists) {
      await this.inconsistent(catalog, record, "trash_source_present", result);
      return;
    }
    if (!trashExists) {
      const deleted = await catalog.markDeletedIfUnreferenced(record.id, record.fencingToken, now);
      if (deleted) result.deleted = 1;
      else await this.inconsistent(catalog, record, "delete_fence_conflict", result);
      return;
    }

    await assertSourceBlobFile(locations.trash, record);
    if (!graceElapsed(record.trashedAt, this.trashGraceMs, now)) return;
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
}
