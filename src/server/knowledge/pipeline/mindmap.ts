import type { GraphEdge, GraphNode } from "../../../shared/api-contracts.js";

export interface ImpactMindmapNode {
  id: string;
  path: string;
  kind: GraphNode["kind"];
  changed: boolean;
  children: ImpactMindmapNode[];
}

export interface ImpactMindmap {
  roots: ImpactMindmapNode[];
  crossLinks: GraphEdge[];
  affectedModulePaths: string[];
  deletedPaths: string[];
}

function sorted<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}

function pathFor(node: GraphNode): string {
  return node.sourceRefs[0]?.path ?? node.qualifiedName;
}

export function buildImpactMindmap({
  changedPaths,
  graph
}: {
  changedPaths: readonly string[];
  graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };
}): ImpactMindmap {
  const changed = new Set(changedPaths);
  const nodes = new Map(graph.nodes.filter((node) => !node.candidate).map((node) => [node.id, node]));
  const edges = sorted(graph.edges.filter((edge) => !edge.candidate
    && nodes.has(edge.fromNodeId) && nodes.has(edge.toNodeId)));
  const changedIds = new Set([...nodes.values()]
    .filter((node) => node.sourceRefs.some((sourceRef) => changed.has(sourceRef.path)))
    .map((node) => node.id));
  const impacted = new Set(changedIds);
  for (const edge of edges) {
    if (edge.kind !== "imports" && edge.kind !== "depends_on") continue;
    if (changedIds.has(edge.fromNodeId)) impacted.add(edge.toNodeId);
    if (changedIds.has(edge.toNodeId)) impacted.add(edge.fromNodeId);
  }

  const parentEdges = edges.filter((edge) => edge.kind === "contains");
  const selected = new Set(impacted);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const edge of parentEdges) {
      if (selected.has(edge.toNodeId) && !selected.has(edge.fromNodeId)) {
        selected.add(edge.fromNodeId);
        expanded = true;
      }
    }
  }

  const selectedNodes = new Map([...selected].map((id) => [id, nodes.get(id)!]));
  const contains = parentEdges.filter((edge) => selectedNodes.has(edge.fromNodeId) && selectedNodes.has(edge.toNodeId));
  const children = new Map<string, GraphEdge[]>();
  const incoming = new Set<string>();
  for (const edge of contains) {
    children.set(edge.fromNodeId, [...(children.get(edge.fromNodeId) ?? []), edge]);
    incoming.add(edge.toNodeId);
  }
  const crossLinks: GraphEdge[] = edges.filter((edge) => edge.kind !== "contains"
    && selectedNodes.has(edge.fromNodeId) && selectedNodes.has(edge.toNodeId));
  const crossIds = new Set(crossLinks.map((edge) => edge.id));
  const visited = new Set<string>();
  const walk = (id: string, ancestry: ReadonlySet<string>): ImpactMindmapNode => {
    const node = selectedNodes.get(id)!;
    visited.add(id);
    const nextAncestry = new Set(ancestry).add(id);
    const result: ImpactMindmapNode = {
      id: node.id,
      path: pathFor(node),
      kind: node.kind,
      changed: changedIds.has(node.id),
      children: []
    };
    for (const edge of sorted(children.get(id) ?? [])) {
      if (nextAncestry.has(edge.toNodeId) || visited.has(edge.toNodeId)) {
        if (!crossIds.has(edge.id)) {
          crossLinks.push(edge);
          crossIds.add(edge.id);
        }
        continue;
      }
      result.children.push(walk(edge.toNodeId, nextAncestry));
    }
    return result;
  };
  const roots = [...selectedNodes.values()].filter((node) => !incoming.has(node.id));
  const rootCandidates = roots.length ? sorted(roots) : sorted([...selectedNodes.values()]);
  const treeRoots: ImpactMindmapNode[] = [];
  for (const node of rootCandidates) {
    if (!visited.has(node.id)) treeRoots.push(walk(node.id, new Set()));
  }
  for (const node of sorted([...selectedNodes.values()])) {
    if (!visited.has(node.id)) treeRoots.push(walk(node.id, new Set()));
  }
  const representedPaths = new Set([...nodes.values()]
    .filter((node) => node.sourceRefs.some((sourceRef) => changed.has(sourceRef.path)))
    .flatMap((node) => node.sourceRefs.map((sourceRef) => sourceRef.path)));

  return {
    roots: treeRoots,
    crossLinks: sorted(crossLinks),
    affectedModulePaths: [...impacted].map((id) => selectedNodes.get(id)!)
      .filter((node) => node.kind === "module").map(pathFor).sort((left, right) => left.localeCompare(right)),
    deletedPaths: [...changed].filter((path) => !representedPaths.has(path)).sort((left, right) => left.localeCompare(right))
  };
}
