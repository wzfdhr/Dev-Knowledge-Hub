import type { UploadSnapshotSummary } from "./types";

export const RESUMABLE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

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

export interface ResumableUploadApi {
  createResumableUpload(input: { totalBytes: number; chunkSize: number }): Promise<ResumableUploadStatus>;
  getResumableUpload(id: string): Promise<ResumableUploadStatus>;
  uploadResumableChunk(id: string, index: number, content: Blob): Promise<ResumableUploadStatus>;
  importResumableUpload(projectId: string, id: string): Promise<UploadSnapshotSummary>;
  importResumableReplacementUpload(repositoryId: string, id: string): Promise<UploadSnapshotSummary>;
}

interface UploadStorage {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface ResumableUploadOptions {
  chunkSize?: number;
  storage?: UploadStorage;
  onProgress?(status: ResumableUploadStatus): void;
}

function browserStorage(): UploadStorage | undefined {
  if (typeof window === "undefined") return undefined;
  return {
    get: (key) => window.localStorage.getItem(key) ?? undefined,
    set: (key, value) => window.localStorage.setItem(key, value),
    delete: (key) => window.localStorage.removeItem(key)
  };
}

function storageKey(projectId: string, file: File): string {
  return `devkh:resumable:${projectId}:${file.name}:${file.size}:${file.lastModified}`;
}

export async function uploadProjectZipResumably(
  api: ResumableUploadApi,
  projectId: string,
  file: File,
  options: ResumableUploadOptions = {}
): Promise<UploadSnapshotSummary> {
  return uploadZipResumably(api, projectId, file, (sessionId) =>
    api.importResumableUpload(projectId, sessionId), options);
}

export async function uploadReplacementZipResumably(
  api: ResumableUploadApi,
  repositoryId: string,
  file: File,
  options: ResumableUploadOptions = {}
): Promise<UploadSnapshotSummary> {
  return uploadZipResumably(api, `replacement:${repositoryId}`, file, (sessionId) =>
    api.importResumableReplacementUpload(repositoryId, sessionId), options);
}

async function uploadZipResumably(
  api: ResumableUploadApi,
  uploadScope: string,
  file: File,
  importUpload: (sessionId: string) => Promise<UploadSnapshotSummary>,
  options: ResumableUploadOptions
): Promise<UploadSnapshotSummary> {
  const chunkSize = options.chunkSize ?? RESUMABLE_UPLOAD_CHUNK_BYTES;
  const storage = options.storage ?? browserStorage();
  const key = storageKey(uploadScope, file);
  const sessionId = storage?.get(key);
  let status: ResumableUploadStatus;

  try {
    status = sessionId
      ? await api.getResumableUpload(sessionId)
      : await api.createResumableUpload({ totalBytes: file.size, chunkSize });
  } catch {
    status = await api.createResumableUpload({ totalBytes: file.size, chunkSize });
  }
  storage?.set(key, status.id);
  options.onProgress?.(status);

  for (let index = status.receivedChunks; index < status.chunkCount; index += 1) {
    const start = index * status.chunkSize;
    const end = Math.min(start + status.chunkSize, file.size);
    status = await api.uploadResumableChunk(status.id, index, file.slice(start, end));
    options.onProgress?.(status);
  }

  const summary = await importUpload(status.id);
  storage?.delete(key);
  return summary;
}
