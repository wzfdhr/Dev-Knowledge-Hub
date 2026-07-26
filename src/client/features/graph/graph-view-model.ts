import type { KnowledgeGraph, KnowledgeGraphEdge, KnowledgeGraphNode } from "../../api/types";

const DEFAULT_NODE_LIMIT = 160;
const NODE_WIDTH = 184;
const NODE_HEIGHT = 48;
const NODE_GAP_X = 248;
const NODE_GAP_Y = 76;
const PADDING = 40;
const MIN_READABLE_ZOOM = 0.75;

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

export interface GraphViewportSize {
  width: number;
  height: number;
}

export type GraphViewportMode = "readable" | "overview";

export interface GraphViewport {
  zoom: number;
}

export function graphViewport(
  layout: Pick<GraphLayout, "width" | "height">,
  viewport: GraphViewportSize,
  mode: GraphViewportMode
): GraphViewport {
  const fit = Math.min(viewport.width / layout.width, viewport.height / layout.height);
  return { zoom: mode === "overview" ? fit : Math.min(1, Math.max(MIN_READABLE_ZOOM, fit)) };
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

function edgePath(from: PositionedGraphNode, to: PositionedGraphNode): string {
  const fromX = from.x + from.width;
  const fromY = from.y + from.height / 2;
  const toX = to.x;
  const toY = to.y + to.height / 2;
  const control = Math.max(48, Math.abs(toX - fromX) / 2);
  return `M ${fromX} ${fromY} C ${fromX + control} ${fromY}, ${toX - control} ${toY}, ${toX} ${toY}`;
}

export function layoutGraph(graph: FilteredGraph): GraphLayout {
  const ordered = [...graph.nodes].sort(compareNodes);
  const byId = new Map(ordered.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  const indegree = new Map(ordered.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    if (edge.candidate || !byId.has(edge.fromNodeId) || !byId.has(edge.toNodeId)) continue;
    outgoing.set(edge.fromNodeId, [...(outgoing.get(edge.fromNodeId) ?? []), edge.toNodeId]);
    indegree.set(edge.toNodeId, (indegree.get(edge.toNodeId) ?? 0) + 1);
  }
  const rank = new Map<string, number>();
  const queue = ordered.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]!;
    const nextRank = rank.get(id) ?? 0;
    for (const target of outgoing.get(id) ?? []) {
      rank.set(target, Math.max(rank.get(target) ?? 0, nextRank + 1));
      indegree.set(target, (indegree.get(target) ?? 1) - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
  }
  let trailingRank = Math.max(0, ...rank.values()) + 1;
  for (const node of ordered) if (!rank.has(node.id) && !queue.includes(node.id)) rank.set(node.id, trailingRank++);
  const rows = new Map<number, number>();
  const nodes = ordered.map((node) => {
    const layer = rank.get(node.id) ?? 0;
    const row = rows.get(layer) ?? 0;
    rows.set(layer, row + 1);
    return { ...node, x: PADDING + layer * NODE_GAP_X, y: PADDING + row * NODE_GAP_Y, width: NODE_WIDTH, height: NODE_HEIGHT };
  });
  const positionedById = new Map(nodes.map((node) => [node.id, node]));
  const edges = [...graph.edges].sort((left, right) => left.id.localeCompare(right.id)).flatMap((edge) => {
    const from = positionedById.get(edge.fromNodeId);
    const to = positionedById.get(edge.toNodeId);
    return from && to ? [{ ...edge, path: edgePath(from, to) }] : [];
  });
  const maxX = Math.max(PADDING + NODE_WIDTH, ...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(PADDING + NODE_HEIGHT, ...nodes.map((node) => node.y + node.height));

  return { nodes, edges, width: maxX + PADDING, height: maxY + PADDING };
}
