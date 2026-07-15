import type { KnowledgeIR, LintIssue, TrustScore } from "../../shared/api-contracts.js";
import { buildKnowledgeGraph, type KnowledgeGraph } from "./pipeline/graph.js";
import { lintKnowledge } from "./lint.js";
import { calculateTrustScore } from "./trust.js";

export interface KnowledgeQualityAssessment {
  graph: KnowledgeGraph;
  issues: LintIssue[];
  trust: TrustScore;
}

export function assessKnowledgeQuality(input: {
  buildId: string;
  projectId: string;
  ir: KnowledgeIR;
  knowledgePageCount: number;
  extractionIssues: readonly LintIssue[];
}): KnowledgeQualityAssessment {
  const graph = buildKnowledgeGraph({ projectId: input.projectId, ir: input.ir });
  const issues = [...input.extractionIssues, ...lintKnowledge({
    buildId: input.buildId,
    graph,
    tables: input.ir.tables,
    knowledgePageCount: input.knowledgePageCount
  })].sort((left, right) => left.id.localeCompare(right.id));
  const trust = calculateTrustScore({
    targetKind: "knowledge",
    targetId: input.buildId,
    hasCitations: input.ir.sourceRefs.length > 0,
    parserScore: 1,
    freshnessScore: 1,
    lintSeverities: issues.map((issue) => issue.severity)
  });
  return { graph, issues, trust };
}
