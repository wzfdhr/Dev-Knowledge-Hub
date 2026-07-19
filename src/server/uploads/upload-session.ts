import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  filterImportFile,
  isExcludedImportDirectory,
  isImportAssetPath,
  MAX_UPLOAD_MANIFEST_METADATA_BYTES
} from "../../shared/import-filter.js";
import type {
  AppStore,
  UploadManifestEntryInput,
  UploadManifestEntryRecord,
  UploadSessionRecord
} from "../persistence/store.js";
import {
  FolderUploadError,
  ensureDurableSubdirectory,
  importFolderFiles,
  PENDING_UPLOAD_SNAPSHOT_MARKER,
  removePendingSnapshotMarker,
  removeReadOnlyTree,
  safeFolderUploadPath,
  syncDirectory,
  writeDurableJsonMarker
} from "./folder-import.js";

export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
export const UPLOAD_MANIFEST_PAGE_SIZE = 500;
const UPLOAD_SESSION_MARKER = ".devkh-upload-session.json";

export type UploadSessionErrorCode =
  | "IDEMPOTENCY_KEY_REUSED"
  | "INVALID_UPLOAD_MANIFEST"
  | "MANIFEST_DIGEST_MISMATCH"
  | "MANIFEST_PAGE_LIMIT"
  | "MANIFEST_METADATA_LIMIT"
  | "TOO_MANY_FILES"
  | "FOLDER_SIZE_LIMIT"
  | "EMPTY_FOLDER_UPLOAD"
  | "UPLOAD_HASH_MISMATCH"
  | "UPLOAD_INCOMPLETE"
  | "UPLOAD_MANIFEST_CONFLICT"
  | "UPLOAD_NOT_REQUIRED"
  | "UPLOAD_SESSION_EXPIRED"
  | "UPLOAD_SESSION_INVALIDATED"
  | "UPLOAD_SESSION_NOT_FOUND"
  | "UPLOAD_SESSION_STATE";

export class UploadSessionError extends Error {
  constructor(readonly code: UploadSessionErrorCode, message: string, readonly statusCode = 400) {
    super(message);
    this.name = "UploadSessionError";
  }
}

export interface ClientUploadManifestEntry {
  ordinal: number;
  path: string;
  kind: "source" | "asset";
  byteSize: number;
  contentHash: string | null;
  mediaType?: string | null;
}

interface UploadCommitResponse extends Record<string, unknown> {
  snapshotId: string;
  sourceVersion: string;
  fileCount: number;
  textBytes: number;
  unchanged: boolean;
  ignored: { total: number; reasons: Record<string, number> };
  assetCount: number;
}

interface ManifestAnalysis {
  accepted: UploadManifestEntryRecord[];
  ignored: { total: number; reasons: Record<string, number> };
  assetCount: number;
  entryCount: number;
  digest: string;
}

function canonicalEntry(entry: ClientUploadManifestEntry) {
  return {
    ordinal: entry.ordinal,
    path: entry.path,
    kind: entry.kind,
    byteSize: entry.byteSize,
    contentHash: entry.contentHash,
    mediaType: entry.mediaType ?? null
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function canonicalUploadManifestDigest(entries: ClientUploadManifestEntry[]): string {
  return digest([...entries].sort((left, right) => left.ordinal - right.ordinal).map(canonicalEntry));
}

function deterministicSessionId(workspaceId: string, actorId: string, key: string): string {
  const bytes = Buffer.from(createHash("sha256").update(`${workspaceId}\0${actorId}\0${key}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uploadDirectory(dataDir: string, sessionId: string): string {
  return path.join(dataDir, "uploads", "sessions", sessionId);
}

function uploadFilePath(dataDir: string, sessionId: string, ordinal: number): string {
  return path.join(uploadDirectory(dataDir, sessionId), "files", String(ordinal));
}

function roleAllowsUpload(role: string | null, administratorRequired: boolean): boolean {
  return role === "admin" || (!administratorRequired && role === "member");
}

function ignoredEntry(entry: ClientUploadManifestEntry, reason: string): UploadManifestEntryInput {
  return {
    ...canonicalEntry(entry),
    metadataByteSize: Buffer.byteLength(JSON.stringify(canonicalEntry(entry)), "utf8"),
    disposition: "ignored",
    trust: "client_unverified",
    ignoreReason: reason
  };
}

function classifyEntry(entry: ClientUploadManifestEntry): UploadManifestEntryInput {
  let filePath: string;
  try {
    filePath = safeFolderUploadPath(entry.path);
  } catch (error) {
    if (error instanceof FolderUploadError) {
      throw new UploadSessionError("INVALID_UPLOAD_MANIFEST", error.message);
    }
    throw error;
  }
  if (Buffer.byteLength(filePath, "utf8") > 4096) {
    throw new UploadSessionError("INVALID_UPLOAD_MANIFEST", "Upload manifest path exceeds 4096 UTF-8 bytes");
  }
  if (!Number.isSafeInteger(entry.ordinal) || entry.ordinal < 0
    || !Number.isSafeInteger(entry.byteSize) || entry.byteSize < 0) {
    throw new UploadSessionError("INVALID_UPLOAD_MANIFEST", "Upload manifest entry is invalid");
  }
  const normalized = { ...entry, path: filePath };
  if (entry.kind === "asset") {
    if (entry.contentHash !== null) {
      throw new UploadSessionError("INVALID_UPLOAD_MANIFEST", "Asset entries must not include content hashes");
    }
    if (filePath.split("/").some(isExcludedImportDirectory)) {
      return ignoredEntry(normalized, "excluded_directory");
    }
    if (!isImportAssetPath(filePath)) return ignoredEntry(normalized, "unsupported_extension");
    return {
      ...canonicalEntry(normalized),
      metadataByteSize: Buffer.byteLength(JSON.stringify(canonicalEntry(normalized)), "utf8"),
      disposition: "metadata_only",
      trust: "client_unverified",
      ignoreReason: null
    };
  }
  if (!entry.contentHash || !/^[a-f0-9]{64}$/u.test(entry.contentHash)) {
    throw new UploadSessionError("INVALID_UPLOAD_MANIFEST", "Source entries require a SHA-256 content hash");
  }
  const decision = filterImportFile({ path: filePath, byteSize: entry.byteSize });
  if (!decision.accepted) return ignoredEntry(normalized, decision.reason);
  return {
    ...canonicalEntry(normalized),
    metadataByteSize: Buffer.byteLength(JSON.stringify(canonicalEntry(normalized)), "utf8"),
    disposition: "upload_required",
    trust: "pending",
    ignoreReason: null
  };
}

interface Identity {
  workspaceId: string;
  projectId: string;
  actorId: string;
  sessionVersion: number;
}

export class UploadSessionService {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly options: {
    store: AppStore;
    dataDir: string;
    now?: () => Date;
  }) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async withSessionLock<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.locks.set(sessionId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(sessionId) === tail) this.locks.delete(sessionId);
    }
  }

  private async withPersistentSessionLock<T>(
    workspaceId: string,
    sessionId: string,
    action: () => Promise<T>
  ): Promise<T> {
    return this.withSessionLock(sessionId, async () => {
      const release = await this.options.store.acquireUploadSessionLock(workspaceId, sessionId);
      try {
        return await action();
      } finally {
        await release();
      }
    });
  }

  private async withMutationLock<T>(
    identity: Identity,
    sessionId: string,
    idempotencyKey: string,
    action: () => Promise<T>
  ): Promise<T> {
    return this.withSessionLock(sessionId, async () => {
      const release = await this.options.store.acquireUploadMutationLock(
        identity.workspaceId, sessionId, identity.actorId, idempotencyKey
      );
      try {
        return await action();
      } finally {
        await release();
      }
    });
  }

  private async authorizedSession(identity: Identity, sessionId: string): Promise<UploadSessionRecord> {
    const session = await this.options.store.getUploadSession(identity.workspaceId, sessionId);
    if (!session) throw new UploadSessionError("UPLOAD_SESSION_NOT_FOUND", "Upload session was not found", 404);
    const actor = await this.options.store.findAdminById(identity.actorId, identity.workspaceId);
    const access = actor
      ? await this.options.store.projectAccess(identity.workspaceId, session.projectId, identity.actorId)
      : null;
    const repository = await this.options.store.getRepository(identity.workspaceId, session.repositoryId);
    if (session.projectId !== identity.projectId
      || session.actorId !== identity.actorId || session.sessionVersion !== identity.sessionVersion
      || !actor || actor.disabledAt || actor.sessionVersion !== identity.sessionVersion
      || !access || !repository || repository.projectId !== session.projectId
      || !roleAllowsUpload(access.role, Boolean(repository.archivedAt))) {
      throw new UploadSessionError("UPLOAD_SESSION_INVALIDATED", "Upload session authorization is no longer valid", 403);
    }
    if (session.expiresAt <= this.now() && session.status !== "committed") {
      throw new UploadSessionError("UPLOAD_SESSION_EXPIRED", "Upload session has expired", 410);
    }
    return session;
  }

  private async idempotent<T extends Record<string, unknown>>(input: {
    identity: Identity;
    key: string;
    operation: string;
    request: unknown;
    sessionId: string | null;
    statusCode: number;
    cacheErrors?: boolean;
    refreshReplay?(cached: T): Promise<T>;
    action(): Promise<T>;
  }): Promise<T> {
    if (!input.key || input.key.length > 200) {
      throw new UploadSessionError("INVALID_UPLOAD_MANIFEST", "A valid Idempotency-Key is required");
    }
    const requestDigest = digest(input.request);
    const existing = await this.options.store.findUploadIdempotencyKey(
      input.identity.workspaceId,
      input.identity.actorId,
      input.key,
      this.now()
    );
    if (existing) {
      if (existing.operation !== input.operation || existing.requestDigest !== requestDigest) {
        throw new UploadSessionError("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used for another request", 409);
      }
      const cachedError = existing.responseBody.__uploadError as {
        code?: UploadSessionErrorCode; message?: string; statusCode?: number;
      } | undefined;
      if (cachedError?.code && cachedError.message && cachedError.statusCode) {
        throw new UploadSessionError(cachedError.code, cachedError.message, cachedError.statusCode);
      }
      const cached = existing.responseBody as T;
      return input.refreshReplay ? input.refreshReplay(cached) : cached;
    }
    let response: T;
    try {
      response = await input.action();
    } catch (error) {
      if (input.cacheErrors && error instanceof UploadSessionError) {
        await this.options.store.saveUploadIdempotencyKey({
          workspaceId: input.identity.workspaceId,
          actorId: input.identity.actorId,
          idempotencyKey: input.key,
          operation: input.operation,
          requestDigest,
          sessionId: input.sessionId,
          responseStatus: error.statusCode,
          responseBody: {
            __uploadError: { code: error.code, message: error.message, statusCode: error.statusCode }
          },
          expiresAt: new Date(this.now().getTime() + UPLOAD_SESSION_TTL_MS)
        });
      }
      throw error;
    }
    const saved = await this.options.store.saveUploadIdempotencyKey({
      workspaceId: input.identity.workspaceId,
      actorId: input.identity.actorId,
      idempotencyKey: input.key,
      operation: input.operation,
      requestDigest,
      sessionId: input.sessionId,
      responseStatus: input.statusCode,
      responseBody: response,
      expiresAt: new Date(this.now().getTime() + UPLOAD_SESSION_TTL_MS)
    });
    if (saved.operation !== input.operation || saved.requestDigest !== requestDigest) {
      throw new UploadSessionError("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used for another request", 409);
    }
    return saved.responseBody as T;
  }

  async createSession(input: Identity & {
    projectId: string;
    repositoryId: string;
    entryCount: number;
    idempotencyKey: string;
  }) {
    if (!Number.isSafeInteger(input.entryCount) || input.entryCount < 1 || input.entryCount > 100_000) {
      throw new UploadSessionError("INVALID_UPLOAD_MANIFEST", "Upload manifest entry count is invalid");
    }
    const id = deterministicSessionId(input.workspaceId, input.actorId, input.idempotencyKey);
    const existingSession = await this.options.store.getUploadSession(input.workspaceId, id);
    const actor = await this.options.store.findAdminById(input.actorId, input.workspaceId);
    const access = actor ? await this.options.store.projectAccess(input.workspaceId, input.projectId, input.actorId) : null;
    const repository = await this.options.store.getRepository(input.workspaceId, input.repositoryId);
    const currentRepository = await this.options.store.currentRepository(input.workspaceId, input.projectId);
    if (!actor || actor.disabledAt || actor.sessionVersion !== input.sessionVersion
      || !access || !roleAllowsUpload(access.role, Boolean(repository?.archivedAt))
      || !repository || repository.projectId !== input.projectId || repository.kind !== "upload"
      || !currentRepository) {
      throw new UploadSessionError("UPLOAD_SESSION_INVALIDATED", "Upload session cannot be created for this project", 403);
    }
    if (repository.archivedAt && !existingSession
      && await this.options.store.latestSnapshot(input.workspaceId, repository.id)) {
      throw new UploadSessionError("UPLOAD_SESSION_INVALIDATED", "Pending upload replacement was not found", 409);
    }
    return this.withMutationLock(input, id, input.idempotencyKey, async () => this.idempotent({
      identity: input,
      key: input.idempotencyKey,
      operation: "create",
      request: {
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        entryCount: input.entryCount,
        sessionVersion: input.sessionVersion
      },
      sessionId: id,
      statusCode: 201,
      action: async () => {
        const persistedBeforeCreate = await this.options.store.getUploadSession(input.workspaceId, id);
        if (!persistedBeforeCreate) {
          await rm(uploadDirectory(this.options.dataDir, id), { recursive: true, force: true });
          const sessionDirectory = await ensureDurableSubdirectory(
            this.options.dataDir, ["uploads", "sessions", id]
          );
          await writeDurableJsonMarker(sessionDirectory, UPLOAD_SESSION_MARKER, {
            workspaceId: input.workspaceId,
            sessionId: id
          }, 0o600);
        }
        let session: UploadSessionRecord;
        try {
          session = await this.options.store.createUploadSession({
            id,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            repositoryId: input.repositoryId,
            actorId: input.actorId,
            sessionVersion: input.sessionVersion,
            isReplacement: Boolean(repository.archivedAt),
            expectedCurrentRepositoryId: currentRepository.id,
            entryCount: input.entryCount,
            expiresAt: new Date(this.now().getTime() + UPLOAD_SESSION_TTL_MS)
          });
        } catch (error) {
          if (error instanceof Error && error.message === "UPLOAD_SESSION_INVALIDATED") {
            throw new UploadSessionError("UPLOAD_SESSION_INVALIDATED", "The current upload source changed", 409);
          }
          throw error;
        }
        if (session.expiresAt <= this.now() && session.status !== "committed") {
          throw new UploadSessionError("UPLOAD_SESSION_EXPIRED", "Upload session has expired", 410);
        }
        await ensureDurableSubdirectory(this.options.dataDir, ["uploads", "sessions", id]);
        return {
          id: session.id,
          status: session.status,
          entryCount: session.entryCount,
          expiresAt: session.expiresAt.toISOString()
        };
      }
    }));
  }

  async putManifestPage(input: Identity & {
    sessionId: string;
    page: number;
    entries: ClientUploadManifestEntry[];
    idempotencyKey: string;
  }) {
    return this.withMutationLock(input, input.sessionId, input.idempotencyKey, async () => {
      const session = await this.authorizedSession(input, input.sessionId);
      if (!Number.isSafeInteger(input.page) || input.page < 0 || input.entries.length < 1
        || input.entries.length > UPLOAD_MANIFEST_PAGE_SIZE) {
        throw new UploadSessionError("MANIFEST_PAGE_LIMIT", "Upload manifest pages contain at most 500 entries");
      }
      const classified = input.entries.map(classifyEntry);
      const ordinals = new Set<number>();
      const paths = new Set<string>();
      for (const entry of classified) {
        if (entry.ordinal >= session.entryCount || Math.floor(entry.ordinal / UPLOAD_MANIFEST_PAGE_SIZE) !== input.page
          || ordinals.has(entry.ordinal) || paths.has(entry.path)) {
          throw new UploadSessionError("INVALID_UPLOAD_MANIFEST", "Upload manifest page has invalid ordinals or paths");
        }
        ordinals.add(entry.ordinal);
        paths.add(entry.path);
      }
      return this.idempotent({
        identity: input,
        key: input.idempotencyKey,
        operation: `manifest:${input.sessionId}:${input.page}`,
        request: input.entries.map(canonicalEntry),
        sessionId: input.sessionId,
        statusCode: 200,
        refreshReplay: async () => {
          const current = await this.options.store.listUploadManifestEntries(
            input.workspaceId,
            input.sessionId,
            { limit: UPLOAD_MANIFEST_PAGE_SIZE, offset: input.page * UPLOAD_MANIFEST_PAGE_SIZE }
          );
          const requestedOrdinals = new Set(classified.map((entry) => entry.ordinal));
          return { entries: current.filter((entry) => requestedOrdinals.has(entry.ordinal)).map(entryDto) };
        },
        action: async () => {
          if (session.status !== "open") {
            throw new UploadSessionError("UPLOAD_SESSION_STATE", "Upload manifest is not open", 409);
          }
          let entries: UploadManifestEntryRecord[];
          try {
            entries = await this.options.store.saveUploadManifestPage(input, classified);
          } catch (error) {
            if (error instanceof Error && error.message.includes("UPLOAD_MANIFEST_CONFLICT")) {
              throw new UploadSessionError("UPLOAD_MANIFEST_CONFLICT", "Upload manifest conflicts with an existing page", 409);
            }
            if (error instanceof Error && error.message === "TOO_MANY_FILES") {
              throw new UploadSessionError("TOO_MANY_FILES", "Upload contains more than 50,000 accepted source files", 413);
            }
            if (error instanceof Error && error.message === "FOLDER_SIZE_LIMIT") {
              throw new UploadSessionError("FOLDER_SIZE_LIMIT", "Upload exceeds the 2 GiB source limit", 413);
            }
            if (error instanceof Error && error.message === "MANIFEST_METADATA_LIMIT") {
              throw new UploadSessionError(
                "MANIFEST_METADATA_LIMIT",
                `Upload manifest metadata exceeds ${MAX_UPLOAD_MANIFEST_METADATA_BYTES / 1024 / 1024} MiB`,
                413
              );
            }
            throw error;
          }
          return { entries: entries.map(entryDto) };
        }
      });
    });
  }

  async putFile(input: Identity & {
    sessionId: string;
    ordinal: number;
    bytes: Uint8Array;
    idempotencyKey: string;
  }) {
    return this.withMutationLock(input, input.sessionId, input.idempotencyKey, async () => {
      const session = await this.authorizedSession(input, input.sessionId);
      const contentHash = createHash("sha256").update(input.bytes).digest("hex");
      return this.idempotent({
        identity: input,
        key: input.idempotencyKey,
        operation: `file:${input.sessionId}:${input.ordinal}`,
        request: { ordinal: input.ordinal, byteSize: input.bytes.byteLength, contentHash },
        sessionId: input.sessionId,
        statusCode: 200,
        cacheErrors: true,
        action: async () => {
          if (session.status !== "open") {
            throw new UploadSessionError("UPLOAD_SESSION_STATE", "Upload files are not accepted in this state", 409);
          }
          const entry = await this.options.store.getUploadManifestEntry(
            input.workspaceId, input.sessionId, input.ordinal
          );
          if (!entry) {
            throw new UploadSessionError("UPLOAD_SESSION_NOT_FOUND", "Upload manifest entry was not found", 404);
          }
          if (entry.disposition !== "upload_required") {
            throw new UploadSessionError("UPLOAD_NOT_REQUIRED", "This manifest entry does not accept uploaded bytes", 409);
          }
          if (entry.byteSize !== input.bytes.byteLength || entry.contentHash !== contentHash) {
            throw new UploadSessionError("UPLOAD_HASH_MISMATCH", "Uploaded bytes do not match the manifest", 422);
          }
          const decision = filterImportFile({ path: entry.path, byteSize: input.bytes.byteLength, content: input.bytes });
          if (!decision.accepted) {
            const ignored = await this.options.store.verifyUploadManifestEntry(
              input, input.ordinal,
              { disposition: "ignored", trust: "server_verified", ignoreReason: decision.reason }
            );
            if (!ignored) throw new UploadSessionError("UPLOAD_SESSION_STATE", "Upload entry could not be verified", 409);
            return entryDto(ignored);
          }
          const destination = uploadFilePath(this.options.dataDir, input.sessionId, input.ordinal);
          await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          await syncDirectory(path.dirname(path.dirname(destination)));
          const temporary = `${destination}.${randomUUID()}.tmp`;
          const handle = await open(temporary, "wx", 0o600);
          try {
            await handle.writeFile(input.bytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporary, destination);
          await syncDirectory(path.dirname(destination));
          const verified = await this.options.store.verifyUploadManifestEntry(
            input, input.ordinal,
            { disposition: "upload_required", trust: "server_verified", ignoreReason: null }
          );
          if (!verified) throw new UploadSessionError("UPLOAD_SESSION_STATE", "Upload entry could not be verified", 409);
          return entryDto(verified);
        }
      });
    });
  }

  async commit(input: Identity & {
    sessionId: string;
    manifestDigest: string;
    idempotencyKey: string;
  }) {
    return this.withMutationLock(input, input.sessionId, input.idempotencyKey, async () => {
      const session = await this.authorizedSession(input, input.sessionId);
      return this.idempotent({
        identity: input,
        key: input.idempotencyKey,
        operation: `commit:${input.sessionId}`,
        request: { manifestDigest: input.manifestDigest },
        sessionId: input.sessionId,
        statusCode: 201,
        action: async () => {
          if (session.status === "cancelled") {
            throw new UploadSessionError("UPLOAD_SESSION_STATE", "Cancelled upload cannot be committed", 409);
          }
          const manifest = await this.analyzeManifest(session);
          if (manifest.entryCount !== session.entryCount) {
            throw new UploadSessionError("UPLOAD_INCOMPLETE", "Upload manifest is incomplete", 409);
          }
          if (input.manifestDigest !== manifest.digest) {
            throw new UploadSessionError("MANIFEST_DIGEST_MISMATCH", "Upload manifest digest does not match", 409);
          }
          if (session.status === "committed" && session.snapshotId) {
            return this.committedSummary(session, manifest);
          }
          if (manifest.accepted.some((entry) => entry.trust !== "server_verified")) {
            throw new UploadSessionError("UPLOAD_INCOMPLETE", "Required upload bytes are incomplete", 409);
          }
          if (manifest.accepted.length === 0) {
            throw new UploadSessionError("EMPTY_FOLDER_UPLOAD", "Upload contains no accepted source files", 400);
          }
          const committing = await this.options.store.markUploadSessionCommitting(input.workspaceId, input.sessionId);
          if (!committing || !["committing", "committed"].includes(committing.status)) {
            throw new UploadSessionError("UPLOAD_SESSION_STATE", "Upload cannot be committed", 409);
          }
          if (committing.status === "committed" && committing.snapshotId) {
            return this.committedSummary(committing, manifest);
          }
          const report = await this.options.store.createUploadSessionImportReport({
            workspaceId: session.workspaceId,
            projectId: session.projectId,
            repositoryId: session.repositoryId,
            actorId: session.actorId,
            sourceKind: "upload"
          }, session.id);
          try {
            const summary = await importFolderFiles({
              files: (async function* (dataDir: string) {
                for (const entry of manifest.accepted) {
                  yield {
                    path: entry.path,
                    content: await readFile(uploadFilePath(dataDir, session.id, entry.ordinal))
                  };
                }
              })(this.options.dataDir),
              dataDir: this.options.dataDir,
              workspaceId: session.workspaceId,
              repositoryId: session.repositoryId,
              actorId: session.actorId,
              store: this.options.store,
              stagingDirectory: path.join(uploadDirectory(this.options.dataDir, session.id), "import"),
              pendingUploadSessionId: session.id
            });
            const response = {
              snapshotId: summary.snapshotId,
              sourceVersion: summary.sourceVersion,
              fileCount: summary.fileCount,
              textBytes: summary.textBytes,
              unchanged: summary.unchanged,
              ignored: manifest.ignored,
              assetCount: manifest.assetCount
            };
            const completed = await this.options.store.completeUploadSessionCommit({
              workspaceId: session.workspaceId,
              projectId: session.projectId,
              repositoryId: session.repositoryId,
              sessionId: session.id,
              actorId: session.actorId,
              manifestDigest: input.manifestDigest,
              snapshotId: summary.snapshotId,
              reportId: report.id,
              report: {
                status: "succeeded",
                collectedFileCount: summary.fileCount,
                collectedTextBytes: summary.textBytes,
                ignored: manifest.ignored,
                snapshotId: summary.snapshotId,
                failureCode: null
              },
              responseBody: response
            });
            if (!completed) {
              throw new UploadSessionError("UPLOAD_SESSION_INVALIDATED", "Upload source changed before commit", 409);
            }
            if (completed.snapshotId !== summary.snapshotId) {
              await removeReadOnlyTree(path.dirname(summary.storagePath));
            } else {
              await removePendingSnapshotMarker(summary.storagePath).catch(() => undefined);
            }
            await rm(uploadDirectory(this.options.dataDir, session.id), { recursive: true, force: true });
            return completed.commitResponse as UploadCommitResponse;
          } catch (error) {
            await this.options.store.finishImportReport(session.workspaceId, report.id, {
              status: "failed",
              collectedFileCount: 0,
              collectedTextBytes: 0,
              ignored: manifest.ignored,
              snapshotId: null,
              failureCode: error instanceof UploadSessionError ? error.code : "UPLOAD_FAILED"
            }).catch(() => undefined);
            throw error;
          }
        }
      });
    });
  }

  private async committedSummary(
    session: UploadSessionRecord,
    manifest: ManifestAnalysis
  ): Promise<UploadCommitResponse> {
    if (session.commitResponse) return session.commitResponse as UploadCommitResponse;
    if (!session.snapshotId) throw new UploadSessionError("UPLOAD_SESSION_STATE", "Committed upload has no snapshot", 500);
    const snapshot = await this.options.store.findSnapshotById(session.workspaceId, session.snapshotId);
    if (!snapshot) throw new UploadSessionError("UPLOAD_SESSION_STATE", "Committed upload snapshot is unavailable", 500);
    return {
      snapshotId: snapshot.id,
      sourceVersion: snapshot.commitSha,
      fileCount: await this.options.store.countSnapshotFiles(snapshot.id),
      textBytes: await this.options.store.snapshotTextBytes(snapshot.id),
      unchanged: true,
      ignored: manifest.ignored,
      assetCount: manifest.assetCount
    };
  }

  private async analyzeManifest(session: UploadSessionRecord): Promise<ManifestAnalysis> {
    const accepted: UploadManifestEntryRecord[] = [];
    const ignoredReasons: Record<string, number> = {};
    const hash = createHash("sha256");
    let entryCount = 0;
    let assetCount = 0;
    hash.update("[");
    for (let offset = 0; offset < session.entryCount; offset += UPLOAD_MANIFEST_PAGE_SIZE) {
      const page = await this.options.store.listUploadManifestEntries(
        session.workspaceId, session.id, { limit: UPLOAD_MANIFEST_PAGE_SIZE, offset }
      );
      if (page.length === 0) break;
      for (const entry of page) {
        if (entry.ordinal !== entryCount) {
          return { accepted, ignored: ignoredSummaryFromReasons(ignoredReasons), assetCount, entryCount, digest: "" };
        }
        if (entryCount > 0) hash.update(",");
        hash.update(JSON.stringify(canonicalEntry(entry)));
        entryCount += 1;
        if (entry.disposition === "upload_required") accepted.push(entry);
        else if (entry.disposition === "metadata_only") assetCount += 1;
        else if (entry.ignoreReason) ignoredReasons[entry.ignoreReason] = (ignoredReasons[entry.ignoreReason] ?? 0) + 1;
      }
    }
    hash.update("]");
    return {
      accepted,
      ignored: ignoredSummaryFromReasons(ignoredReasons),
      assetCount,
      entryCount,
      digest: hash.digest("hex")
    };
  }

  async cancel(input: Identity & { sessionId: string; idempotencyKey: string }) {
    return this.withMutationLock(input, input.sessionId, input.idempotencyKey, async () => {
      const session = await this.authorizedSession(input, input.sessionId);
      return this.idempotent({
        identity: input,
        key: input.idempotencyKey,
        operation: `cancel:${input.sessionId}`,
        request: { sessionId: input.sessionId },
        sessionId: input.sessionId,
        statusCode: 200,
        action: async () => {
          if (session.status === "committed") {
            throw new UploadSessionError("UPLOAD_SESSION_STATE", "Committed upload cannot be cancelled", 409);
          }
          const cancelled = await this.options.store.cancelUploadSession({
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            sessionId: input.sessionId,
            actorId: input.actorId,
            sessionVersion: input.sessionVersion
          });
          if (!cancelled) throw new UploadSessionError("UPLOAD_SESSION_NOT_FOUND", "Upload session was not found", 404);
          await rm(uploadDirectory(this.options.dataDir, input.sessionId), { recursive: true, force: true });
          await Promise.all(cancelled.storagePaths.map((storagePath) =>
            removeReadOnlyTree(path.dirname(storagePath))
          ));
          return { cancelled: true };
        }
      });
    });
  }

  async cleanupExpired(): Promise<number> {
    const now = this.now();
    const candidates = await this.options.store.listExpiredUploadSessions(now);
    let deleted = 0;
    for (const candidate of candidates) {
      await this.withPersistentSessionLock(candidate.workspaceId, candidate.id, async () => {
        const storagePaths = await this.options.store.deleteExpiredUploadSession(
          candidate.workspaceId, candidate.id, now
        );
        if (!storagePaths) return;
        await rm(uploadDirectory(this.options.dataDir, candidate.id), { recursive: true, force: true });
        await Promise.all(storagePaths.map((storagePath) =>
          removeReadOnlyTree(path.dirname(storagePath))
        ));
        deleted += 1;
      });
    }
    await this.options.store.failStaleRunningImportReports(new Date(now.getTime() - UPLOAD_SESSION_TTL_MS));
    const root = path.join(this.options.dataDir, "uploads", "sessions");
    const stagingCandidates = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const candidate of stagingCandidates) {
      if (!candidate.isDirectory() || !/^[0-9a-f-]{36}$/u.test(candidate.name)) continue;
      const marker = await readJsonMarker(path.join(root, candidate.name, UPLOAD_SESSION_MARKER));
      const owner = await this.options.store.getUploadSessionStagingOwner(candidate.name);
      const workspaceId = owner?.workspaceId ?? marker?.workspaceId;
      if (!workspaceId) {
        if (await isStaleMarkerlessDirectory(path.join(root, candidate.name), now)) {
          await rm(path.join(root, candidate.name), { recursive: true, force: true });
        }
        continue;
      }
      if (marker?.sessionId && marker.sessionId !== candidate.name) continue;
      await this.withPersistentSessionLock(workspaceId, candidate.name, async () => {
        const current = await this.options.store.getUploadSessionStagingOwner(candidate.name);
        if (!current || !current.active) {
          await rm(path.join(root, candidate.name), { recursive: true, force: true });
        }
      });
    }
    const snapshotsRoot = path.join(this.options.dataDir, "snapshots");
    const snapshotCandidates = await readdir(snapshotsRoot, { withFileTypes: true }).catch(() => []);
    for (const candidate of snapshotCandidates) {
      if (!candidate.isDirectory() || !/^[0-9a-f-]{36}$/u.test(candidate.name)) continue;
      const marker = await readJsonMarker(path.join(snapshotsRoot, candidate.name, PENDING_UPLOAD_SNAPSHOT_MARKER));
      if (!marker) {
        if (await isStaleMarkerlessDirectory(path.join(snapshotsRoot, candidate.name), now)) {
          await rm(path.join(snapshotsRoot, candidate.name), { recursive: true, force: true });
        }
        continue;
      }
      if (marker.snapshotId !== candidate.name) continue;
      const published = await this.options.store.findSnapshotById(marker.workspaceId, candidate.name);
      if (published) {
        await removePendingSnapshotMarker(published.storagePath);
        continue;
      }
      if (marker.sessionId) {
        await this.withPersistentSessionLock(marker.workspaceId, marker.sessionId, async () => {
          if (!await this.options.store.uploadSnapshotExists(marker.workspaceId, candidate.name, marker.sessionId!)) {
            await removeReadOnlyTree(path.join(snapshotsRoot, candidate.name));
          }
        });
      } else if (marker.importReportId) {
        const discarded = await this.options.store.discardStalePendingFolderImport(
          marker.workspaceId,
          marker.importReportId,
          candidate.name,
          new Date(now.getTime() - UPLOAD_SESSION_TTL_MS)
        );
        if (discarded) await removeReadOnlyTree(path.join(snapshotsRoot, candidate.name));
      }
    }
    await this.options.store.deleteExpiredUploadIdempotencyKeys(now);
    return deleted;
  }
}

async function isStaleMarkerlessDirectory(directory: string, now: Date): Promise<boolean> {
  const [metadata, entries] = await Promise.all([
    stat(directory).catch(() => null),
    readdir(directory).catch(() => null)
  ]);
  const recoverableEntries = entries?.every((entry) =>
    /^\.\.devkh-upload-session\.json\.[0-9a-f-]{36}\.tmp$/u.test(entry)
  );
  return Boolean(metadata && entries && (entries.length === 0 || recoverableEntries)
    && metadata.mtime.getTime() <= now.getTime() - UPLOAD_SESSION_TTL_MS);
}

async function readJsonMarker(filePath: string): Promise<{
  workspaceId: string;
  sessionId?: string;
  importReportId?: string;
  snapshotId?: string;
} | null> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    if (typeof value.workspaceId !== "string") return null;
    return {
      workspaceId: value.workspaceId,
      sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
      importReportId: typeof value.importReportId === "string" ? value.importReportId : undefined,
      snapshotId: typeof value.snapshotId === "string" ? value.snapshotId : undefined
    };
  } catch {
    return null;
  }
}

function entryDto(entry: UploadManifestEntryRecord) {
  return {
    ordinal: entry.ordinal,
    path: entry.path,
    kind: entry.kind,
    byteSize: entry.byteSize,
    contentHash: entry.contentHash,
    mediaType: entry.mediaType,
    disposition: entry.disposition,
    trust: entry.trust,
    ignoreReason: entry.ignoreReason
  };
}

function ignoredSummaryFromReasons(reasons: Record<string, number>) {
  return { total: Object.values(reasons).reduce((sum, value) => sum + value, 0), reasons };
}
