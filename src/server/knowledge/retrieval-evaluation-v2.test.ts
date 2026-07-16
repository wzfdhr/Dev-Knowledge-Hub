import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  assertRetrievalQuality,
  evaluateRetrievalCases,
  evaluateRetrievalCasesWithDetails,
  graphRankingImproves,
  parseRetrievalCases,
  type RetrievalEvaluationCase
} from "./retrieval-evaluation-v2";

const casesPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../evaluation/knowledge-v2/cases.jsonl"
);

describe("knowledge-v2 retrieval evaluation dataset", () => {
  test("rejects empty, duplicate, ambiguous, and malformed cases", () => {
    expect(() => parseRetrievalCases("")).toThrow("must not be empty");
    expect(() => parseRetrievalCases([
      JSON.stringify({ id: "duplicate", query: "add", project: "fixture-a", expectedTitles: ["add"], category: "symbol", source: "fixture" }),
      JSON.stringify({ id: "duplicate", query: "clamp", project: "fixture-a", expectedTitles: ["clamp"], category: "symbol", source: "fixture" })
    ].join("\n"))).toThrow("duplicate id");
    expect(() => parseRetrievalCases(JSON.stringify({
      id: "ambiguous", query: "add", project: "fixture-a", expectEmpty: true, expectedTitles: ["add"], category: "symbol", source: "fixture"
    }))).toThrow("must not declare expected titles or paths");
    expect(() => parseRetrievalCases(JSON.stringify({
      id: "uncited", query: "add", project: "fixture-a", category: "symbol", source: "fixture"
    }))).toThrow("must declare an expected title or path");
    expect(() => parseRetrievalCases(JSON.stringify({
      id: "unclassified", query: "add", project: "fixture-a", expectedTitles: ["add"], source: "fixture"
    }))).toThrow("invalid category");
    expect(() => parseRetrievalCases(JSON.stringify({
      id: "unprovenanced", query: "add", project: "fixture-a", expectedTitles: ["add"], category: "symbol"
    }))).toThrow("invalid source");
    expect(parseRetrievalCases(JSON.stringify({
      id: "approved", query: "add", project: "fixture-a", expectedTitles: ["add"],
      category: "error-feedback", source: "admin-approved-sanitized-feedback"
    }))[0]?.source).toBe("admin-approved-sanitized-feedback");
  });

  test("ships a 140-case public suite with protected retrieval intents", async () => {
    const cases = parseRetrievalCases(await readFile(casesPath, "utf8"));
    const chinese = cases.filter((item) => /[\u3400-\u9fff]/u.test(item.query));
    const empty = cases.filter((item) => item.expectEmpty);
    const categories = new Set(cases.map((item) => item.category));

    expect(cases).toHaveLength(140);
    expect(chinese.length).toBeGreaterThanOrEqual(50);
    expect(empty.length).toBeGreaterThanOrEqual(15);
    expect(categories).toEqual(new Set([
      "symbol", "path", "command", "natural-language", "table", "cross-project", "error-feedback", "no-result"
    ]));
    expect(new Set(cases.map((item) => item.project))).toEqual(new Set(["fixture-a", "fixture-b"]));
    expect(cases.every((item) => item.source === "fixture")).toBe(true);
  });

  test("calculates ranking, citation, and empty-result metrics from executable result sets", async () => {
    const cases: RetrievalEvaluationCase[] = parseRetrievalCases([
      JSON.stringify({ id: "found", query: "add", project: "fixture-a", expectedTitles: ["add"], expectedPaths: ["src/math.ts"], category: "symbol", source: "fixture" }),
      JSON.stringify({ id: "empty", query: "missing", project: "fixture-a", expectEmpty: true, category: "no-result", source: "fixture" })
    ].join("\n"));
    const metrics = await evaluateRetrievalCases(cases, async (item) => item.id === "found" ? [{
      title: "add",
      citations: [{ path: "src/math.ts", startLine: 1, endLine: 1, commitSha: "a".repeat(40), blobHash: "b".repeat(64) }]
    }] : []);

    expect(metrics).toEqual({
      total: 2,
      evaluated: 1,
      emptyCases: 1,
      recallAt5: 1,
      mrr: 1,
      citationValidity: 1,
      falsePositiveEmptyRate: 0
    });
  });

  test("reports failed case ids and rejects a report below the CI quality thresholds", async () => {
    const cases = parseRetrievalCases([
      JSON.stringify({ id: "missed-symbol", query: "add", project: "fixture-a", expectedTitles: ["add"], category: "symbol", source: "fixture" }),
      JSON.stringify({ id: "false-empty", query: "missing", project: "fixture-a", expectEmpty: true, category: "no-result", source: "fixture" })
    ].join("\n"));
    const report = await evaluateRetrievalCasesWithDetails(cases, async (item) => item.id === "false-empty" ? [{
      title: "unrelated", citations: []
    }] : []);

    expect(report.failures.map((failure) => failure.id)).toEqual(["missed-symbol", "false-empty"]);
    expect(() => assertRetrievalQuality(report)).toThrow("missed-symbol, false-empty");
  });

  test("enables graph ranking only for a non-regressing measurable retrieval improvement", () => {
    const baseline = { recallAt5: 0.9, mrr: 0.75, citationValidity: 1, falsePositiveEmptyRate: 0 };

    expect(graphRankingImproves(baseline, { ...baseline, recallAt5: 0.91 })).toBe(true);
    expect(graphRankingImproves(baseline, { ...baseline, mrr: 0.759 })).toBe(false);
    expect(graphRankingImproves(baseline, { ...baseline, recallAt5: 0.89, mrr: 0.8 })).toBe(false);
  });
});
