import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { convertSnapshotSourceFile } from "./convert";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("convertSnapshotSourceFile", () => {
  test("reads the 1 MiB boundary deterministically from the immutable snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-convert-"));
    temporaryDirectories.push(root);
    const content = Buffer.alloc(1024 * 1024, 0x61);
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "large.ts"), content);

    const converted = await convertSnapshotSourceFile({
      snapshot: { id: "snapshot-1", storagePath: root },
      file: {
        snapshotId: "snapshot-1", path: "src/large.ts",
        byteSize: content.byteLength, contentHash: createHash("sha256").update(content).digest("hex")
      }
    });

    expect(converted).toEqual(expect.objectContaining({ path: "src/large.ts", content: content.toString("utf8") }));
  });

  test("rejects files that do not belong to the supplied snapshot", async () => {
    await expect(convertSnapshotSourceFile({
      snapshot: { id: "snapshot-1", storagePath: "/unused" },
      file: {
        snapshotId: "another-snapshot", path: "src/app.ts", byteSize: 0, contentHash: "a".repeat(64)
      }
    })).rejects.toThrow("does not belong");
  });
});
