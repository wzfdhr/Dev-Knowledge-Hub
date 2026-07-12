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
    const architecture = output.pages.find((page) => page.slug === "architecture-overview");
    expect(architecture?.title).toBe("架构概览");
    expect(architecture?.body).toContain("本快照包含");
    expect(architecture?.citations.some((citation) => citation.path === "src/math.ts")).toBe(true);
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
      .toContain("# 架构概览");
    expect(() => validateKnowledge(output, index)).not.toThrow();
  });

  test("uses collision-safe stable slugs for every overload declaration", async () => {
    const output = await generateKnowledge(index);
    const overloadPages = output.pages.filter((page) =>
      page.kind === "symbol" && page.title === "format"
    );

    expect(overloadPages).toHaveLength(4);
    expect(new Set(overloadPages.map((page) => page.slug)).size).toBe(4);
    expect(new Set(output.pages.map((page) => page.slug)).size).toBe(output.pages.length);
    expect(overloadPages.map((page) => page.slug)).toEqual([...overloadPages.map((page) => page.slug)].sort());
  });

  test("injects acknowledged feedback into deterministic and optional generation context", async () => {
    const citation = index.files.find((file) => file.path === "src/math.ts")!;
    const enhance = vi.fn(async ({ deterministicBody }: { deterministicBody: string }) => deterministicBody);
    const purpose = {
      kind: "feedback",
      feedbackIds: ["feedback-1"],
      feedbackContext: [{
        feedbackId: "feedback-1",
        releaseId: "release-1",
        query: "How should add handle overflow?",
        reason: "Overflow behavior is undocumented",
        expected: "Document the accepted range",
        citations: [citation]
      }]
    };

    const generateWithPurpose = generateKnowledge as unknown as (
      source: CodeIndex,
      enhancer: { enhance: typeof enhance },
      context: { purpose: typeof purpose }
    ) => ReturnType<typeof generateKnowledge>;
    const output = await generateWithPurpose(index, { enhance }, { purpose });

    const feedbackPage = output.pages.find((page) => page.slug === "feedback-rebuild-context");
    expect(feedbackPage?.body).toContain("How should add handle overflow?");
    expect(feedbackPage?.body).toContain("Overflow behavior is undocumented");
    expect(feedbackPage?.body).toContain("Document the accepted range");
    expect(feedbackPage?.body).toContain("src/math.ts");
    expect(enhance).toHaveBeenCalledWith(expect.objectContaining({ buildPurpose: purpose }));
    expect(() => validateKnowledge(output, index)).not.toThrow();
  });
});
