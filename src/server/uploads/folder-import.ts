import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm
} from "node:fs/promises";
import path from "node:path";

import { filterImportFile, importLanguageForPath } from "../../shared/import-filter.js";

import type { AppStore, SourceFileRecord, SourceSnapshotRecord } from "../persistence/store.js";
import type { SourceBlobStore } from "./source-blob-store.js";

export const MAX_FOLDER_UPLOAD_FILES = 50_000;
export const MAX_FOLDER_SCAN_FILES = 100_000;
export const MAX_FOLDER_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const PENDING_UPLOAD_SNAPSHOT_MARKER = ".devkh-upload-session.json";

export type FolderUploadErrorCode =
  | "DUPLICATE_FOLDER_PATH"
  | "EMPTY_FOLDER_UPLOAD"
  | "FOLDER_SIZE_LIMIT"
  | "TOO_MANY_FILES"
  | "UNSAFE_FOLDER_PATH";

export class FolderUploadError extends Error {
  constructor(readonly code: FolderUploadErrorCode, message: string) {
    super(message);
    this.name = "FolderUploadError";
  }
}

export interface FolderUploadFile {
  path: string;
  content: Uint8Array;
}

export interface FolderUploadSummary {
  snapshotId: string;
  sourceVersion: string;
  fileCount: number;
  textBytes: number;
  unchanged: boolean;
  storagePath: string;
  ignored: { total: number; reasons: Record<string, number> };
}

export function safeFolderUploadPath(value: string): string {
  if (!value
    || value.includes("\0")
    || value.includes("\\")
    || value.startsWith("/")
    || /^[a-zA-Z]:\//.test(value)
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")
    || path.posix.normalize(value) !== value) {
    throw new FolderUploadError("UNSAFE_FOLDER_PATH", "Folder upload contains an unsafe path");
  }
  return value;
}

function recordIgnored(reasons: Record<string, number>, reason: string): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
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

export async function removeReadOnlyTree(directory: string): Promise<void> {
  await chmod(directory, 0o700).catch(() => undefined);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) =>
    removeReadOnlyTree(path.join(directory, entry.name))
  ));
  await rm(directory, { recursive: true, force: true });
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function ensureDurableSubdirectory(
  root: string,
  segments: string[],
  mode = 0o700
): Promise<string> {
  await mkdir(root, { recursive: true, mode });
  let current = root;
  for (const segment of segments) {
    const next = path.join(current, segment);
    let created = false;
    try {
      await mkdir(next, { mode });
      created = true;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    if (created) await syncDirectory(current);
    current = next;
  }
  return current;
}

export async function writeDurableJsonMarker(
  directory: string,
  fileName: string,
  value: Record<string, unknown>,
  mode: number
): Promise<void> {
  const destination = path.join(directory, fileName);
  const temporary = path.join(directory, `.${fileName}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncTree(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await syncTree(entryPath);
      continue;
    }
    if (!entry.isFile()) continue;
    const handle = await open(entryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await syncDirectory(directory);
}

export async function removePendingSnapshotMarker(storagePath: string): Promise<void> {
  const snapshotDirectory = path.dirname(storagePath);
  await chmod(snapshotDirectory, 0o700);
  try {
    await rm(path.join(snapshotDirectory, PENDING_UPLOAD_SNAPSHOT_MARKER), { force: true });
    await syncDirectory(snapshotDirectory);
  } finally {
    await chmod(snapshotDirectory, 0o555);
  }
}

async function moveDirectory(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EXDEV") throw error;
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    await syncTree(destination);
    await syncDirectory(path.dirname(destination));
    await rm(source, { recursive: true, force: true });
  }
}

export async function importFolderFiles({
  files,
  dataDir,
  workspaceId,
  repositoryId,
  actorId,
  store,
  stagingDirectory,
  pendingUploadSessionId,
  pendingImportReportId,
  sourceStorageMode = "legacy",
  sourceBlobStore
}: {
  files: AsyncIterable<FolderUploadFile>;
  dataDir: string;
  workspaceId: string;
  repositoryId: string;
  actorId: string;
  store: AppStore;
  stagingDirectory?: string;
  pendingUploadSessionId?: string;
  pendingImportReportId?: string;
  sourceStorageMode?: "legacy" | "shadow" | "active";
  sourceBlobStore?: SourceBlobStore;
}): Promise<FolderUploadSummary> {
  const workDirectory = stagingDirectory ?? path.join(dataDir, "uploads", randomUUID());
  const stagedFiles = path.join(workDirectory, "files");
  const ignoredReasons: Record<string, number> = {};
  const accepted: Array<{ filePath: string; byteSize: number; contentHash: string; language: string | null }> = [];
  const seenPaths = new Set<string>();
  let promotedSnapshotDirectory: string | null = null;
  let receivedFiles = 0;
  let acceptedBytes = 0;
  if (stagingDirectory) await rm(workDirectory, { recursive: true, force: true });
  await mkdir(stagedFiles, { recursive: true, mode: 0o700 });

  try {
    for await (const uploaded of files) {
      receivedFiles += 1;
      const filePath = safeFolderUploadPath(uploaded.path);
      if (seenPaths.has(filePath)) {
        throw new FolderUploadError("DUPLICATE_FOLDER_PATH", "Folder upload contains duplicate paths");
      }
      seenPaths.add(filePath);
      const content = Buffer.from(uploaded.content);
      const decision = filterImportFile({ path: filePath, byteSize: content.byteLength, content });
      if (!decision.accepted) {
        recordIgnored(ignoredReasons, decision.reason);
        continue;
      }
      if (accepted.length >= MAX_FOLDER_UPLOAD_FILES) {
        throw new FolderUploadError("TOO_MANY_FILES", "Folder upload contains more than 50,000 accepted source files");
      }
      acceptedBytes += content.byteLength;
      if (acceptedBytes > MAX_FOLDER_UPLOAD_BYTES) {
        throw new FolderUploadError("FOLDER_SIZE_LIMIT", "Folder upload exceeds the 2 GiB source limit");
      }
      const outputPath = path.join(stagedFiles, ...filePath.split("/"));
      await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
      const output = await open(outputPath, "wx", 0o600);
      try {
        await output.writeFile(content);
        await output.sync();
      } finally {
        await output.close();
      }
      accepted.push({
        filePath,
        byteSize: content.byteLength,
        contentHash: createHash("sha256").update(content).digest("hex"),
        language: importLanguageForPath(filePath)
      });
    }

    if (receivedFiles === 0 || accepted.length === 0) {
      throw new FolderUploadError("EMPTY_FOLDER_UPLOAD", "Folder upload contains no accepted source files");
    }

    accepted.sort((left, right) => Buffer.compare(Buffer.from(left.filePath, "utf8"), Buffer.from(right.filePath, "utf8")));
    const versionHash = createHash("sha1");
    for (const file of accepted) {
      const content = await readFile(path.join(stagedFiles, ...file.filePath.split("/")));
      const pathBytes = Buffer.from(file.filePath, "utf8");
      versionHash.update(`${pathBytes.length}:`);
      versionHash.update(pathBytes);
      versionHash.update(`:${content.length}:`);
      versionHash.update(content);
    }
    const sourceVersion = versionHash.digest("hex");
    const textBytes = accepted.reduce((total, file) => total + file.byteSize, 0);
    const existing = await store.findSnapshotByCommit(
      workspaceId, repositoryId, sourceVersion, pendingUploadSessionId, pendingImportReportId
    );
    if (existing) {
      return {
        snapshotId: existing.id,
        sourceVersion,
        fileCount: await store.countSnapshotFiles(existing.id),
        textBytes,
        unchanged: true,
        storagePath: existing.storagePath,
        ignored: { total: Object.values(ignoredReasons).reduce((sum, value) => sum + value, 0), reasons: ignoredReasons }
      };
    }

    const snapshotId = randomUUID();
    let sourceFiles: SourceFileRecord[];
    let storagePath: string;
    if (sourceStorageMode !== "legacy") {
      if (!sourceBlobStore) throw new Error("Source blob storage is unavailable");
      const linkedFiles: Array<{
        path: string;
        blob: Awaited<ReturnType<SourceBlobStore["put"]>>["record"];
      }> = [];
      sourceFiles = [];
      for (const file of accepted) {
        const bytes = await readFile(path.join(stagedFiles, ...file.filePath.split("/")));
        const { record } = await sourceBlobStore.put({ workspaceId, bytes });
        linkedFiles.push({ path: file.filePath, blob: record });
        sourceFiles.push({
          id: randomUUID(), workspaceId, snapshotId, path: file.filePath,
          byteSize: file.byteSize, contentHash: file.contentHash, language: file.language,
          sourceBlobId: record.id
        });
      }
      storagePath = await sourceBlobStore.materializeSnapshotView({
        workspaceId, snapshotId, files: linkedFiles
      });
      promotedSnapshotDirectory = path.dirname(storagePath);
      await chmod(promotedSnapshotDirectory, 0o700);
    } else {
      sourceFiles = accepted.map((file) => ({
        id: randomUUID(), workspaceId, snapshotId, path: file.filePath,
        byteSize: file.byteSize, contentHash: file.contentHash, language: file.language,
        sourceBlobId: null
      }));
      const snapshotsRoot = await ensureDurableSubdirectory(dataDir, ["snapshots"]);
      promotedSnapshotDirectory = path.join(snapshotsRoot, snapshotId);
      await mkdir(promotedSnapshotDirectory, { recursive: false, mode: 0o700 });
      await syncDirectory(snapshotsRoot);
      storagePath = path.join(promotedSnapshotDirectory, "files");
      await moveDirectory(stagedFiles, storagePath);
      await makeReadOnly(storagePath, sourceFiles.map((file) => file.path));
      await syncTree(storagePath);
    }
    if (pendingUploadSessionId || pendingImportReportId) {
      await writeDurableJsonMarker(promotedSnapshotDirectory, PENDING_UPLOAD_SNAPSHOT_MARKER, {
        workspaceId,
        sessionId: pendingUploadSessionId,
        importReportId: pendingImportReportId,
        snapshotId
      }, 0o400);
    }
    await syncDirectory(promotedSnapshotDirectory);
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
    const persisted = await store.createSnapshotWithAudit(
      { snapshot, files: sourceFiles }, actorId, pendingUploadSessionId, pendingImportReportId
    );
    if (persisted.id !== snapshotId) {
      await removeReadOnlyTree(promotedSnapshotDirectory);
      promotedSnapshotDirectory = null;
      return {
        snapshotId: persisted.id,
        sourceVersion: persisted.commitSha,
        fileCount: await store.countSnapshotFiles(persisted.id),
        textBytes,
        unchanged: true,
        storagePath: persisted.storagePath,
        ignored: { total: Object.values(ignoredReasons).reduce((sum, value) => sum + value, 0), reasons: ignoredReasons }
      };
    }
    promotedSnapshotDirectory = null;
    return {
      snapshotId,
      sourceVersion,
      fileCount: sourceFiles.length,
      textBytes,
      unchanged: false,
      storagePath,
      ignored: { total: Object.values(ignoredReasons).reduce((sum, value) => sum + value, 0), reasons: ignoredReasons }
    };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
    if (promotedSnapshotDirectory) await removeReadOnlyTree(promotedSnapshotDirectory);
  }
}
