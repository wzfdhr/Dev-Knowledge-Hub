import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { extractSnapshotWebKnowledgeIR } from "../intelligence";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("extractSnapshotWebKnowledgeIR", () => {
  test("combines snapshot web sources in path order without resolving dynamic imports", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-web-ir-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "src"));
    const first = "export const Zed = () => null;\n";
    const second = "export async function load() { return import('./not-resolved'); }\n";
    await writeFile(path.join(root, "src", "z.tsx"), first);
    await writeFile(path.join(root, "src", "a.js"), second);
    const files = [
      { snapshotId: "snapshot-1", path: "src/z.tsx", byteSize: Buffer.byteLength(first), contentHash: createHash("sha256").update(first).digest("hex") },
      { snapshotId: "snapshot-1", path: "src/a.js", byteSize: Buffer.byteLength(second), contentHash: createHash("sha256").update(second).digest("hex") }
    ];

    const result = await extractSnapshotWebKnowledgeIR({
      snapshot: { id: "snapshot-1", storagePath: root }, files
    });

    expect(result.ir.files.map((file) => file.path)).toEqual(["src/a.js", "src/z.tsx"]);
    expect(result.ir.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "load", kind: "function" }),
      expect.objectContaining({ name: "Zed", kind: "component" })
    ]));
    expect(result.ir.imports).toEqual([expect.objectContaining({ specifier: "./not-resolved", kind: "dynamic" })]);
    await expect(extractSnapshotWebKnowledgeIR({ snapshot: { id: "snapshot-1", storagePath: root }, files }))
      .resolves.toEqual(result);
  });
});
