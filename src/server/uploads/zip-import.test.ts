import { chmod, mkdtemp, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { afterEach, describe, expect, test, vi } from "vitest";

import { MemoryAppStore } from "../persistence/memory-store.js";
import {
  importZipArchive,
  MAX_UPLOAD_COMPRESSED_BYTES,
  UploadArchiveError,
  type UploadArchiveLimits
} from "./zip-import.js";

const temporaryDirectories: string[] = [];

async function zip(entries: Array<{
  name: string;
  content?: string;
  encrypted?: boolean;
  externalFileAttributes?: number;
}>): Promise<Buffer> {
  const output = new Uint8ArrayWriter();
  const writer = new ZipWriter(output);
  for (const entry of entries) {
    await writer.add(entry.name, new TextReader(entry.content ?? ""), {
      ...(entry.encrypted ? { password: "secret" } : {}),
      ...(entry.externalFileAttributes === undefined
        ? {}
        : { externalFileAttributes: entry.externalFileAttributes })
    });
  }
  return Buffer.from(await writer.close());
}

function replaceZipFilename(archive: Buffer, from: string, to: string): Buffer {
  expect(Buffer.byteLength(from)).toBe(Buffer.byteLength(to));
  const result = Buffer.from(archive);
  let offset = 0;
  while ((offset = result.indexOf(from, offset, "utf8")) !== -1) {
    result.write(to, offset, "utf8");
    offset += Buffer.byteLength(to);
  }
  return result;
}

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devkh-upload-"));
  temporaryDirectories.push(dataDir);
  const archivePath = path.join(dataDir, "input.zip");
  const store = new MemoryAppStore();
  return { dataDir, archivePath, store };
}

async function runImport(
  archive: Buffer,
  limits?: Partial<UploadArchiveLimits>
) {
  const context = await fixture();
  await writeFile(context.archivePath, archive);
  const summary = await importZipArchive({
    archivePath: context.archivePath,
    dataDir: context.dataDir,
    workspaceId: "workspace-1",
    repositoryId: "repository-1",
    actorId: "admin-1",
    store: context.store,
    limits
  });
  return { ...context, summary };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  async function makeWritable(directory: string): Promise<void> {
    await chmod(directory, 0o700).catch(() => undefined);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) =>
      makeWritable(path.join(directory, entry.name))
    ));
  }
  await Promise.all(temporaryDirectories.map(makeWritable));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("ZIP snapshot import", () => {
  test.each([
    ["absolute", "/src/index.ts"],
    ["drive absolute", "C:/src/index.ts"],
    ["traversal", "../src/index.ts"],
    ["backslash traversal", "..\\src\\index.ts"]
  ])("rejects %s paths", async (_case, name) => {
    const context = await fixture();
    await writeFile(context.archivePath, await zip([{ name, content: "export {};" }]));

    await expect(importZipArchive({
      archivePath: context.archivePath,
      dataDir: context.dataDir,
      workspaceId: "workspace-1",
      repositoryId: "repository-1",
      actorId: "admin-1",
      store: context.store
    })).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE_PATH" });
  });

  test("rejects duplicate normalized paths", async () => {
    const archive = replaceZipFilename(await zip([
      { name: "src/a.ts", content: "export const a = 1;" },
      { name: "src/b.ts", content: "export const b = 2;" }
    ]), "src/b.ts", "src/a.ts");

    await expect(runImport(archive)).rejects.toMatchObject({ code: "DUPLICATE_ARCHIVE_PATH" });
  });

  test("rejects encrypted entries and symbolic links", async () => {
    await expect(runImport(await zip([
      { name: "secret.ts", content: "secret", encrypted: true }
    ]))).rejects.toMatchObject({ code: "ENCRYPTED_ARCHIVE" });

    const symlinkMode = (0o120777 << 16) >>> 0;
    await expect(runImport(await zip([
      { name: "link.ts", content: "target.ts", externalFileAttributes: symlinkMode }
    ]))).rejects.toMatchObject({ code: "SYMLINK_NOT_ALLOWED" });
  });

  test("enforces entry-count and expanded-size limits from archive metadata", async () => {
    const archive = await zip([
      { name: "one.ts", content: "12345" },
      { name: "two.ts", content: "67890" }
    ]);

    await expect(runImport(archive, { maxEntries: 1 })).rejects
      .toMatchObject({ code: "TOO_MANY_ENTRIES" });
    await expect(runImport(archive, { maxExpandedBytes: 9 })).rejects
      .toMatchObject({ code: "EXPANDED_SIZE_LIMIT" });
  });

  test("rejects a compressed upload larger than 100 MiB without reading it", async () => {
    const context = await fixture();
    const file = await open(context.archivePath, "w");
    await file.truncate(MAX_UPLOAD_COMPRESSED_BYTES + 1);
    await file.close();

    await expect(importZipArchive({
      archivePath: context.archivePath,
      dataDir: context.dataDir,
      workspaceId: "workspace-1",
      repositoryId: "repository-1",
      actorId: "admin-1",
      store: context.store
    })).rejects.toMatchObject({ code: "COMPRESSED_SIZE_LIMIT" });
    await expect(stat(context.archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("filters like git snapshots and creates a deterministic 40-character content version", async () => {
    const accepted = [
      { name: "src/index.ts", content: "export const answer = 42;\n" },
      { name: ".env.example", content: "TOKEN=example\n" },
      { name: "package-lock.json", content: "{}\n" }
    ];
    const ignored = [
      { name: ".env", content: "TOKEN=real-secret\n" },
      { name: "dist/generated.ts", content: "export const generated = true;\n" },
      { name: "src/generated.ts", content: "// @generated\nexport {};\n" },
      { name: "src/image.ts", content: "hello\0binary" },
      { name: "notes.txt", content: "not a source extension" },
      { name: "src/large.ts", content: "x".repeat(33) }
    ];
    const first = await runImport(await zip([...accepted, ...ignored]), { maxSourceFileBytes: 32 });
    const second = await runImport(await zip([...accepted].reverse()), { maxSourceFileBytes: 32 });

    expect(first.summary.sourceVersion).toMatch(/^[a-f0-9]{40}$/);
    expect(second.summary.sourceVersion).toBe(first.summary.sourceVersion);
    expect(first.summary.fileCount).toBe(3);
    expect(first.summary.ignored).toEqual({
      total: 6,
      reasons: {
        binary: 1,
        excluded_directory: 1,
        generated: 1,
        sensitive_file: 1,
        unsupported_extension: 1,
        file_too_large: 1
      }
    });
    expect(first.store.sourceFiles.map((file) => file.path).sort()).toEqual([
      ".env.example",
      "package-lock.json",
      "src/index.ts"
    ]);
    expect(await readFile(path.join(
      first.summary.storagePath,
      "src/index.ts"
    ), "utf8")).toBe("export const answer = 42;\n");
    expect((await stat(path.join(first.summary.storagePath, "src/index.ts"))).mode & 0o222).toBe(0);
    expect((await stat(path.dirname(first.summary.storagePath))).mode & 0o222).toBe(0);
  });

  test("rejects malformed ZIP bytes and removes them", async () => {
    const context = await fixture();
    await writeFile(context.archivePath, "not a ZIP");

    await expect(importZipArchive({
      archivePath: context.archivePath,
      dataDir: context.dataDir,
      workspaceId: "workspace-1",
      repositoryId: "repository-1",
      actorId: "admin-1",
      store: context.store
    })).rejects.toMatchObject({ code: "INVALID_ZIP" });
    await expect(stat(context.archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("preserves operational persistence errors and removes the promoted snapshot", async () => {
    const context = await fixture();
    await writeFile(context.archivePath, await zip([
      { name: "src/index.ts", content: "export {};\n" }
    ]));
    vi.spyOn(context.store, "createSnapshotWithAudit")
      .mockRejectedValue(new Error("database unavailable"));

    await expect(importZipArchive({
      archivePath: context.archivePath,
      dataDir: context.dataDir,
      workspaceId: "workspace-1",
      repositoryId: "repository-1",
      actorId: "admin-1",
      store: context.store
    })).rejects.toThrow("database unavailable");
    await expect(readdir(path.join(context.dataDir, "uploads"))).resolves.toEqual([]);
    await expect(readdir(path.join(context.dataDir, "snapshots"))).resolves.toEqual([]);
  });

  test("does not retain the raw ZIP after import", async () => {
    const { dataDir, summary } = await runImport(await zip([
      { name: "src/index.ts", content: "export {};\n" }
    ]));

    expect(summary.unchanged).toBe(false);
    await expect(stat(path.join(dataDir, "input.zip"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(path.join(dataDir, "uploads"))).resolves.toEqual([]);
  });

  test("uses an existing snapshot for identical accepted content without retaining another tree", async () => {
    const context = await fixture();
    const archive = await zip([{ name: "src/index.ts", content: "export {};\n" }]);
    await writeFile(context.archivePath, archive);
    const options = {
      archivePath: context.archivePath,
      dataDir: context.dataDir,
      workspaceId: "workspace-1",
      repositoryId: "repository-1",
      actorId: "admin-1",
      store: context.store
    };
    const first = await importZipArchive(options);
    await writeFile(context.archivePath, archive);
    const second = await importZipArchive(options);

    expect(second).toMatchObject({
      snapshotId: first.snapshotId,
      sourceVersion: first.sourceVersion,
      unchanged: true
    });
    expect(await readdir(path.join(context.dataDir, "snapshots"))).toHaveLength(1);
  });

  test("exposes stable typed archive errors", () => {
    const error = new UploadArchiveError("INVALID_ZIP", "Invalid ZIP archive");
    expect(error).toMatchObject({ name: "UploadArchiveError", code: "INVALID_ZIP" });
  });
});
