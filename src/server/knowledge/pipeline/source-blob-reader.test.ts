import { createHash } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { MemoryAppStore } from "../../persistence/memory-store.js";
import { removeReadOnlyTree } from "../../uploads/folder-import.js";
import { SourceBlobStore } from "../../uploads/source-blob-store.js";
import { SourceBlobReader } from "./source-blob-reader.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeReadOnlyTree(root)));
});

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devkh-source-blob-reader-"));
  roots.push(dataDir);
  const store = new MemoryAppStore();
  const setup = await store.createInitialSetup("reader@example.com", "hash");
  const blobStore = new SourceBlobStore({ dataDir, catalog: store });
  await blobStore.initialize();
  const bytes = Buffer.from("export const answer = 42;\n");
  const { record } = await blobStore.put({ workspaceId: setup!.workspace.id, bytes });
  const project = (await store.listProjects(setup!.workspace.id))[0]!;
  const repository = await store.createRepository(
    setup!.workspace.id,
    { kind: "upload", name: "Reader source" },
    project.id
  );
  await store.createSnapshot({
    snapshot: {
      id: "snapshot-1", workspaceId: setup!.workspace.id, repositoryId: repository!.id,
      commitSha: "a".repeat(40), ref: "main", remoteUrl: null,
      commitTimestamp: new Date("2026-07-20T00:00:00.000Z"),
      storagePath: path.join(dataDir, "snapshots", "snapshot-1", "files")
    },
    files: [{
      id: "source-file-1", workspaceId: setup!.workspace.id, snapshotId: "snapshot-1",
      path: "src/answer.ts", byteSize: bytes.length, contentHash: hash(bytes),
      language: "typescript", sourceBlobId: record.id
    }]
  });
  const reader = new SourceBlobReader({ catalog: store, blobStore });
  const reference = {
    snapshotId: "snapshot-1",
    path: "src/answer.ts",
    sourceBlobId: record.id,
    blobHash: hash(bytes),
    byteSize: bytes.length,
    language: "typescript"
  };
  return { blobStore, bytes, dataDir, reader, record, reference, workspaceId: setup!.workspace.id };
}

describe("pipeline source blob reader", () => {
  test("revalidates catalog scope, generation metadata, hash, and size", async () => {
    const prepared = await fixture();

    await expect(prepared.reader.read(prepared.workspaceId, prepared.reference)).resolves.toEqual(prepared.bytes);
    await expect(prepared.reader.read("other-workspace", prepared.reference))
      .rejects.toThrow("Source blob reference is outside the pipeline workspace");
    await expect(prepared.reader.read(prepared.workspaceId, { ...prepared.reference, path: "src/other.ts" }))
      .rejects.toThrow("Source blob reference is not bound to the declared snapshot path");
    await expect(prepared.reader.read(prepared.workspaceId, { ...prepared.reference, byteSize: 1 }))
      .rejects.toThrow("Source blob reference does not match persisted metadata");
  });

  test("rejects a physically tampered blob", async () => {
    const prepared = await fixture();
    const blobPath = path.join(prepared.dataDir, prepared.record.storageKey);
    await chmod(blobPath, 0o600);
    await writeFile(blobPath, "tampered");

    await expect(prepared.reader.read(prepared.workspaceId, prepared.reference))
      .rejects.toMatchObject({ code: "SOURCE_BLOB_INTEGRITY_FAILED" });
  });
});
