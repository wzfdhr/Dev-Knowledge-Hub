import { createHash, randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  assertAnalyzerOutputStructure,
  MAX_ANALYZER_OUTPUT_BYTES,
  MAX_ANALYZER_OUTPUT_DEPTH,
  MAX_ANALYZER_OUTPUT_NODES,
  analyzeWorkerRequest
} from "./analyzer-worker";
import { typeScriptSyntaxParserConfigDigest } from "../typescript-program";

function parserSource(path: string, content: string) {
  return {
    path,
    contentBase64: Buffer.from(content, "utf8").toString("base64"),
    blobHash: createHash("sha256").update(content, "utf8").digest("hex")
  };
}

describe("analyzer worker structural limits", () => {
  test("analyzes project context and emits path-free file syntax facts", () => {
    const result = analyzeWorkerRequest({
      type: "analyze",
      requestId: randomUUID(),
      snapshotId: "snapshot-1",
      analyzerIds: ["frontend-project"],
      cachedAnalyses: [],
      sources: [
        parserSource("package.json", JSON.stringify({ workspaces: ["apps/*"] })),
        parserSource("tsconfig.json", JSON.stringify({
          compilerOptions: { baseUrl: ".", paths: { "@app/*": ["apps/site/src/*"] } }
        })),
        parserSource("apps/site/package.json", JSON.stringify({ name: "site" })),
        parserSource("apps/site/src/value.ts", "export const value = 1;"),
        parserSource("apps/site/src/main.ts", "import { value } from '@app/value'; export const total = value;")
      ]
    });

    expect(result.outputs).toHaveLength(1);
    const output = result.outputs[0]!;
    expect(output).toMatchObject({
      analyzerId: "typescript-project",
      analyzerVersion: "1.0.0",
      projectManifest: { packages: [{ name: null }, { name: "site" }] },
      resolutions: [{
        containingFile: "apps/site/src/main.ts",
        specifier: "@app/value",
        resolvedPath: "apps/site/src/value.ts"
      }]
    });
    expect(output.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        blobHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        facts: expect.objectContaining({
          schemaVersion: 1,
          declarations: expect.arrayContaining([expect.objectContaining({ name: "total" })])
        })
      })
    ]));
    expect(JSON.stringify(output.files)).not.toContain("snapshot-1");
    expect(output.files.every((file) => Object.hasOwn(file, "path"))).toBe(true);
    expect(output.files.some((file) => Object.hasOwn(file.facts, "path"))).toBe(false);
  });

  test("reuses validated path-free cached syntax facts", () => {
    const input = parserSource("src/value.ts", "export const value = 1;");
    const cachedFacts = { schemaVersion: 1, declarations: [], imports: [] };
    const result = analyzeWorkerRequest({
      type: "analyze",
      requestId: randomUUID(),
      snapshotId: "snapshot-2",
      analyzerIds: ["frontend-project"],
      sources: [input],
      cachedAnalyses: [{
        path: input.path,
        blobHash: input.blobHash,
        analyzerId: "typescript-syntax",
        analyzerVersion: "1.0.0",
        parserConfigDigest: typeScriptSyntaxParserConfigDigest(input.path),
        facts: cachedFacts
      }]
    });

    expect(result.outputs[0]?.files[0]?.facts).toEqual(cachedFacts);
  });

  test("accepts bounded analyzer output", () => {
    expect(() => assertAnalyzerOutputStructure({ outputs: [{ id: "node-1" }] }, {
      maxNodes: 10,
      maxDepth: 4
    })).not.toThrow();
  });

  test("rejects output with too many structural values", () => {
    expect(() => assertAnalyzerOutputStructure({ outputs: Array.from({ length: 10 }, () => ({})) }, {
      maxNodes: 5,
      maxDepth: 10
    })).toThrow("node limit");
  });

  test("rejects deeply nested or cyclic output without recursive traversal", () => {
    expect(() => assertAnalyzerOutputStructure({ child: { child: { child: true } } }, {
      maxNodes: 100,
      maxDepth: 2
    })).toThrow("depth limit");
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => assertAnalyzerOutputStructure(cyclic, { maxNodes: 100, maxDepth: 10 }))
      .toThrow("cycle");
  });

  test("locks the production output limits and their exact structural boundaries", () => {
    expect(MAX_ANALYZER_OUTPUT_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_ANALYZER_OUTPUT_NODES).toBe(100_000);
    expect(MAX_ANALYZER_OUTPUT_DEPTH).toBe(256);

    expect(() => assertAnalyzerOutputStructure(
      Array.from({ length: MAX_ANALYZER_OUTPUT_NODES - 1 }, () => null),
      { maxNodes: MAX_ANALYZER_OUTPUT_NODES, maxDepth: MAX_ANALYZER_OUTPUT_DEPTH }
    )).not.toThrow();
    expect(() => assertAnalyzerOutputStructure(
      Array.from({ length: MAX_ANALYZER_OUTPUT_NODES }, () => null),
      { maxNodes: MAX_ANALYZER_OUTPUT_NODES, maxDepth: MAX_ANALYZER_OUTPUT_DEPTH }
    )).toThrow("node limit");

    let withinDepth: Record<string, unknown> = {};
    for (let depth = 0; depth < MAX_ANALYZER_OUTPUT_DEPTH; depth += 1) withinDepth = { child: withinDepth };
    expect(() => assertAnalyzerOutputStructure(withinDepth, {
      maxNodes: MAX_ANALYZER_OUTPUT_NODES, maxDepth: MAX_ANALYZER_OUTPUT_DEPTH
    })).not.toThrow();
    expect(() => assertAnalyzerOutputStructure({ child: withinDepth }, {
      maxNodes: MAX_ANALYZER_OUTPUT_NODES, maxDepth: MAX_ANALYZER_OUTPUT_DEPTH
    })).toThrow("depth limit");
  });
});
