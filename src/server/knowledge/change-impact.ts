import type { KnowledgeMetadata, SnapshotChangeSummary } from "../persistence/store.js";
import { buildImpactMindmap } from "./pipeline/mindmap.js";
import type { KnowledgeGraphRecord } from "../persistence/store.js";
import type { FrontendIR } from "../../shared/frontend-ir.js";
import { deriveFrontendChangeImpact } from "./frontend/change-impact.js";

export function deriveChangeImpact(
  change: SnapshotChangeSummary,
  metadata: KnowledgeMetadata,
  graph?: KnowledgeGraphRecord | null,
  frontendGraph?: FrontendIR | null
): SnapshotChangeSummary {
  const changedPaths = new Set([...change.added, ...change.modified, ...change.deleted]);
  const related = metadata.dependencies.filter((edge) =>
    changedPaths.has(edge.path) || (edge.targetPath !== null && changedPaths.has(edge.targetPath))
  );
  const affectedModules = new Set<string>();
  const suggestedTests = new Set<string>();
  for (const edge of related) {
    affectedModules.add(edge.path);
    if (edge.targetPath) affectedModules.add(edge.targetPath);
    if (edge.kind === "test-of" && edge.targetPath && changedPaths.has(edge.targetPath)) {
      suggestedTests.add(edge.path);
    }
  }
  const impact = graph ? buildImpactMindmap({ changedPaths: [...changedPaths], graph }) : undefined;
  for (const path of impact?.affectedModulePaths ?? []) affectedModules.add(path);
  if (frontendGraph) {
    const frontendImpact = deriveFrontendChangeImpact({ changedPaths: [...changedPaths], graph: frontendGraph });
    for (const path of frontendImpact.affectedPaths) affectedModules.add(path);
    for (const path of frontendImpact.suggestedTestPaths) suggestedTests.add(path);
  }
  return {
    ...change,
    affectedModules: [...affectedModules].sort(),
    suggestedTests: [...suggestedTests].sort(),
    ...(impact ? { impact } : {})
  };
}
