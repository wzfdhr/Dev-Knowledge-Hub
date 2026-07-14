import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  evaluateRetrievalCases,
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
      JSON.stringify({ id: "duplicate", query: "add", project: "fixture-a", expectedTitles: ["add"] }),
      JSON.stringify({ id: "duplicate", query: "clamp", project: "fixture-a", expectedTitles: ["clamp"] })
    ].join("\n"))).toThrow("duplicate id");
    expect(() => parseRetrievalCases(JSON.stringify({
      id: "ambiguous", query: "add", project: "fixture-a", expectEmpty: true, expectedTitles: ["add"]
    }))).toThrow("must not declare expected titles or paths");
    expect(() => parseRetrievalCases(JSON.stringify({
      id: "uncited", query: "add", project: "fixture-a"
    }))).toThrow("must declare an expected title or path");
  });

  test("ships 100 public fixture cases across Chinese, English, and empty-result intents", async () => {
    const cases = parseRetrievalCases(await readFile(casesPath, "utf8"));
    const chinese = cases.filter((item) => /[\u3400-\u9fff]/u.test(item.query));
    const english = cases.filter((item) => /[a-z]/iu.test(item.query) && !/[\u3400-\u9fff]/u.test(item.query));
    const empty = cases.filter((item) => item.expectEmpty);

    expect(cases).toHaveLength(100);
    expect(chinese).toHaveLength(40);
    expect(english).toHaveLength(60);
    expect(empty).toHaveLength(20);
    expect(cases.every((item) => item.project === "fixture-a")).toBe(true);
  });

  test("calculates ranking, citation, and empty-result metrics from executable result sets", async () => {
    const cases: RetrievalEvaluationCase[] = parseRetrievalCases([
      JSON.stringify({ id: "found", query: "add", project: "fixture-a", expectedTitles: ["add"], expectedPaths: ["src/math.ts"] }),
      JSON.stringify({ id: "empty", query: "missing", project: "fixture-a", expectEmpty: true })
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
});
