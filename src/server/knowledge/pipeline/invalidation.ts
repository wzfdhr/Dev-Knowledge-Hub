import type { BuildStage } from "./contracts.js";

export interface SnapshotInvalidationInput {
  added: readonly string[];
  modified: readonly string[];
  deleted: readonly string[];
  affectedModules: readonly string[];
  suggestedTests: readonly string[];
}

export interface InvalidationPlan {
  rebuildStages: ReadonlyMap<string, readonly BuildStage[]>;
  stages: readonly BuildStage[];
  affectedModules: readonly string[];
  suggestedTests: readonly string[];
}

const standardStages: readonly BuildStage[] = [
  "convert", "extract", "graph", "synthesize", "index", "lint", "viz", "validate", "package"
];

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isTable(path: string): boolean {
  return /\.(?:csv|xlsx)$/i.test(path);
}

export function planInvalidation(input: SnapshotInvalidationInput): InvalidationPlan {
  const changedPaths = stableUnique([...input.added, ...input.modified, ...input.deleted]);
  const rebuildStages = new Map<string, readonly BuildStage[]>();
  for (const path of changedPaths) {
    const stages = isTable(path)
      ? (["convert", "extract", "tables", "graph", "synthesize", "index", "lint", "viz", "validate", "package"] as const)
      : standardStages;
    rebuildStages.set(path, stages);
  }
  const stages = stableUnique([...rebuildStages.values()].flat()) as BuildStage[];
  return {
    rebuildStages,
    stages,
    affectedModules: stableUnique(input.affectedModules),
    suggestedTests: stableUnique(input.suggestedTests)
  };
}
