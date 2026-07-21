import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { frontendSourceReferenceIsValid, loadFrontendSourceDescriptors } from "./reference-validation.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("frontend candidate reference validation", () => {
  test("binds references to a readable snapshot file, blob hash, and line range", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-frontend-refs-"));
    temporaryRoots.push(root);
    await mkdir(path.join(root, "src"));
    const content = "export const one = 1;\nexport const two = 2;\n";
    await writeFile(path.join(root, "src/app.ts"), content);
    const blobHash = createHash("sha256").update(content).digest("hex");
    const sources = await loadFrontendSourceDescriptors({
      snapshot: { id: "snapshot", storagePath: root },
      files: [{ path: "src/app.ts", contentHash: blobHash }]
    });
    const ref = { snapshotId: "snapshot", path: "src/app.ts", startLine: 1, endLine: 2, blobHash };

    expect(frontendSourceReferenceIsValid(ref, "snapshot", sources)).toBe(true);
    expect(frontendSourceReferenceIsValid({ ...ref, snapshotId: "other" }, "snapshot", sources)).toBe(false);
    expect(frontendSourceReferenceIsValid({ ...ref, blobHash: "0".repeat(64) }, "snapshot", sources)).toBe(false);
    expect(frontendSourceReferenceIsValid({ ...ref, endLine: 3 }, "snapshot", sources)).toBe(false);
  });

  test("physically loads, hashes, decodes, and validates the 50,000-file contract", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-frontend-refs-scale-"));
    temporaryRoots.push(root);
    const content = "export const value = 1;\n";
    await writeFile(path.join(root, "source.ts"), content);
    const blobHash = createHash("sha256").update(content).digest("hex");
    const files = Array.from({ length: 50_000 }, (_, index) => ({ path: `source-${index}.ts`, contentHash: blobHash }));
    for (let offset = 0; offset < files.length; offset += 250) {
      await Promise.all(files.slice(offset, offset + 250)
        .map((file) => link(path.join(root, "source.ts"), path.join(root, file.path))));
    }

    const sources = await loadFrontendSourceDescriptors({
      snapshot: { id: "snapshot", storagePath: root }, files
    });

    expect(sources.size).toBe(50_000);
    for (let index = 0; index < 50_000; index += 1) {
      expect(frontendSourceReferenceIsValid({
        snapshotId: "snapshot", path: `source-${index}.ts`, startLine: 1, endLine: 1, blobHash
      }, "snapshot", sources)).toBe(true);
    }
  }, 60_000);
});
