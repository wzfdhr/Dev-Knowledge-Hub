import type { TrustScore } from "../../shared/api-contracts.js";

export function calculateTrustScore({ targetKind, targetId, hasCitations, parserScore, freshnessScore, lintSeverities }: {
  targetKind: TrustScore["targetKind"];
  targetId: string;
  hasCitations: boolean;
  parserScore: number;
  freshnessScore: number;
  lintSeverities: Array<"error" | "warning" | "info">;
}): TrustScore {
  const citationScore = hasCitations ? 1 : 0;
  const lintPenalty = lintSeverities.includes("error") ? 0.6 : lintSeverities.includes("warning") ? 0.2 : 0;
  const score = Math.max(0, Math.min(1, (citationScore * 0.4) + (parserScore * 0.3) + (freshnessScore * 0.3) - lintPenalty));
  const reasons = [!hasCitations ? "missing_citations" : "cited", lintSeverities.includes("error") ? "lint_error" : lintSeverities.includes("warning") ? "lint_warning" : "no_lint_penalty"];
  return { targetKind, targetId, score, citationScore, parserScore, freshnessScore, lintPenalty, reasons };
}
