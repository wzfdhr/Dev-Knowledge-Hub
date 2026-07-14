import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { MAX_IMPORT_SOURCE_FILE_BYTES, MAX_IMPORT_TABLE_WORKBOOK_BYTES } from "../../../shared/import-filter.js";

import type { SourceFileRecord, SourceSnapshotRecord } from "../../persistence/store.js";
import type { WebSourceInput } from "./extract-web.js";

export class SnapshotConversionError extends Error {
  constructor(readonly code: "INVALID_SNAPSHOT_FILE" | "SOURCE_FILE_TOO_LARGE" | "SNAPSHOT_FILE_INTEGRITY_FAILED", message: string) {
    super(message);
    this.name = "SnapshotConversionError";
  }
}

export interface SnapshotTableFile {
  snapshotId: string;
  path: string;
  content: Buffer;
  blobHash: string;
}

function snapshotFilePath(storagePath: string, relativePath: string): string {
  if (!relativePath
    || relativePath.includes("\\")
    || relativePath.startsWith("/")
    || relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new SnapshotConversionError("INVALID_SNAPSHOT_FILE", "Snapshot file path is invalid");
  }
  const root = path.resolve(storagePath);
  const resolved = path.resolve(root, ...relativePath.split("/"));
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new SnapshotConversionError("INVALID_SNAPSHOT_FILE", "Snapshot file path escapes its storage root");
  }
  return resolved;
}

export async function convertSnapshotSourceFile({
  snapshot,
  file
}: {
  snapshot: Pick<SourceSnapshotRecord, "id" | "storagePath">;
  file: Pick<SourceFileRecord, "snapshotId" | "path" | "byteSize" | "contentHash">;
}): Promise<WebSourceInput> {
  if (file.snapshotId !== snapshot.id) {
    throw new SnapshotConversionError("INVALID_SNAPSHOT_FILE", "Source file does not belong to the supplied snapshot");
  }
  if (file.byteSize > MAX_IMPORT_SOURCE_FILE_BYTES) {
    throw new SnapshotConversionError("SOURCE_FILE_TOO_LARGE", "Source file exceeds the conversion size limit");
  }

  const sourcePath = snapshotFilePath(snapshot.storagePath, file.path);
  const stat = await lstat(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new SnapshotConversionError("INVALID_SNAPSHOT_FILE", "Snapshot entry is not a regular file");
  }
  const content = await readFile(sourcePath);
  const contentHash = createHash("sha256").update(content).digest("hex");
  if (content.byteLength !== file.byteSize || contentHash !== file.contentHash) {
    throw new SnapshotConversionError("SNAPSHOT_FILE_INTEGRITY_FAILED", "Snapshot source file does not match persisted metadata");
  }

  try {
    return {
      snapshotId: snapshot.id,
      path: file.path,
      content: new TextDecoder("utf-8", { fatal: true }).decode(content),
      blobHash: file.contentHash
    };
  } catch {
    throw new SnapshotConversionError("SNAPSHOT_FILE_INTEGRITY_FAILED", "Snapshot source file is not valid UTF-8");
  }
}

export async function convertSnapshotTableFile({
  snapshot,
  file
}: {
  snapshot: Pick<SourceSnapshotRecord, "id" | "storagePath">;
  file: Pick<SourceFileRecord, "snapshotId" | "path" | "byteSize" | "contentHash">;
}): Promise<SnapshotTableFile> {
  if (file.snapshotId !== snapshot.id) {
    throw new SnapshotConversionError("INVALID_SNAPSHOT_FILE", "Source file does not belong to the supplied snapshot");
  }
  const maximumBytes = path.posix.extname(file.path).toLowerCase() === ".xlsx"
    ? MAX_IMPORT_TABLE_WORKBOOK_BYTES
    : MAX_IMPORT_SOURCE_FILE_BYTES;
  if (file.byteSize > maximumBytes) {
    throw new SnapshotConversionError("SOURCE_FILE_TOO_LARGE", "Table source exceeds the conversion size limit");
  }
  const sourcePath = snapshotFilePath(snapshot.storagePath, file.path);
  const stat = await lstat(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new SnapshotConversionError("INVALID_SNAPSHOT_FILE", "Snapshot entry is not a regular file");
  }
  const content = await readFile(sourcePath);
  const contentHash = createHash("sha256").update(content).digest("hex");
  if (content.byteLength !== file.byteSize || contentHash !== file.contentHash) {
    throw new SnapshotConversionError("SNAPSHOT_FILE_INTEGRITY_FAILED", "Snapshot source file does not match persisted metadata");
  }
  return { snapshotId: snapshot.id, path: file.path, content, blobHash: file.contentHash };
}
