import { createHash } from "node:crypto";
import path from "node:path";

import type { GraphEdge, GraphNode, KnowledgeIR, SourceRef } from "../../../shared/api-contracts.js";

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function id(kind: string, value: string): string {
  return createHash("sha256").update(`${kind}:${value}`).digest("hex");
}

function edge(
  kind: GraphEdge["kind"],
  fromNodeId: string,
  toNodeId: string,
  sourceRefs: SourceRef[],
  candidateReason?: string
): GraphEdge {
  const candidate = candidateReason !== undefined;
  return {
    id: id("edge", `${kind}:${fromNodeId}:${toNodeId}:${candidateReason ?? "fact"}`),
    fromNodeId,
    toNodeId,
    kind,
    candidate,
    ...(candidate ? { candidateReason } : {}),
    confidence: candidate ? 0.5 : 1,
    sourceRefs
  };
}

function uniqueSourceRefs(sourceRefs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return sourceRefs.filter((sourceRef) => {
    const key = JSON.stringify(sourceRef);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeGraphItems<T extends GraphNode | GraphEdge>(items: T[]): T[] {
  const merged = new Map<string, T>();
  for (const item of items) {
    const previous = merged.get(item.id);
    if (!previous) {
      merged.set(item.id, item);
      continue;
    }
    merged.set(item.id, {
      ...previous,
      sourceRefs: uniqueSourceRefs([...previous.sourceRefs, ...item.sourceRefs])
    } as T);
  }
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function moduleNode(projectId: string, snapshotId: string, file: KnowledgeIR["files"][number]): GraphNode {
  return {
    id: id("module", file.path), projectId, snapshotId, kind: "module", name: path.posix.basename(file.path),
    qualifiedName: file.path, candidate: false, sourceRefs: [file.sourceRef], attributes: { language: file.language }
  };
}

function resolveRelativeImport(fromPath: string, specifier: string, paths: ReadonlySet<string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.vue`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.vue`];
  return candidates.find((candidate) => paths.has(candidate)) ?? null;
}

export function buildKnowledgeGraph({ projectId, ir }: { projectId: string; ir: KnowledgeIR }): KnowledgeGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const moduleIds = new Map<string, string>();
  for (const file of ir.files) {
    const node = moduleNode(projectId, ir.snapshotId, file);
    nodes.push(node);
    moduleIds.set(file.path, node.id);
  }
  for (const symbol of ir.symbols) {
    const node: GraphNode = {
      id: id("symbol", symbol.id), projectId, snapshotId: ir.snapshotId, kind: "symbol", name: symbol.name,
      qualifiedName: symbol.qualifiedName, candidate: false, sourceRefs: [symbol.sourceRef], attributes: { symbolKind: symbol.kind }
    };
    nodes.push(node);
    const owner = moduleIds.get(symbol.sourceRef.path);
    if (owner) edges.push(edge("contains", owner, node.id, [symbol.sourceRef]));
  }
  for (const document of ir.documents) {
    const node: GraphNode = {
      id: id("document", document.id), projectId, snapshotId: ir.snapshotId, kind: "document", name: document.title ?? document.sourceRef.path,
      qualifiedName: document.sourceRef.path, candidate: false, sourceRefs: [document.sourceRef], attributes: {}
    };
    nodes.push(node);
  }
  for (const table of ir.tables) {
    const tableNode: GraphNode = {
      id: id("table", table.id), projectId, snapshotId: ir.snapshotId, kind: "table", name: table.name,
      qualifiedName: table.sourcePath, candidate: table.candidate, sourceRefs: table.sourceRefs, attributes: { rowCount: table.rowCount }
    };
    nodes.push(tableNode);
    for (const column of table.columns) {
      const columnNode: GraphNode = {
        id: id("column", `${table.id}:${column.name}`), projectId, snapshotId: ir.snapshotId, kind: "column", name: column.name,
        qualifiedName: `${table.sourcePath}.${column.name}`, candidate: false, sourceRefs: column.sourceRefs,
        attributes: { type: column.type, sensitive: column.sensitive, formulaLike: column.formulaLike }
      };
      nodes.push(columnNode);
      edges.push(edge("contains", tableNode.id, columnNode.id, column.sourceRefs));
    }
  }
  for (const imported of ir.imports) {
    const fromNodeId = moduleIds.get(imported.fromPath);
    if (!fromNodeId) continue;
    const targetPath = resolveRelativeImport(imported.fromPath, imported.specifier, new Set(moduleIds.keys()));
    if (imported.kind === "static" && targetPath) {
      edges.push(edge("imports", fromNodeId, moduleIds.get(targetPath)!, [imported.sourceRef]));
      continue;
    }
    const reason = imported.kind === "dynamic" ? "dynamic_import" : "unresolved_import";
    edges.push(edge("imports", fromNodeId, id("unresolved_import", `${imported.fromPath}:${imported.specifier}`), [imported.sourceRef], reason));
  }
  const graph = { nodes: mergeGraphItems(nodes), edges: mergeGraphItems(edges) };
  validateKnowledgeGraph(graph);
  return graph;
}

export function validateKnowledgeGraph(graph: KnowledgeGraph): void {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  for (const node of graph.nodes) {
    if (!node.candidate && node.sourceRefs.length === 0) throw new Error("Graph fact node has no source references");
  }
  for (const item of graph.edges) {
    if (!item.candidate && item.sourceRefs.length === 0) throw new Error("Graph fact edge has no source references");
    if (!item.candidate && (!nodeIds.has(item.fromNodeId) || !nodeIds.has(item.toNodeId))) {
      throw new Error("Graph fact edge has a dangling node");
    }
    if (item.candidate && !item.candidateReason) throw new Error("Graph candidate edge has no reason");
  }
}
