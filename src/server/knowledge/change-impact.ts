import type { KnowledgeMetadata, SnapshotChangeSummary } from "../persistence/store.js";

export function deriveChangeImpact(
  change: SnapshotChangeSummary,
  metadata: KnowledgeMetadata
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
  return {
    ...change,
    affectedModules: [...affectedModules].sort(),
    suggestedTests: [...suggestedTests].sort()
  };
}
