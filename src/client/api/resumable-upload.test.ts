import { describe, expect, test, vi } from "vitest";

import {
  UploadCancelledError,
  calculateTransferProgress,
  createUploadController,
  uploadProjectZipResumably
} from "./resumable-upload";

function zipFixture(content: string): File {
  const bytes = new TextEncoder().encode(content);
  return {
    name: "project.zip",
    size: bytes.byteLength,
    lastModified: 42,
    slice: (start: number, end: number) => new Blob([bytes.slice(start, end)])
  } as File;
}

describe("uploadProjectZipResumably", () => {
  test("calculates transfer speed, ETA and percentage from samples", () => {
    expect(calculateTransferProgress(
      { receivedBytes: 8, at: 1_000 },
      { receivedBytes: 12, totalBytes: 20, at: 3_000 }
    )).toEqual({ bytesPerSecond: 2, estimatedSeconds: 4, percent: 60 });
  });

  test("pauses, resumes and cancels between upload chunks", async () => {
    const controller = createUploadController();
    controller.pause();
    let continued = false;
    const waiting = controller.waitUntilRunnable().then(() => { continued = true; });

    await Promise.resolve();
    expect(continued).toBe(false);
    controller.resume();
    await waiting;
    expect(continued).toBe(true);

    controller.cancel();
    await expect(controller.waitUntilRunnable()).rejects.toBeInstanceOf(UploadCancelledError);
  });

  test("continues an existing sequential session before importing its project ZIP", async () => {
    const chunks: Array<{ index: number; content: Blob }> = [];
    const storage = new Map<string, string>();
    const api = {
      createResumableUpload: vi.fn(),
      getResumableUpload: vi.fn().mockResolvedValue({
        id: "session-1", totalBytes: 10, chunkSize: 4, chunkCount: 3,
        receivedBytes: 4, receivedChunks: 1, complete: false, finalized: false
      }),
      uploadResumableChunk: vi.fn(async (_sessionId: string, index: number, content: Blob) => {
        chunks.push({ index, content });
        return { id: "session-1", totalBytes: 10, chunkSize: 4, chunkCount: 3,
          receivedBytes: index === 1 ? 8 : 10, receivedChunks: index + 1,
          complete: index === 2, finalized: false };
      }),
      importResumableUpload: vi.fn().mockResolvedValue({
        snapshotId: "snapshot-1", sourceVersion: "a".repeat(40), fileCount: 2,
        unchanged: false, ignored: { total: 0, reasons: {} }
      }),
      importResumableReplacementUpload: vi.fn()
    };
    const progress = vi.fn();
    storage.set("devkh:resumable:project-1:project.zip:10:42", "session-1");

    const result = await uploadProjectZipResumably(api, "project-1", zipFixture("0123456789"), {
      chunkSize: 4,
      storage,
      onProgress: progress
    });

    expect(api.createResumableUpload).not.toHaveBeenCalled();
    expect(chunks.map((chunk) => chunk.index)).toEqual([1, 2]);
    expect(await chunks[0].content.text()).toBe("4567");
    expect(await chunks[1].content.text()).toBe("89");
    expect(api.importResumableUpload).toHaveBeenCalledWith("project-1", "session-1");
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ receivedBytes: 10, complete: true }));
    expect(storage.size).toBe(0);
    expect(result.snapshotId).toBe("snapshot-1");
  });

  test("keeps the resumable session when a local upload is cancelled", async () => {
    const storage = new Map<string, string>();
    const controller = createUploadController();
    const api = {
      createResumableUpload: vi.fn().mockResolvedValue({
        id: "session-2", totalBytes: 10, chunkSize: 4, chunkCount: 3,
        receivedBytes: 0, receivedChunks: 0, complete: false, finalized: false
      }),
      getResumableUpload: vi.fn(),
      uploadResumableChunk: vi.fn().mockImplementation(async () => {
        controller.cancel();
        return { id: "session-2", totalBytes: 10, chunkSize: 4, chunkCount: 3,
          receivedBytes: 4, receivedChunks: 1, complete: false, finalized: false };
      }),
      importResumableUpload: vi.fn(),
      importResumableReplacementUpload: vi.fn()
    };

    await expect(uploadProjectZipResumably(api, "project-2", zipFixture("0123456789"), {
      chunkSize: 4,
      storage,
      controller
    })).rejects.toBeInstanceOf(UploadCancelledError);

    expect(storage.get("devkh:resumable:project-2:project.zip:10:42")).toBe("session-2");
    expect(api.uploadResumableChunk).toHaveBeenCalledTimes(1);
    expect(api.importResumableUpload).not.toHaveBeenCalled();
  });
});
