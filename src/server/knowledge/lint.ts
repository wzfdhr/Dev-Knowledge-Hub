import { createHash } from "node:crypto";

import type { GraphEdge, GraphNode, LintIssue, TableSchema } from "../../shared/api-contracts.js";

function issue(input: Omit<LintIssue, "id" | "remediationState">): LintIssue {
  const id = createHash("sha256").update([input.buildId, input.rule, input.targetId].join("\u0000")).digest("hex");
  return { ...input, id, remediationState: "open" };
}

export function lintKnowledge({ buildId, graph, tables, knowledgePageCount }: {
  buildId: string;
  graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };
  tables: readonly TableSchema[];
  knowledgePageCount: number;
}): LintIssue[] {
  const nodes = new Set(graph.nodes.map((node) => node.id));
  const issues: LintIssue[] = [];
  for (const edge of graph.edges) {
    if (!edge.candidate && (!nodes.has(edge.fromNodeId) || !nodes.has(edge.toNodeId))) {
      issues.push(issue({ buildId, rule: "GRAPH_DANGLING_FACT_EDGE", severity: "error", targetKind: "graph", targetId: edge.id, message: "Fact graph edge has a missing endpoint", sourceRefs: edge.sourceRefs }));
    }
  }
  for (const table of tables) for (const column of table.columns) {
    if (column.sensitive) issues.push(issue({ buildId, rule: "TABLE_SENSITIVE_FIELD", severity: "warning", targetKind: "table", targetId: `${table.id}:${column.name}`, message: "Sensitive table field is excluded from generated prose", sourceRefs: column.sourceRefs }));
  }
  if (knowledgePageCount === 0) issues.push(issue({ buildId, rule: "KNOWLEDGE_LOW_COVERAGE", severity: "warning", targetKind: "knowledge", targetId: buildId, message: "No generated knowledge pages are available", sourceRefs: [] }));
  return issues.sort((left, right) => left.id.localeCompare(right.id));
}
