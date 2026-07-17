import type { KnowledgeGraph, KnowledgeGraphEdge, KnowledgeGraphNode } from "../../api/types";

const DEFAULT_NODE_LIMIT = 160;
const NODE_WIDTH = 184;
const NODE_HEIGHT = 48;
const NODE_GAP_X = 248;
const NODE_GAP_Y = 76;
const PADDING = 40;

const kindOrder: Record<KnowledgeGraphNode["kind"], number> = {
  module: 0,
  document: 1,
  table: 2,
  command: 3,
  symbol: 4,
  column: 5
};

export interface FilterGraphInput {
  graph: KnowledgeGraph;
  query: string;
  enabledKinds: ReadonlySet<KnowledgeGraphNode["kind"]>;
  includeCandidates: boolean;
  limit?: number;
}

export interface FilteredGraph {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  omittedNodeCount: number;
}

export interface PositionedGraphNode extends KnowledgeGraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PositionedGraphEdge = KnowledgeGraphEdge & { path: string };

export interface GraphLayout {
  nodes: PositionedGraphNode[];
  edges: PositionedGraphEdge[];
  width: number;
  height: number;
}

function compareNodes(left: KnowledgeGraphNode, right: KnowledgeGraphNode): number {
  return kindOrder[left.kind] - kindOrder[right.kind]
    || left.name.localeCompare(right.name, "zh-Hans-CN")
    || left.qualifiedName.localeCompare(right.qualifiedName, "zh-Hans-CN")
    || left.id.localeCompare(right.id);
}

function matchesQuery(node: KnowledgeGraphNode, query: string): boolean {
  const searchable = [node.name, node.qualifiedName, ...Object.values(node.attributes).map(String)].join(" ").toLocaleLowerCase();
  return searchable.includes(query);
}

function visibleEdges(edges: readonly KnowledgeGraphEdge[], visibleNodeIds: ReadonlySet<string>, includeCandidates: boolean): KnowledgeGraphEdge[] {
  return edges.filter((edge) => (includeCandidates || !edge.candidate)
    && visibleNodeIds.has(edge.fromNodeId)
    && visibleNodeIds.has(edge.toNodeId))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function filterGraph({ graph, query, enabledKinds, includeCandidates, limit = DEFAULT_NODE_LIMIT }: FilterGraphInput): FilteredGraph {
  const availableNodes = graph.nodes.filter((node) => enabledKinds.has(node.kind)).sort(compareNodes);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingNodes = normalizedQuery
    ? availableNodes.filter((node) => matchesQuery(node, normalizedQuery))
    : availableNodes;
  const matchingIds = new Set(matchingNodes.map((node) => node.id));
  const contextIds = new Set<string>();

  if (normalizedQuery) {
    for (const edge of graph.edges) {
      if (edge.candidate || !matchingIds.has(edge.fromNodeId) && !matchingIds.has(edge.toNodeId)) continue;
      contextIds.add(edge.fromNodeId);
      contextIds.add(edge.toNodeId);
    }
  }

  const contextNodes = availableNodes.filter((node) => !matchingIds.has(node.id) && contextIds.has(node.id));
  const fillNodes = availableNodes.filter((node) => !matchingIds.has(node.id) && !contextIds.has(node.id));
  const selectedNodes = normalizedQuery && matchingNodes.length === 0
    ? []
    : [...matchingNodes, ...contextNodes, ...fillNodes];
  const nodes = selectedNodes.slice(0, Math.max(1, limit));
  const visibleNodeIds = new Set(nodes.map((node) => node.id));

  return {
    nodes,
    edges: visibleEdges(graph.edges, visibleNodeIds, includeCandidates),
    omittedNodeCount: Math.max(0, selectedNodes.length - nodes.length)
  };
}

export function describeGraphReduction(graph: FilteredGraph): string | null {
  return graph.omittedNodeCount > 0
    ? `当前视图显示 ${graph.nodes.length} 个节点，另有 ${graph.omittedNodeCount} 个节点未显示。请用筛选或搜索缩小范围。`
    : null;
}

function parentModuleIds(graph: FilteredGraph): Map<string, string> {
  const modules = new Set(graph.nodes.filter((node) => node.kind === "module").map((node) => node.id));
  const parents = new Map<string, string>();
  for (const edge of [...graph.edges].sort((left, right) => left.id.localeCompare(right.id))) {
    if (edge.kind === "contains" && !edge.candidate && modules.has(edge.fromNodeId)) parents.set(edge.toNodeId, edge.fromNodeId);
  }
  return parents;
}

function edgePath(from: PositionedGraphNode, to: PositionedGraphNode): string {
  const fromX = from.x + from.width;
  const fromY = from.y + from.height / 2;
  const toX = to.x;
  const toY = to.y + to.height / 2;
  const control = Math.max(48, Math.abs(toX - fromX) / 2);
  return `M ${fromX} ${fromY} C ${fromX + control} ${fromY}, ${toX - control} ${toY}, ${toX} ${toY}`;
}

export function layoutGraph(graph: FilteredGraph): GraphLayout {
  const modules = graph.nodes.filter((node) => node.kind === "module").sort(compareNodes);
  const moduleIndex = new Map(modules.map((node, index) => [node.id, index]));
  const parents = parentModuleIds(graph);
  const childCounts = new Map<string, number>();
  const ungrouped = graph.nodes.filter((node) => node.kind !== "module" && !parents.has(node.id)).sort(compareNodes);
  const positionedModules: PositionedGraphNode[] = modules.map((node, index) => ({
    ...node, x: PADDING + index * NODE_GAP_X, y: PADDING, width: NODE_WIDTH, height: NODE_HEIGHT
  }));
  const positionedChildren = graph.nodes.filter((node) => node.kind !== "module" && parents.has(node.id)).sort(compareNodes).map((node) => {
    const parentId = parents.get(node.id)!;
    const index = childCounts.get(parentId) ?? 0;
    childCounts.set(parentId, index + 1);
    return {
      ...node,
      x: PADDING + (moduleIndex.get(parentId) ?? modules.length) * NODE_GAP_X,
      y: PADDING + NODE_GAP_Y + index * NODE_GAP_Y,
      width: NODE_WIDTH,
      height: NODE_HEIGHT
    };
  });
  const positionedUngrouped = ungrouped.map((node, index) => ({
    ...node,
    x: PADDING + (modules.length + Math.floor(index / 4)) * NODE_GAP_X,
    y: PADDING + (index % 4) * NODE_GAP_Y,
    width: NODE_WIDTH,
    height: NODE_HEIGHT
  }));
  const nodes = [...positionedModules, ...positionedChildren, ...positionedUngrouped];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = [...graph.edges].sort((left, right) => left.id.localeCompare(right.id)).flatMap((edge) => {
    const from = byId.get(edge.fromNodeId);
    const to = byId.get(edge.toNodeId);
    return from && to ? [{ ...edge, path: edgePath(from, to) }] : [];
  });
  const maxX = Math.max(PADDING + NODE_WIDTH, ...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(PADDING + NODE_HEIGHT, ...nodes.map((node) => node.y + node.height));

  return { nodes, edges, width: maxX + PADDING, height: maxY + PADDING };
}
