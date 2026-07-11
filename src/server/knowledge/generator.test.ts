import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test, vi } from "vitest";

import { analyzeSnapshot, type CodeIndex } from "./intelligence";
import {
  chunkPage,
  generateKnowledge,
  KnowledgeValidationError,
  validateKnowledge
} from "./generator";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/code-intelligence"
);
const commitSha = "b".repeat(40);
let index: CodeIndex;

beforeAll(async () => {
  index = await analyzeSnapshot(fixtureRoot, commitSha);
});

describe("deterministic knowledge generation", () => {
  test("creates required, module, and symbol pages with cited chunks", async () => {
    const output = await generateKnowledge(index);
    const slugs = output.pages.map((page) => page.slug);

    expect(slugs).toEqual(expect.arrayContaining([
      "architecture-overview",
      "conventions",
      "run-test-guide",
      "dependency-summary",
      "modules/src-math-ts",
      "symbols/add"
    ]));
    expect(output.pages.every((page) => page.body.trim().length > 0)).toBe(true);
    expect(output.pages.flatMap((page) => page.chunks).every((chunk) =>
      chunk.content.length > 0 && chunk.citations.length > 0
    )).toBe(true);
    expect(() => validateKnowledge(output, index)).not.toThrow();
  });

  test("chunks long sections at stable boundaries without losing citations", () => {
    const citation = index.files.find((file) => file.path === "README.md")!;
    const page = {
      id: "page-1",
      slug: "long-page",
      title: "Long Page",
      body: `# Long Page\n\n${"alpha ".repeat(80)}\n\n${"beta ".repeat(80)}`,
      citations: [citation]
    };

    const chunks = chunkPage(page, 240);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.content.length <= 240)).toBe(true);
    expect(chunks.every((chunk) => JSON.stringify(chunk.citations) === JSON.stringify([citation])))
      .toBe(true);
    expect(chunks.map((chunk) => chunk.content).join("\n")).toContain("beta beta");
  });

  test("rejects missing citations, invalid paths, hashes, and ranges", async () => {
    const output = await generateKnowledge(index);
    const invalid = structuredClone(output);
    invalid.pages[0].chunks[0].citations[0] = {
      ...invalid.pages[0].chunks[0].citations[0],
      path: "../outside.ts",
      startLine: 0,
      blobHash: "0".repeat(64)
    };

    expect(() => validateKnowledge(invalid, index)).toThrow(KnowledgeValidationError);
    invalid.pages[0].chunks[0].citations = [];
    expect(() => validateKnowledge(invalid, index)).toThrow(/citation/i);
  });

  test("falls back to deterministic content and records a warning when enhancement fails", async () => {
    const enhance = vi.fn(async () => {
      throw new Error("provider offline");
    });

    const output = await generateKnowledge(index, { enhance });

    expect(enhance).toHaveBeenCalled();
    expect(output.warnings).toEqual([expect.objectContaining({ code: "ENHANCER_FAILED" })]);
    expect(output.pages.find((page) => page.slug === "architecture-overview")?.body)
      .toContain("# Architecture Overview");
    expect(() => validateKnowledge(output, index)).not.toThrow();
  });
});
