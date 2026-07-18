import { describe, expect, test } from "vitest";

import { assertAnalyzerOutputStructure } from "./analyzer-worker";

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
});
