import { describe, expect, test } from "vitest";

import {
  assertAnalyzerOutputStructure,
  MAX_ANALYZER_OUTPUT_BYTES,
  MAX_ANALYZER_OUTPUT_DEPTH,
  MAX_ANALYZER_OUTPUT_NODES
} from "./analyzer-worker";

describe("analyzer worker structural limits", () => {
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
