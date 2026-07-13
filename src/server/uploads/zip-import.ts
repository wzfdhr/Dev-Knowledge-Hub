import { createHash, randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import {
  chmod,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import {
  BlobReader,
  type Entry,
  type FileEntry,
  ZipReader
} from "@zip.js/zip.js";

import type {
  AppStore,
  SourceFileRecord,
  SourceSnapshotRecord
} from "../persistence/store.js";

export const MAX_UPLOAD_COMPRESSED_BYTES = 500 * 1024 * 1024;
export const MAX_UPLOAD_ENTRIES = 50_000;
export const MAX_UPLOAD_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_UPLOAD_SOURCE_FILE_BYTES = 1024 * 1024;

export interface UploadArchiveLimits {
  maxEntries: number;
  maxExpandedBytes: number;
  maxSourceFileBytes: number;
}

const DEFAULT_LIMITS: UploadArchiveLimits = {
  maxEntries: MAX_UPLOAD_ENTRIES,
  maxExpandedBytes: MAX_UPLOAD_EXPANDED_BYTES,
  maxSourceFileBytes: MAX_UPLOAD_SOURCE_FILE_BYTES
};

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next"
]);
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".md", ".json", ".yaml", ".yml"
]);

export type UploadArchiveErrorCode =
  | "COMPRESSED_SIZE_LIMIT"
  | "DUPLICATE_ARCHIVE_PATH"
  | "ENCRYPTED_ARCHIVE"
  | "EXPANDED_SIZE_LIMIT"
  | "INVALID_ZIP"
  | "SYMLINK_NOT_ALLOWED"
  | "TOO_MANY_ENTRIES"
  | "UNSAFE_ARCHIVE_PATH";

export class UploadArchiveError extends Error {
  constructor(readonly code: UploadArchiveErrorCode, message: string) {
    super(message);
    this.name = "UploadArchiveError";
  }
}

export interface UploadSnapshotSummary {
  snapshotId: string;
  sourceVersion: string;
  fileCount: number;
  unchanged: boolean;
  storagePath: string;
  ignored: { total: number; reasons: Record<string, number> };
}

function archivePath(entry: Entry): string {
  const value = entry.directory && entry.filename.endsWith("/")
    ? entry.filename.slice(0, -1)
    : entry.filename;
  if (!value
    || value.includes("\0")
    || value.includes("\\")
    || value.startsWith("/")
    || /^[a-zA-Z]:\//.test(value)
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")
    || path.posix.normalize(value) !== value) {
    throw new UploadArchiveError("UNSAFE_ARCHIVE_PATH", "ZIP contains an unsafe path");
  }
  return value;
}

function isSymlink(entry: Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

function isCandidate(filePath: string): boolean {
  const segments = filePath.split("/");
  if (segments.some((segment) => SKIPPED_DIRECTORIES.has(segment))) return false;
  if (filePath === ".env") return false;
  if (filePath === ".env.example") return true;

  const basename = path.posix.basename(filePath);
  if (/^package(?:-lock)?\.json$/.test(basename)) return true;
  if (["pnpm-lock.yaml", "yarn.lock"].includes(basename)) return true;
  if (/^tsconfig(?:\.[^.]+)?\.json$/.test(basename)) return true;
  if (/^(?:vitest|jest|playwright|cypress)\.config\.(?:ts|js|tsx|jsx)$/.test(basename)) {
    return true;
  }
  return SOURCE_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase());
}

function recordIgnored(reasons: Record<string, number>, reason: string): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

function isGenerated(content: Buffer): boolean {
  const header = content.subarray(0, 2048).toString("utf8").toLowerCase();
  return header.includes("@generated")
    || header.includes("generated file")
    || header.includes("do not edit");
}

function isUtf8(content: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

function languageFor(filePath: string): string | null {
  const extension = path.posix.extname(filePath).toLowerCase();
  return ({
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "jsx",
    ".md": "markdown",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml"
  } as Record<string, string>)[extension] ?? null;
}

function validatedEntries(entries: Entry[], limits: UploadArchiveLimits) {
  let expandedBytes = 0;
  const paths = new Map<string, "directory" | "file">();
  const validated = entries.map((entry) => {
    if (entry.encrypted) {
      throw new UploadArchiveError("ENCRYPTED_ARCHIVE", "Encrypted ZIP archives are not allowed");
    }
    if (isSymlink(entry)) {
      throw new UploadArchiveError("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
    }
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
      throw new UploadArchiveError("INVALID_ZIP", "ZIP entry has an invalid expanded size");
    }
    expandedBytes += entry.uncompressedSize;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > limits.maxExpandedBytes) {
      throw new UploadArchiveError(
        "EXPANDED_SIZE_LIMIT",
        "ZIP expands beyond the 2 GiB limit"
      );
    }
    const filePath = archivePath(entry);
    if (paths.has(filePath)) {
      throw new UploadArchiveError("DUPLICATE_ARCHIVE_PATH", "ZIP contains duplicate paths");
    }
    paths.set(filePath, entry.directory ? "directory" : "file");
    return { entry, filePath };
  });

  for (const { filePath } of validated) {
    const segments = filePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      if (paths.get(segments.slice(0, index).join("/")) === "file") {
        throw new UploadArchiveError(
          "DUPLICATE_ARCHIVE_PATH",
          "ZIP contains conflicting file and directory paths"
        );
      }
    }
  }
  return validated;
}

async function readBoundedEntries(
  reader: ZipReader<Blob>,
  limits: UploadArchiveLimits
): Promise<Entry[]> {
  const entries: Entry[] = [];
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      entries.push(entry);
      if (entries.length > limits.maxEntries) {
        throw new UploadArchiveError(
          "TOO_MANY_ENTRIES",
          "ZIP contains more than 50,000 entries"
        );
      }
    }
    return entries;
  } catch (error) {
    if (error instanceof UploadArchiveError) throw error;
    throw new UploadArchiveError("INVALID_ZIP", "Invalid ZIP archive");
  }
}

async function extractBounded(entry: FileEntry, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new UploadArchiveError("EXPANDED_SIZE_LIMIT", "ZIP entry exceeds source file limit");
      }
      chunks.push(Buffer.from(chunk));
    }
  });
  try {
    await entry.getData(writable, { checkSignature: true });
  } catch (error) {
    if (error instanceof UploadArchiveError) throw error;
    throw new UploadArchiveError("INVALID_ZIP", "Invalid ZIP archive");
  }
  return Buffer.concat(chunks, total);
}

async function makeReadOnly(storagePath: string, filePaths: string[]): Promise<void> {
  const directories = new Set<string>([storagePath]);
  for (const filePath of filePaths) {
    const absolutePath = path.join(storagePath, ...filePath.split("/"));
    await chmod(absolutePath, 0o444);
    let directory = path.dirname(absolutePath);
    while (directory.startsWith(`${storagePath}${path.sep}`)) {
      directories.add(directory);
      directory = path.dirname(directory);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    await chmod(directory, 0o555);
  }
}

async function removeReadOnlyTree(directory: string): Promise<void> {
  await chmod(directory, 0o700).catch(() => undefined);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) =>
    removeReadOnlyTree(path.join(directory, entry.name))
  ));
  await rm(directory, { recursive: true, force: true });
}

export async function importZipArchive({
  archivePath: sourceArchivePath,
  dataDir,
  workspaceId,
  repositoryId,
  actorId,
  store,
  limits: limitOverrides
}: {
  archivePath: string;
  dataDir: string;
  workspaceId: string;
  repositoryId: string;
  actorId: string;
  store: AppStore;
  limits?: Partial<UploadArchiveLimits>;
}): Promise<UploadSnapshotSummary> {
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  const workDirectory = path.join(dataDir, "uploads", randomUUID());
  const stagedFiles = path.join(workDirectory, "files");
  let promotedSnapshotDirectory: string | null = null;
  let reader: ZipReader<Blob> | null = null;
  await mkdir(stagedFiles, { recursive: true, mode: 0o700 });

  try {
    if ((await stat(sourceArchivePath)).size > MAX_UPLOAD_COMPRESSED_BYTES) {
      throw new UploadArchiveError(
        "COMPRESSED_SIZE_LIMIT",
        "ZIP exceeds the 500 MiB compressed limit"
      );
    }
    reader = new ZipReader(new BlobReader(await openAsBlob(sourceArchivePath)));
    const entries = validatedEntries(await readBoundedEntries(reader, limits), limits);
    const ignoredReasons: Record<string, number> = {};
    const candidates: Array<{ entry: FileEntry; filePath: string }> = [];
    for (const value of entries) {
      if (value.entry.directory) continue;
      if (value.entry.uncompressedSize > limits.maxSourceFileBytes) {
        recordIgnored(ignoredReasons, "file_too_large");
        continue;
      }
      if (value.filePath.split("/").some((segment) => SKIPPED_DIRECTORIES.has(segment))) {
        recordIgnored(ignoredReasons, "excluded_directory");
        continue;
      }
      if (value.filePath === ".env") {
        recordIgnored(ignoredReasons, "sensitive_file");
        continue;
      }
      if (!isCandidate(value.filePath)) {
        recordIgnored(ignoredReasons, "unsupported_extension");
        continue;
      }
      candidates.push(value as { entry: FileEntry; filePath: string });
    }
    candidates.sort((left, right) => Buffer.compare(
        Buffer.from(left.filePath, "utf8"),
        Buffer.from(right.filePath, "utf8")
    ));
    const versionHash = createHash("sha1");
    const accepted: Array<{
      filePath: string;
      byteSize: number;
      contentHash: string;
      language: string | null;
    }> = [];

    for (const { entry, filePath } of candidates) {
      const content = await extractBounded(entry, limits.maxSourceFileBytes);
      if (content.includes(0) || !isUtf8(content)) {
        recordIgnored(ignoredReasons, "binary");
        continue;
      }
      if (isGenerated(content)) {
        recordIgnored(ignoredReasons, "generated");
        continue;
      }
      const pathBytes = Buffer.from(filePath, "utf8");
      versionHash.update(`${pathBytes.length}:`);
      versionHash.update(pathBytes);
      versionHash.update(`:${content.length}:`);
      versionHash.update(content);
      const outputPath = path.join(stagedFiles, ...filePath.split("/"));
      await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
      await writeFile(outputPath, content, { flag: "wx", mode: 0o600 });
      accepted.push({
        filePath,
        byteSize: content.length,
        contentHash: createHash("sha256").update(content).digest("hex"),
        language: languageFor(filePath)
      });
    }

    const sourceVersion = versionHash.digest("hex");
    const existing = await store.findSnapshotByCommit(workspaceId, repositoryId, sourceVersion);
    if (existing) {
      return {
        snapshotId: existing.id,
        sourceVersion,
        fileCount: await store.countSnapshotFiles(existing.id),
        unchanged: true,
        storagePath: existing.storagePath,
        ignored: { total: Object.values(ignoredReasons).reduce((sum, value) => sum + value, 0), reasons: ignoredReasons }
      };
    }

    const snapshotId = randomUUID();
    const files: SourceFileRecord[] = accepted.map((file) => ({
      id: randomUUID(),
      workspaceId,
      snapshotId,
      path: file.filePath,
      byteSize: file.byteSize,
      contentHash: file.contentHash,
      language: file.language
    }));

    promotedSnapshotDirectory = path.join(dataDir, "snapshots", snapshotId);
    await mkdir(path.dirname(promotedSnapshotDirectory), { recursive: true, mode: 0o700 });
    await mkdir(promotedSnapshotDirectory, { recursive: false, mode: 0o700 });
    const storagePath = path.join(promotedSnapshotDirectory, "files");
    await rename(stagedFiles, storagePath);
    await makeReadOnly(storagePath, files.map((file) => file.path));
    await chmod(promotedSnapshotDirectory, 0o555);
    const snapshot: SourceSnapshotRecord = {
      id: snapshotId,
      workspaceId,
      repositoryId,
      commitSha: sourceVersion,
      ref: `upload/${sourceVersion}`,
      remoteUrl: null,
      commitTimestamp: new Date(),
      storagePath
    };
    const persisted = await store.createSnapshotWithAudit({ snapshot, files }, actorId);
    if (persisted.id !== snapshotId) {
      await removeReadOnlyTree(promotedSnapshotDirectory);
      promotedSnapshotDirectory = null;
      return {
        snapshotId: persisted.id,
        sourceVersion: persisted.commitSha,
        fileCount: await store.countSnapshotFiles(persisted.id),
        unchanged: true,
        storagePath: persisted.storagePath,
        ignored: { total: Object.values(ignoredReasons).reduce((sum, value) => sum + value, 0), reasons: ignoredReasons }
      };
    }
    promotedSnapshotDirectory = null;
    return {
      snapshotId,
      sourceVersion,
      fileCount: files.length,
      unchanged: false,
      storagePath,
      ignored: { total: Object.values(ignoredReasons).reduce((sum, value) => sum + value, 0), reasons: ignoredReasons }
    };
  } finally {
    await reader?.close().catch(() => undefined);
    await rm(sourceArchivePath, { force: true });
    await rm(workDirectory, { recursive: true, force: true });
    if (promotedSnapshotDirectory) {
      await removeReadOnlyTree(promotedSnapshotDirectory);
    }
  }
}
