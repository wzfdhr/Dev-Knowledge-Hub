import { describe, expect, test } from "vitest";

import { calculateTrustScore } from "./trust";

describe("calculateTrustScore", () => {
  test("penalizes warnings and missing citations without allowing an error to look trustworthy", () => {
    expect(calculateTrustScore({ targetKind: "knowledge", targetId: "page-1", hasCitations: true, parserScore: 1, freshnessScore: 1, lintSeverities: [] }).score).toBe(1);
    const score = calculateTrustScore({ targetKind: "knowledge", targetId: "page-2", hasCitations: false, parserScore: 1, freshnessScore: 1, lintSeverities: ["warning", "error"] });
    expect(score.score).toBeLessThan(0.6);
    expect(score.reasons).toEqual(expect.arrayContaining(["missing_citations", "lint_error"]));
  });
});
