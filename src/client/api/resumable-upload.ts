import type { UploadSnapshotSummary } from "./types";
import type { ImportProgress } from "./types";

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
  onTransferProgress?(progress: ImportProgress): void;
  controller?: UploadController;
  now?(): number;
}

export interface TransferSample {
  receivedBytes: number;
  at: number;
}

export interface CurrentTransferSample extends TransferSample {
  totalBytes: number;
}

export interface TransferProgress {
  bytesPerSecond: number;
  estimatedSeconds: number;
  percent: number;
}

export function calculateTransferProgress(
  previous: TransferSample,
  current: CurrentTransferSample
): TransferProgress {
  const elapsedSeconds = Math.max((current.at - previous.at) / 1000, 0.001);
  const bytesPerSecond = Math.max(0, (current.receivedBytes - previous.receivedBytes) / elapsedSeconds);
  const remainingBytes = Math.max(0, current.totalBytes - current.receivedBytes);
  return {
    bytesPerSecond,
    estimatedSeconds: bytesPerSecond > 0 ? Math.ceil(remainingBytes / bytesPerSecond) : 0,
    percent: current.totalBytes > 0 ? Math.round((current.receivedBytes / current.totalBytes) * 100) : 0
  };
}

export class UploadCancelledError extends Error {
  constructor() {
    super("Upload cancelled");
    this.name = "UploadCancelledError";
  }
}

export interface UploadController {
  readonly paused: boolean;
  readonly cancelled: boolean;
  pause(): void;
  resume(): void;
  cancel(): void;
  waitUntilRunnable(): Promise<void>;
}

export function createUploadController(): UploadController {
  let paused = false;
  let cancelled = false;
  let resumeWaiters: Array<() => void> = [];
  const releaseWaiters = () => {
    const waiters = resumeWaiters;
    resumeWaiters = [];
    for (const resolve of waiters) resolve();
  };
  return {
    get paused() { return paused; },
    get cancelled() { return cancelled; },
    pause() { if (!cancelled) paused = true; },
    resume() { paused = false; releaseWaiters(); },
    cancel() { cancelled = true; paused = false; releaseWaiters(); },
    async waitUntilRunnable() {
      if (cancelled) throw new UploadCancelledError();
      if (paused) await new Promise<void>((resolve) => resumeWaiters.push(resolve));
      if (cancelled) throw new UploadCancelledError();
    }
  };
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
  const now = options.now ?? Date.now;
  let previousSample: TransferSample = { receivedBytes: status.receivedBytes, at: now() };

  for (let index = status.receivedChunks; index < status.chunkCount; index += 1) {
    await options.controller?.waitUntilRunnable();
    const start = index * status.chunkSize;
    const end = Math.min(start + status.chunkSize, file.size);
    status = await api.uploadResumableChunk(status.id, index, file.slice(start, end));
    options.onProgress?.(status);
    const currentSample = { receivedBytes: status.receivedBytes, totalBytes: status.totalBytes, at: now() };
    const transfer = calculateTransferProgress(previousSample, currentSample);
    options.onTransferProgress?.({
      phase: "uploading", status: "running", percent: transfer.percent,
      processedBytes: status.receivedBytes, totalBytes: status.totalBytes,
      bytesPerSecond: transfer.bytesPerSecond, estimatedSeconds: transfer.estimatedSeconds,
      detail: `正在上传第 ${status.receivedChunks}/${status.chunkCount} 块`
    });
    previousSample = currentSample;
  }

  await options.controller?.waitUntilRunnable();
  options.onTransferProgress?.({
    phase: "validating", status: "running", percent: 0,
    processedBytes: status.receivedBytes, totalBytes: status.totalBytes,
    detail: "正在进行服务端校验"
  });
  const summary = await importUpload(status.id);
  options.onTransferProgress?.({
    phase: "snapshot", status: "completed", percent: 100,
    processedBytes: status.receivedBytes, totalBytes: status.totalBytes,
    detail: summary.unchanged ? "内容版本没有变化" : "已创建新的内容版本"
  });
  storage?.delete(key);
  return summary;
}
