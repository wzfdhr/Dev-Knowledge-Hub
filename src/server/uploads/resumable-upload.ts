import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";

export const MAX_RESUMABLE_UPLOAD_BYTES = 500 * 1024 * 1024;
export const MAX_RESUMABLE_UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024;
export const RESUMABLE_UPLOAD_EXPIRY_MS = 24 * 60 * 60 * 1000;

export type ResumableUploadErrorCode =
  | "CHUNK_ALREADY_RECEIVED"
  | "CHUNK_SIZE_MISMATCH"
  | "CHUNK_INDEX_INVALID"
  | "CHUNK_SIZE_LIMIT"
  | "FINALIZATION_IN_PROGRESS"
  | "INVALID_CHUNK_SIZE"
  | "INVALID_TOTAL_BYTES"
  | "SESSION_CORRUPT"
  | "SESSION_NOT_FOUND"
  | "TOTAL_BYTES_LIMIT"
  | "UPLOAD_INCOMPLETE";

export class ResumableUploadError extends Error {
  constructor(readonly code: ResumableUploadErrorCode, message: string) {
    super(message);
    this.name = "ResumableUploadError";
  }
}

export interface CreateResumableUploadSession {
  totalBytes: number;
  chunkSize: number;
  ownerId?: string;
}

export interface ResumableUploadStatus {
  id: string;
  totalBytes: number;
  chunkSize: number;
  chunkCount: number;
  receivedBytes: number;
  receivedChunks: number;
  complete: boolean;
  finalized: boolean;
}

export interface FinalizedResumableUpload {
  id: string;
  path: string;
  byteSize: number;
}

export interface ResumableUploadCleanupResult {
  sessions: number;
  completed: number;
}

interface SessionMetadata {
  id: string;
  totalBytes: number;
  chunkSize: number;
  ownerId?: string;
}

interface FinalizationMetadata {
  fileName: string;
  byteSize: number;
}

interface Session {
  directory: string;
  metadata: SessionMetadata;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isFinalFileName(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.upload$/i.test(value);
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSessionMetadata(value: unknown): value is SessionMetadata {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SessionMetadata>;
  return typeof candidate.id === "string"
    && isUuid(candidate.id)
    && isSafePositiveInteger(candidate.totalBytes)
    && candidate.totalBytes <= MAX_RESUMABLE_UPLOAD_BYTES
    && isSafePositiveInteger(candidate.chunkSize)
    && candidate.chunkSize <= MAX_RESUMABLE_UPLOAD_CHUNK_BYTES
    && (candidate.ownerId === undefined || (typeof candidate.ownerId === "string" && candidate.ownerId.length > 0));
}

function isFinalizationMetadata(value: unknown): value is FinalizationMetadata {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<FinalizationMetadata>;
  return typeof candidate.fileName === "string"
    && isFinalFileName(candidate.fileName)
    && isSafePositiveInteger(candidate.byteSize);
}

export class ResumableUploadSessionManager {
  private readonly root: string;

  constructor(tempRoot: string) {
    this.root = path.resolve(tempRoot);
  }

  async create({ totalBytes, chunkSize, ownerId }: CreateResumableUploadSession): Promise<ResumableUploadStatus> {
    this.validateDimensions(totalBytes, chunkSize);
    await this.ensureRoots();

    const metadata: SessionMetadata = { id: randomUUID(), totalBytes, chunkSize, ...(ownerId ? { ownerId } : {}) };
    const directory = path.join(this.sessionsDirectory(), metadata.id);
    await mkdir(directory, { mode: 0o700 });
    await mkdir(this.chunksDirectory(directory), { mode: 0o700 });
    await this.writeJsonAtomically(path.join(directory, "session.json"), metadata);
    return this.status(metadata.id, ownerId);
  }

  async status(sessionId: string, ownerId?: string): Promise<ResumableUploadStatus> {
    const session = await this.requireSession(sessionId, ownerId);
    const progress = await this.progress(session);
    const finalized = await this.finalization(session);
    return {
      id: session.metadata.id,
      totalBytes: session.metadata.totalBytes,
      chunkSize: session.metadata.chunkSize,
      chunkCount: this.chunkCount(session.metadata),
      receivedBytes: progress.receivedBytes,
      receivedChunks: progress.receivedChunks,
      complete: progress.receivedBytes === session.metadata.totalBytes
        && progress.receivedChunks === this.chunkCount(session.metadata),
      finalized: finalized !== null
    };
  }

  async uploadChunk(
    sessionId: string,
    index: number,
    content: Uint8Array,
    declaredSize: number,
    ownerId?: string
  ): Promise<ResumableUploadStatus> {
    const session = await this.requireSession(sessionId, ownerId);
    const expectedSize = this.expectedChunkSize(session.metadata, index);
    if (!isSafePositiveInteger(declaredSize) || declaredSize !== expectedSize || content.byteLength !== declaredSize) {
      throw new ResumableUploadError(
        "CHUNK_SIZE_MISMATCH",
        "Chunk size does not match the declared session dimensions"
      );
    }

    const chunkPath = this.chunkPath(session, index);
    const temporaryPath = path.join(this.chunksDirectory(session.directory), `.${randomUUID()}.chunk`);
    try {
      await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
      try {
        await link(temporaryPath, chunkPath);
      } catch (error) {
        if (this.errorCode(error) === "EEXIST") {
          throw new ResumableUploadError("CHUNK_ALREADY_RECEIVED", "Chunk was already received");
        }
        throw error;
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
    return this.status(session.metadata.id, ownerId);
  }

  async finalize(sessionId: string, ownerId?: string): Promise<FinalizedResumableUpload> {
    const session = await this.requireSession(sessionId, ownerId);
    const existing = await this.finalization(session);
    if (existing) return this.finalizedUpload(session.metadata.id, existing);

    const progress = await this.progress(session);
    if (progress.receivedBytes !== session.metadata.totalBytes
      || progress.receivedChunks !== this.chunkCount(session.metadata)) {
      throw new ResumableUploadError("UPLOAD_INCOMPLETE", "Upload is incomplete");
    }

    const lockPath = path.join(session.directory, ".finalizing");
    let lock: Awaited<ReturnType<typeof open>>;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (this.errorCode(error) === "EEXIST") {
        throw new ResumableUploadError("FINALIZATION_IN_PROGRESS", "Upload finalization is already in progress");
      }
      throw error;
    }

    try {
      const finalizedWhileWaiting = await this.finalization(session);
      if (finalizedWhileWaiting) return this.finalizedUpload(session.metadata.id, finalizedWhileWaiting);

      const fileName = `${randomUUID()}.upload`;
      const finalPath = path.join(this.completedDirectory(), fileName);
      const stagingPath = path.join(this.completedDirectory(), `.${randomUUID()}.upload`);
      const output = await open(stagingPath, "wx", 0o600);
      try {
        for (let index = 0; index < this.chunkCount(session.metadata); index += 1) {
          await output.writeFile(await readFile(this.chunkPath(session, index)));
        }
        await output.sync();
      } finally {
        await output.close();
      }
      await rename(stagingPath, finalPath);
      const finalization: FinalizationMetadata = {
        fileName,
        byteSize: session.metadata.totalBytes
      };
      await this.writeJsonAtomically(path.join(session.directory, "finalized.json"), finalization);
      return this.finalizedUpload(session.metadata.id, finalization);
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }

  async discard(sessionId: string, ownerId?: string): Promise<void> {
    const session = await this.requireSession(sessionId, ownerId);
    const finalized = await this.finalization(session);
    if (finalized) {
      await rm(path.join(this.completedDirectory(), finalized.fileName), { force: true });
    }
    await rm(session.directory, { recursive: true, force: true });
  }

  async cleanupExpired(now = new Date()): Promise<ResumableUploadCleanupResult> {
    await this.ensureRoots();
    const expiresAt = now.getTime() - RESUMABLE_UPLOAD_EXPIRY_MS;
    const referencedCompletedFiles = new Set<string>();
    let sessions = 0;

    for (const entry of await readdir(this.sessionsDirectory(), { withFileTypes: true })) {
      if (!entry.isDirectory() || !isUuid(entry.name)) continue;
      const directory = path.join(this.sessionsDirectory(), entry.name);
      const metadataPath = path.join(directory, "session.json");
      const metadataModifiedAt = await this.modifiedAt(metadataPath, directory);
      if (metadataModifiedAt <= expiresAt) {
        await rm(directory, { recursive: true, force: true });
        sessions += 1;
        continue;
      }

      try {
        const finalized = await this.finalization({ directory, metadata: { id: entry.name, totalBytes: 1, chunkSize: 1 } });
        if (finalized) referencedCompletedFiles.add(finalized.fileName);
      } catch {
        // A recent malformed session is left in place for manual investigation.
      }
    }

    let completed = 0;
    for (const entry of await readdir(this.completedDirectory(), { withFileTypes: true })) {
      if (!entry.isFile() || !isFinalFileName(entry.name) || referencedCompletedFiles.has(entry.name)) continue;
      const filePath = path.join(this.completedDirectory(), entry.name);
      if (await this.modifiedAt(filePath) <= expiresAt) {
        await rm(filePath, { force: true });
        completed += 1;
      }
    }

    return { sessions, completed };
  }

  private sessionsDirectory(): string {
    return path.join(this.root, "sessions");
  }

  private completedDirectory(): string {
    return path.join(this.root, "completed");
  }

  private chunksDirectory(sessionDirectory: string): string {
    return path.join(sessionDirectory, "chunks");
  }

  private chunkPath(session: Session, index: number): string {
    return path.join(this.chunksDirectory(session.directory), `chunk-${index}`);
  }

  private async ensureRoots(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(this.sessionsDirectory(), { recursive: true, mode: 0o700 });
    await mkdir(this.completedDirectory(), { recursive: true, mode: 0o700 });
  }

  private validateDimensions(totalBytes: number, chunkSize: number): void {
    if (!isSafePositiveInteger(totalBytes)) {
      throw new ResumableUploadError("INVALID_TOTAL_BYTES", "Total bytes must be a positive integer");
    }
    if (totalBytes > MAX_RESUMABLE_UPLOAD_BYTES) {
      throw new ResumableUploadError("TOTAL_BYTES_LIMIT", "Upload exceeds the 500 MiB limit");
    }
    if (!isSafePositiveInteger(chunkSize)) {
      throw new ResumableUploadError("INVALID_CHUNK_SIZE", "Chunk size must be a positive integer");
    }
    if (chunkSize > MAX_RESUMABLE_UPLOAD_CHUNK_BYTES) {
      throw new ResumableUploadError("CHUNK_SIZE_LIMIT", "Chunk size exceeds the 16 MiB limit");
    }
  }

  private chunkCount(metadata: SessionMetadata): number {
    return Math.ceil(metadata.totalBytes / metadata.chunkSize);
  }

  private expectedChunkSize(metadata: SessionMetadata, index: number): number {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.chunkCount(metadata)) {
      throw new ResumableUploadError("CHUNK_INDEX_INVALID", "Chunk index is outside the session range");
    }
    const finalChunkSize = metadata.totalBytes - (metadata.chunkSize * index);
    return Math.min(metadata.chunkSize, finalChunkSize);
  }

  private async requireSession(sessionId: string, ownerId?: string): Promise<Session> {
    await this.ensureRoots();
    const entries = await readdir(this.sessionsDirectory(), { withFileTypes: true });
    const directoryEntry = entries.find((entry) => entry.isDirectory() && entry.name === sessionId);
    if (!directoryEntry) {
      throw new ResumableUploadError("SESSION_NOT_FOUND", "Upload session was not found");
    }

    const directory = path.join(this.sessionsDirectory(), directoryEntry.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(directory, "session.json"), "utf8"));
    } catch {
      throw new ResumableUploadError("SESSION_CORRUPT", "Upload session metadata is invalid");
    }
    if (!isSessionMetadata(parsed) || parsed.id !== sessionId) {
      throw new ResumableUploadError("SESSION_CORRUPT", "Upload session metadata is invalid");
    }
    if (parsed.ownerId !== undefined && parsed.ownerId !== ownerId) {
      throw new ResumableUploadError("SESSION_NOT_FOUND", "Upload session was not found");
    }
    return { directory, metadata: parsed };
  }

  private async progress(session: Session): Promise<{ receivedBytes: number; receivedChunks: number }> {
    let receivedBytes = 0;
    let receivedChunks = 0;
    for (let index = 0; index < this.chunkCount(session.metadata); index += 1) {
      try {
        const chunk = await lstat(this.chunkPath(session, index));
        if (!chunk.isFile() || chunk.size !== this.expectedChunkSize(session.metadata, index)) {
          throw new ResumableUploadError("SESSION_CORRUPT", "Upload chunk data is invalid");
        }
        receivedBytes += chunk.size;
        receivedChunks += 1;
      } catch (error) {
        if (this.errorCode(error) === "ENOENT") continue;
        throw error;
      }
    }
    return { receivedBytes, receivedChunks };
  }

  private async finalization(session: Session): Promise<FinalizationMetadata | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(session.directory, "finalized.json"), "utf8"));
      if (!isFinalizationMetadata(parsed)) {
        throw new ResumableUploadError("SESSION_CORRUPT", "Finalized upload metadata is invalid");
      }
      return parsed;
    } catch (error) {
      if (this.errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  private finalizedUpload(id: string, finalization: FinalizationMetadata): FinalizedResumableUpload {
    return {
      id,
      path: path.join(this.completedDirectory(), finalization.fileName),
      byteSize: finalization.byteSize
    };
  }

  private async writeJsonAtomically(destination: string, value: object): Promise<void> {
    const temporaryPath = path.join(path.dirname(destination), `.${randomUUID()}.json`);
    try {
      await writeFile(temporaryPath, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(temporaryPath, destination);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async modifiedAt(primaryPath: string, fallbackPath?: string): Promise<number> {
    try {
      return (await lstat(primaryPath)).mtimeMs;
    } catch (error) {
      if (fallbackPath && this.errorCode(error) === "ENOENT") return (await lstat(fallbackPath)).mtimeMs;
      throw error;
    }
  }

  private errorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  }
}
