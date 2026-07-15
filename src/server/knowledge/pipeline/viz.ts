import type { GraphEdge, GraphNode } from "../../../shared/api-contracts.js";

export interface GraphTreeNode {
  id: string;
  name: string;
  kind: GraphNode["kind"];
  candidate: boolean;
  children: GraphTreeNode[];
}

export interface GraphCrossLink extends GraphEdge {
  cycle: boolean;
}

export interface KnowledgeGraphExport {
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  tree: { roots: GraphTreeNode[]; crossLinks: GraphCrossLink[] };
  mermaid: string;
  markmap: string;
}

function nodeLabel(node: GraphNode): string {
  return [...node.name].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? " " : character;
  }).join("");
}

function mermaidId(id: string): string {
  return `n_${id.slice(0, 16)}`;
}

function html(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function graphTree(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): KnowledgeGraphExport["tree"] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const contains = edges.filter((edge) => edge.kind === "contains" && !edge.candidate
    && byId.has(edge.fromNodeId) && byId.has(edge.toNodeId))
    .sort((left, right) => left.id.localeCompare(right.id));
  const children = new Map<string, GraphEdge[]>();
  const incoming = new Set<string>();
  for (const item of contains) {
    children.set(item.fromNodeId, [...(children.get(item.fromNodeId) ?? []), item]);
    incoming.add(item.toNodeId);
  }
  const crossLinks: GraphCrossLink[] = edges.filter((edge) => edge.kind !== "contains" || edge.candidate)
    .sort((left, right) => left.id.localeCompare(right.id)).map((edge) => ({ ...edge, cycle: false }));
  const visited = new Set<string>();
  const crossLinkIds = new Set(crossLinks.map((edge) => edge.id));
  const visit = (nodeId: string, ancestry: ReadonlySet<string>): GraphTreeNode => {
    const node = byId.get(nodeId)!;
    visited.add(nodeId);
    const nextAncestry = new Set(ancestry).add(nodeId);
    const treeNode: GraphTreeNode = { id: node.id, name: nodeLabel(node), kind: node.kind, candidate: node.candidate, children: [] };
    for (const item of children.get(nodeId) ?? []) {
      const cycle = nextAncestry.has(item.toNodeId);
      if (cycle || visited.has(item.toNodeId)) {
        if (!crossLinkIds.has(item.id)) {
          crossLinks.push({ ...item, cycle });
          crossLinkIds.add(item.id);
        }
        continue;
      }
      treeNode.children.push(visit(item.toNodeId, nextAncestry));
    }
    return treeNode;
  };
  const roots = nodes.filter((node) => !incoming.has(node.id)).sort((left, right) => left.id.localeCompare(right.id));
  const orderedRoots = roots.length ? roots : [...nodes].sort((left, right) => left.id.localeCompare(right.id));
  const treeRoots: GraphTreeNode[] = [];
  for (const node of orderedRoots) {
    if (!visited.has(node.id)) treeRoots.push(visit(node.id, new Set()));
  }
  for (const node of [...nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!visited.has(node.id)) treeRoots.push(visit(node.id, new Set()));
  }
  return { roots: treeRoots, crossLinks: crossLinks.sort((left, right) => left.id.localeCompare(right.id)) };
}

function mermaid(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string {
  const lines = ["flowchart TD"];
  for (const node of [...nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    lines.push(`  ${mermaidId(node.id)}[${JSON.stringify(nodeLabel(node))}]`);
  }
  for (const edge of [...edges].sort((left, right) => left.id.localeCompare(right.id))) {
    const connector = edge.candidate ? "-.->" : "-->";
    lines.push(`  ${mermaidId(edge.fromNodeId)} ${connector}|${JSON.stringify(edge.kind)}| ${mermaidId(edge.toNodeId)}`);
  }
  return lines.join("\n");
}

function markmap(tree: KnowledgeGraphExport["tree"]): string {
  const lines = ["# Knowledge Graph"];
  const write = (node: GraphTreeNode, depth: number): void => {
    lines.push(`${"  ".repeat(depth)}- ${html(node.name)}`);
    node.children.forEach((child) => write(child, depth + 1));
  };
  tree.roots.forEach((node) => write(node, 0));
  return lines.join("\n");
}

export function exportKnowledgeGraph(graph: { nodes: GraphNode[]; edges: GraphEdge[] }): KnowledgeGraphExport {
  const tree = graphTree(graph.nodes, graph.edges);
  return { graph: structuredClone(graph), tree, mermaid: mermaid(graph.nodes, graph.edges), markmap: markmap(tree) };
}
