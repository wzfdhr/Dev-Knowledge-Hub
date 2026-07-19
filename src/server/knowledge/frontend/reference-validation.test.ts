import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { frontendSourceReferenceIsValid, loadFrontendSourceDescriptors } from "./reference-validation.js";

describe("frontend candidate reference validation", () => {
  test("binds references to a readable snapshot file, blob hash, and line range", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-frontend-refs-"));
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

  test("validates 50,000 source references through constant-time descriptor lookup", () => {
    const blobHash = "a".repeat(64);
    const sources = new Map(Array.from({ length: 50_000 }, (_, index) => {
      const source = { path: `src/file-${index}.ts`, blobHash, lineCount: 10 };
      return [source.path, source] as const;
    }));

    for (let index = 0; index < 50_000; index += 1) {
      expect(frontendSourceReferenceIsValid({
        snapshotId: "snapshot", path: `src/file-${index}.ts`, startLine: 1, endLine: 10, blobHash
      }, "snapshot", sources)).toBe(true);
    }
  });
});
