import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { extractSnapshotKnowledgeIR, extractSnapshotWebKnowledgeIR } from "../intelligence";

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

  test("combines Vue and Markdown snapshot sources with the Web IR", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-full-ir-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "src"));
    const vue = "<script setup>const name = 'DevKH'</script><template><main/></template>";
    const markdown = "# Guide\n\nRun npm test.";
    const csv = "name,count\nworkers,2\n";
    await writeFile(path.join(root, "src", "App.vue"), vue);
    await writeFile(path.join(root, "README.md"), markdown);
    await mkdir(path.join(root, "data"));
    await writeFile(path.join(root, "data", "usage.csv"), csv);
    const files = [
      { snapshotId: "snapshot-1", path: "src/App.vue", byteSize: Buffer.byteLength(vue), contentHash: createHash("sha256").update(vue).digest("hex") },
      { snapshotId: "snapshot-1", path: "README.md", byteSize: Buffer.byteLength(markdown), contentHash: createHash("sha256").update(markdown).digest("hex") },
      { snapshotId: "snapshot-1", path: "data/usage.csv", byteSize: Buffer.byteLength(csv), contentHash: createHash("sha256").update(csv).digest("hex") }
    ];

    const result = await extractSnapshotKnowledgeIR({ snapshot: { id: "snapshot-1", storagePath: root }, files });

    expect(result.ir.files.map((file) => file.path)).toEqual(["README.md", "src/App.vue"]);
    expect(result.ir.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: "App", kind: "component" })]));
    expect(result.ir.documents).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Guide", text: "Run npm test." })]));
    expect(result.ir.tables).toEqual([expect.objectContaining({ sourcePath: "data/usage.csv", rowCount: 1 })]);
  });
});
