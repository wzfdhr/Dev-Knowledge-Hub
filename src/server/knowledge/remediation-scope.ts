import type { KnowledgeGraphRecord } from "../persistence/store.js";
import type { SourceRef } from "../../shared/api-contracts.js";

export function deriveRemediationScope({
  sourceRefs,
  graph
}: {
  sourceRefs: readonly SourceRef[];
  graph: KnowledgeGraphRecord | null;
}): string[] {
  const paths = new Set(sourceRefs.map((reference) => reference.path));
  if (!graph) return [...paths].sort();

  const reverseEdges = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.candidate) continue;
    const dependents = reverseEdges.get(edge.toNodeId) ?? [];
    dependents.push(edge.fromNodeId);
    reverseEdges.set(edge.toNodeId, dependents);
  }
  const queue = graph.nodes
    .filter((node) => node.sourceRefs.some((reference) => paths.has(reference.path)))
    .map((node) => node.id);
  const visited = new Set<string>();
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  while (queue.length) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = nodes.get(nodeId);
    for (const reference of node?.sourceRefs ?? []) paths.add(reference.path);
    for (const dependentId of reverseEdges.get(nodeId) ?? []) queue.push(dependentId);
  }
  return [...paths].sort();
}
