import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  MAX_RESUMABLE_UPLOAD_BYTES,
  ResumableUploadError,
  ResumableUploadSessionManager
} from "./resumable-upload.js";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{ root: string; manager: ResumableUploadSessionManager }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "devkh-resumable-upload-"));
  temporaryDirectories.push(root);
  return { root, manager: new ResumableUploadSessionManager(root) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("ResumableUploadSessionManager", () => {
  test("creates a disk-backed session with fixed valid upload dimensions", async () => {
    const { root, manager } = await fixture();
    const session = await manager.create({ totalBytes: 9, chunkSize: 4 });

    expect(session).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      totalBytes: 9,
      chunkSize: 4,
      chunkCount: 3,
      receivedBytes: 0,
      receivedChunks: 0,
      complete: false,
      finalized: false
    });
    await expect(readdir(path.join(root, "sessions", session.id))).resolves.toContain("session.json");
    await expect(manager.create({ totalBytes: 0, chunkSize: 4 })).rejects
      .toMatchObject({ code: "INVALID_TOTAL_BYTES" });
    await expect(manager.create({ totalBytes: MAX_RESUMABLE_UPLOAD_BYTES + 1, chunkSize: 4 })).rejects
      .toMatchObject({ code: "TOTAL_BYTES_LIMIT" });
    await expect(manager.create({ totalBytes: 4, chunkSize: 0 })).rejects
      .toMatchObject({ code: "INVALID_CHUNK_SIZE" });
    await expect(manager.create({ totalBytes: 4, chunkSize: 16 * 1024 * 1024 + 1 })).rejects
      .toMatchObject({ code: "CHUNK_SIZE_LIMIT" });
  });

  test("accepts each indexed chunk once and reports its received progress", async () => {
    const { manager } = await fixture();
    const session = await manager.create({ totalBytes: 9, chunkSize: 4 });

    const progress = await manager.uploadChunk(session.id, 1, Buffer.from("efgh"), 4);

    expect(progress).toMatchObject({ receivedBytes: 4, receivedChunks: 1, complete: false });
    await expect(manager.uploadChunk(session.id, 1, Buffer.from("efgh"), 4)).rejects
      .toMatchObject({ code: "CHUNK_ALREADY_RECEIVED" });
    await expect(manager.uploadChunk(session.id, 2, Buffer.from("i"), 4)).rejects
      .toMatchObject({ code: "CHUNK_SIZE_MISMATCH" });
    await expect(manager.uploadChunk(session.id, 2, Buffer.from("i"), 2)).rejects
      .toMatchObject({ code: "CHUNK_SIZE_MISMATCH" });

    await manager.uploadChunk(session.id, 0, Buffer.from("abcd"), 4);
    const complete = await manager.uploadChunk(session.id, 2, Buffer.from("i"), 1);
    expect(complete).toMatchObject({ receivedBytes: 9, receivedChunks: 3, complete: true });
  });

  test("resumes an on-disk session with a fresh manager instance", async () => {
    const { root, manager } = await fixture();
    const session = await manager.create({ totalBytes: 8, chunkSize: 4 });
    await manager.uploadChunk(session.id, 0, Buffer.from("abcd"), 4);

    const resumed = new ResumableUploadSessionManager(root);
    expect(await resumed.status(session.id)).toMatchObject({
      receivedBytes: 4,
      receivedChunks: 1,
      complete: false
    });
    await resumed.uploadChunk(session.id, 1, Buffer.from("efgh"), 4);
    expect((await resumed.status(session.id)).complete).toBe(true);
  });

  test("finalizes atomically only after the exact upload is complete", async () => {
    const { root, manager } = await fixture();
    const session = await manager.create({ totalBytes: 9, chunkSize: 4 });
    await manager.uploadChunk(session.id, 1, Buffer.from("efgh"), 4);

    await expect(manager.finalize(session.id)).rejects.toMatchObject({ code: "UPLOAD_INCOMPLETE" });
    await expect(readdir(path.join(root, "completed"))).resolves.toEqual([]);

    await manager.uploadChunk(session.id, 0, Buffer.from("abcd"), 4);
    await manager.uploadChunk(session.id, 2, Buffer.from("i"), 1);
    const finalized = await manager.finalize(session.id);

    expect(finalized).toMatchObject({ id: session.id, byteSize: 9 });
    await expect(readFile(finalized.path, "utf8")).resolves.toBe("abcdefghi");
    expect(await manager.status(session.id)).toMatchObject({
      receivedBytes: 9,
      receivedChunks: 3,
      complete: true,
      finalized: true
    });
  });

  test("removes expired sessions and orphaned completed uploads while retaining active upload data", async () => {
    const { root, manager } = await fixture();
    const expired = await manager.create({ totalBytes: 4, chunkSize: 4 });
    const active = await manager.create({ totalBytes: 4, chunkSize: 4 });
    await manager.uploadChunk(active.id, 0, Buffer.from("live"), 4);
    const finalized = await manager.finalize(active.id);
    const orphanPath = path.join(root, "completed", "a0b1c2d3-e4f5-6789-abcd-ef0123456789.upload");
    const freshOrphanPath = path.join(root, "completed", "b0b1c2d3-e4f5-6789-abcd-ef0123456789.upload");
    await writeFile(orphanPath, "orphan");
    await writeFile(freshOrphanPath, "fresh");

    const now = new Date("2026-07-14T00:00:00.000Z");
    const expiredAt = new Date(now.getTime() - (25 * 60 * 60 * 1000));
    await utimes(path.join(root, "sessions", expired.id, "session.json"), expiredAt, expiredAt);
    await utimes(orphanPath, expiredAt, expiredAt);
    await utimes(finalized.path, expiredAt, expiredAt);

    await expect(manager.cleanupExpired(now)).resolves.toEqual({ sessions: 1, completed: 1 });
    await expect(manager.status(expired.id)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await expect(manager.status(active.id)).resolves.toMatchObject({ finalized: true });
    await expect(readFile(orphanPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(freshOrphanPath, "utf8")).resolves.toBe("fresh");
    await expect(readFile(finalized.path, "utf8")).resolves.toBe("live");
  });

  test("never maps a supplied session id into an arbitrary path", async () => {
    const { root, manager } = await fixture();

    await expect(manager.status("../../outside")).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await expect(readFile(path.join(root, "outside"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("exposes stable typed upload errors", () => {
    const error = new ResumableUploadError("UPLOAD_INCOMPLETE", "Upload is incomplete");
    expect(error).toMatchObject({ name: "ResumableUploadError", code: "UPLOAD_INCOMPLETE" });
  });
});
