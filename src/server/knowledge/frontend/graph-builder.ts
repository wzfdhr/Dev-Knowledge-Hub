import { createHash } from "node:crypto";

import type { FrontendEdge, FrontendEntity, FrontendIR } from "../../../shared/frontend-ir.js";

export interface FrontendGraph {
  schemaVersion: 2;
  snapshotId: string;
  analyzerManifestDigest: string;
  nodes: FrontendEntity[];
  edges: FrontendEdge[];
}

function edgeId(kind: string, from: string, to: string, evidence: string): string {
  return createHash("sha256").update([kind, from, to, evidence].join("\0"), "utf8").digest("hex");
}

function unique<T>(items: T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

function derivedEdge(
  kind: FrontendEdge["kind"],
  from: FrontendEntity,
  to: FrontendEntity,
  evidenceClass: "fact" | "candidate",
  reason?: string
): FrontendEdge {
  const canonicalEvidenceKey = `frontend-graph:${kind}:${from.id}:${to.id}:${reason ?? "fact"}`;
  const base = { kind, fromEntityId: from.id, toEntityId: to.id, canonicalEvidenceKey };
  const sourceRefs = unique([...from.sourceRefs, ...to.sourceRefs], (item) => JSON.stringify(item));
  const provenance = unique([...from.provenance, ...to.provenance], (item) => JSON.stringify(item));
  return evidenceClass === "fact" ? {
    schemaVersion: 2,
    id: edgeId(kind, from.id, to.id, canonicalEvidenceKey),
    ...base,
    evidenceClass: "fact",
    confidence: 1,
    sourceRefs,
    provenance
  } : {
    schemaVersion: 2,
    id: edgeId(kind, from.id, to.id, canonicalEvidenceKey),
    ...base,
    evidenceClass: "candidate",
    candidateReason: reason ?? "inferred",
    confidence: 0.5,
    sourceRefs,
    provenance
  };
}

export function buildFrontendGraph(ir: FrontendIR): FrontendGraph {
  const edges = new Map(ir.edges.map((edge) => [edge.id, edge]));
  const components = ir.entities.filter((entity) => entity.kind === "component");
  const pages = ir.entities.filter((entity) => entity.kind === "page");
  const styles = ir.entities.filter((entity) => entity.kind === "style_scope");
  for (const page of pages) {
    const component = components.find((candidate) =>
      candidate.name === page.name && candidate.canonicalPath === page.canonicalPath && candidate.packageKey === page.packageKey
    );
    if (component) {
      const relation = derivedEdge("renders", page, component, "fact");
      edges.set(relation.id, relation);
    }
  }
  for (const component of components) {
    for (const style of styles.filter((candidate) => candidate.packageKey === component.packageKey)) {
      if (ir.edges.some((edge) => edge.kind === "styles" && edge.fromEntityId === component.id && edge.toEntityId === style.id)) continue;
      const relation = derivedEdge("styles", component, style, "candidate", "package_style_proximity");
      edges.set(relation.id, relation);
    }
  }
  return {
    schemaVersion: 2,
    snapshotId: ir.snapshotId,
    analyzerManifestDigest: ir.analyzerManifestDigest,
    nodes: [...ir.entities].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id))
  };
}
