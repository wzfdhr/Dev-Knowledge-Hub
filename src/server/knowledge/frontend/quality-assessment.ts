import type { FrontendIR } from "../../../shared/frontend-ir.js";
import { lintFrontendIr } from "./frontend-static-lint.js";

export function assessFrontendKnowledgeQuality(ir: FrontendIR) {
  const testedComponents = new Set(ir.edges.filter((edge) => edge.kind === "tests").map((edge) => edge.toEntityId));
  return {
    schemaVersion: 2 as const,
    snapshotId: ir.snapshotId,
    summary: {
      entities: ir.entities.length,
      factEdges: ir.edges.filter((edge) => edge.evidenceClass === "fact").length,
      candidateEdges: ir.edges.filter((edge) => edge.evidenceClass === "candidate").length,
      citedEntities: ir.entities.filter((entity) => entity.sourceRefs.length > 0).length,
      components: ir.entities.filter((entity) => entity.kind === "component").length,
      testedComponents: testedComponents.size,
      routes: ir.entities.filter((entity) => entity.kind === "route").length,
      visualizations: ir.entities.filter((entity) => entity.kind === "visualization").length
    },
    issues: lintFrontendIr(ir)
  };
}
