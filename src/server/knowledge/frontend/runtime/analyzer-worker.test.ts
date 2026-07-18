import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { analyzeWorkerRequest } from "./analyzer-worker";

describe("analyzer worker entry", () => {
  test("returns only virtual source metadata and empty analyzer outputs before FK08", () => {
    const content = "export const value = 1;\n";
    expect(analyzeWorkerRequest({
      type: "analyze",
      requestId: "00000000-0000-4000-8000-000000000001",
      snapshotId: "snapshot-1",
      analyzerIds: ["typescript-core", "typescript-core"],
      sources: [{
        path: "src/value.ts",
        contentBase64: Buffer.from(content).toString("base64"),
        blobHash: createHash("sha256").update(content).digest("hex")
      }]
    })).toEqual({
      schemaVersion: 1,
      snapshotId: "snapshot-1",
      analyzerIds: ["typescript-core"],
      sourcePaths: ["src/value.ts"],
      outputs: []
    });
  });
});
