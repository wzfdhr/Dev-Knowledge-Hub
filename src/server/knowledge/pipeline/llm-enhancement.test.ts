import { describe, expect, test, vi } from "vitest";

import { StructuredKnowledgeEnhancer } from "./llm-enhancement";

const citation = {
  path: "src/math.ts",
  startLine: 1,
  endLine: 4,
  commitSha: "a".repeat(40),
  blobHash: "b".repeat(64)
};

describe("StructuredKnowledgeEnhancer", () => {
  test("validates structured Chinese output and reuses an input-digest cache entry", async () => {
    const complete = vi.fn(async () => JSON.stringify({
      summary: "该模块提供基础数学运算。",
      aliases: ["math", "数学运算"],
      citations: [citation]
    }));
    const enhancer = new StructuredKnowledgeEnhancer({ complete });
    const request = {
      inputDigest: "c".repeat(64), deterministicBody: "export function add(a: number, b: number) { return a + b; }",
      citations: [citation]
    };

    await expect(enhancer.enhance(request)).resolves.toEqual({
      mode: "enhanced", summary: "该模块提供基础数学运算。", aliases: ["math", "数学运算"], citations: [citation]
    });
    await expect(enhancer.enhance(request)).resolves.toMatchObject({ mode: "enhanced" });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test("falls back without provider text when a response is malformed or cites an unverified file", async () => {
    const malformed = new StructuredKnowledgeEnhancer({ complete: async () => "not-json" });
    const hallucinated = new StructuredKnowledgeEnhancer({ complete: async () => JSON.stringify({
      summary: "不存在的文件。", aliases: [], citations: [{ ...citation, path: "src/invented.ts" }]
    }) });
    const request = { inputDigest: "d".repeat(64), deterministicBody: "deterministic", citations: [citation] };

    await expect(malformed.enhance(request)).resolves.toEqual({
      mode: "fallback", summary: null, aliases: [], citations: [citation], warning: "LLM_INVALID_RESPONSE"
    });
    await expect(hallucinated.enhance(request)).resolves.toEqual({
      mode: "fallback", summary: null, aliases: [], citations: [citation], warning: "CITATION_INVALID"
    });
  });

  test("falls back after the configured provider deadline without retrying", async () => {
    const complete = vi.fn(() => new Promise<never>(() => undefined));
    const enhancer = new StructuredKnowledgeEnhancer({ complete }, { timeoutMs: 1 });

    await expect(enhancer.enhance({
      inputDigest: "e".repeat(64), deterministicBody: "deterministic", citations: [citation]
    })).resolves.toMatchObject({ mode: "fallback", warning: "LLM_TIMEOUT", citations: [citation] });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
