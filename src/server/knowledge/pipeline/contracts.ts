import {
  artifactManifestSchema,
  buildStageSchema,
  graphEdgeSchema,
  graphNodeSchema,
  knowledgeIrSchema,
  lintIssueSchema,
  stageRunSchema,
  tableSchemaSchema,
  trustScoreSchema,
  type ArtifactManifest,
  type BuildStage,
  type GraphEdge,
  type GraphNode,
  type KnowledgeIR,
  type LegacyBuildStatus,
  type LintIssue,
  type StageRun,
  type StageStatus,
  type TableSchema,
  type TrustScore
} from "../../../shared/api-contracts.js";
import { BUILD_STAGES } from "../../../shared/contracts.js";
import {
  frontendAnalyzerProvenanceSchema,
  frontendAnalyzerManifestEntrySchema,
  frontendAnalyzerManifestDigest,
  frontendEdgeSchema,
  frontendEntityIdentitySchema,
  frontendEntitySchema,
  frontendFacetPatchSchema,
  frontendIrSchema,
  type FrontendAnalyzerProvenance,
  type FrontendAnalyzerManifestEntry,
  type FrontendEdge,
  type FrontendEntity,
  type FrontendEntityIdentity,
  type FrontendFacetPatch,
  type FrontendIR
} from "../../../shared/frontend-ir.js";

export { BUILD_STAGES, artifactManifestSchema, buildStageSchema, frontendAnalyzerManifestDigest, frontendAnalyzerManifestEntrySchema, frontendAnalyzerProvenanceSchema, frontendEdgeSchema, frontendEntityIdentitySchema, frontendEntitySchema, frontendFacetPatchSchema, frontendIrSchema, graphEdgeSchema, graphNodeSchema, knowledgeIrSchema, lintIssueSchema, stageRunSchema, tableSchemaSchema, trustScoreSchema };
export type { ArtifactManifest, BuildStage, FrontendAnalyzerManifestEntry, FrontendAnalyzerProvenance, FrontendEdge, FrontendEntity, FrontendEntityIdentity, FrontendFacetPatch, FrontendIR, GraphEdge, GraphNode, KnowledgeIR, LegacyBuildStatus, LintIssue, StageRun, StageStatus, TableSchema, TrustScore };

const stageTransitions: Readonly<Record<StageStatus, readonly StageStatus[]>> = {
  queued: ["running", "cancelled", "reused", "skipped"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  reused: [],
  skipped: []
};

function stageIndex(stage: BuildStage): number {
  return BUILD_STAGES.indexOf(stage);
}

export function canTransitionStage(from: StageStatus, to: StageStatus): boolean {
  return stageTransitions[from].includes(to);
}

export function assertValidStageRuns(runs: readonly StageRun[]): void {
  const attempts = new Set<string>();
  let previousStage = -1;
  for (const run of runs) {
    const parsed = stageRunSchema.parse(run);
    const attemptKey = `${parsed.stage}:${parsed.attempt}`;
    if (attempts.has(attemptKey)) throw new Error(`Duplicate stage attempt: ${attemptKey}`);
    attempts.add(attemptKey);
    const currentStage = stageIndex(parsed.stage);
    if (currentStage < previousStage) throw new Error("Pipeline stages are out of order");
    previousStage = currentStage;
  }
}

function statusForActiveStage(stage: BuildStage): LegacyBuildStatus {
  switch (stage) {
    case "convert":
      return "syncing";
    case "extract":
    case "tables":
    case "graph":
      return "parsing";
    case "synthesize":
      return "synthesizing";
    case "index":
    case "lint":
    case "viz":
    case "validate":
    case "package":
      return "validating";
  }
}

export function legacyBuildStatus(
  runs: readonly StageRun[],
  options: { published?: boolean } = {}
): LegacyBuildStatus {
  assertValidStageRuns(runs);
  if (runs.length === 0) return "queued";
  if (runs.some((run) => run.status === "failed" || run.status === "cancelled")) return "failed";
  const active = [...runs].reverse().find((run) => run.status === "running" || run.status === "queued");
  if (active) {
    if (active.status === "queued" && runs.every((run) => run.status === "queued")) return "queued";
    return statusForActiveStage(active.stage);
  }
  const packageRun = [...runs].reverse().find((run) => run.stage === "package");
  if (!packageRun || !["succeeded", "reused", "skipped"].includes(packageRun.status)) return "validating";
  return options.published ? "published" : "ready";
}
