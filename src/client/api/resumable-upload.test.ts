import { describe, expect, test, vi } from "vitest";

import { uploadProjectZipResumably } from "./resumable-upload";

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
});
