import type { BuildRecord } from "../build-service.js";
import { knowledgeIrPipelineInputDigest } from "./extract-stage.js";
import { knowledgeGraphPipelineInputDigest } from "./graph-stage.js";
import { pipelineSearchIndexInputDigest } from "./index-stage.js";
import { pipelineKnowledgeQualityInputDigest } from "./quality-stage.js";
import { knowledgeVisualizationPipelineInputDigest } from "./viz-stage.js";
import { knowledgeValidationPipelineInputDigest } from "./validate-stage.js";
import { knowledgePackagePipelineInputDigest } from "./package-stage.js";
import { knowledgeSynthesisPipelineInputDigest } from "./synthesize-stage.js";
import { tableSchemasPipelineInputDigest } from "./tables-stage.js";
import type { PipelineStageInputPlanner } from "./worker.js";
import type { PipelineArtifactStore, PipelineStageRunRecord, SourceSnapshotRecord } from "../../persistence/store.js";

type B02StagePlannerStore = PipelineArtifactStore & {
  findSnapshotById(workspaceId: string, snapshotId: string): Promise<SourceSnapshotRecord | null>;
  listPipelineStageRuns(workspaceId: string, projectId: string, buildId: string): Promise<PipelineStageRunRecord[]>;
};

function latestOutputManifestIds(
  runs: readonly PipelineStageRunRecord[],
  stage: PipelineStageRunRecord["stage"],
  currentRun: PipelineStageRunRecord,
  currentOutputManifestIds: readonly string[]
): string[] {
  if (currentRun.stage === stage) return [...currentOutputManifestIds];
  const completed = runs.findLast((run) =>
    run.stage === stage && (run.status === "succeeded" || run.status === "reused")
  );
  if (!completed || completed.outputManifestIds.length === 0) {
    throw new Error(`Pipeline stage ${stage} requires a completed ${stage} artifact`);
  }
  return [...completed.outputManifestIds];
}

function assertSingleManifest(stage: string, manifestIds: readonly string[]): void {
  if (manifestIds.length !== 1 || new Set(manifestIds).size !== manifestIds.length) {
    throw new Error(`Pipeline stage ${stage} requires exactly one upstream manifest`);
  }
}

export function createB02StageInputPlanner(store: B02StagePlannerStore): PipelineStageInputPlanner {
  return {
    async nextInputDigest({ currentRun, build, nextStage, outputManifestIds }) {
      const snapshot = await store.findSnapshotById(currentRun.workspaceId, currentRun.snapshotId);
      if (!snapshot) throw new Error("Pipeline stage snapshot is unavailable");
      const runs = await store.listPipelineStageRuns(currentRun.workspaceId, currentRun.projectId, currentRun.buildId);
      return nextB02InputDigest({ snapshot, build, currentRun, nextStage, outputManifestIds, runs });
    }
  };
}

function nextB02InputDigest(input: {
  snapshot: SourceSnapshotRecord;
  build: BuildRecord;
  currentRun: PipelineStageRunRecord;
  nextStage: PipelineStageRunRecord["stage"];
  outputManifestIds: readonly string[];
  runs: readonly PipelineStageRunRecord[];
}): string {
  switch (input.nextStage) {
    case "extract": {
      const convertManifestIds = latestOutputManifestIds(
        input.runs, "convert", input.currentRun, input.outputManifestIds
      );
      assertSingleManifest("extract", convertManifestIds);
      return knowledgeIrPipelineInputDigest(input.snapshot, input.build.purpose, convertManifestIds);
    }
    case "tables": {
      const convertManifestIds = latestOutputManifestIds(
        input.runs, "convert", input.currentRun, input.outputManifestIds
      );
      assertSingleManifest("tables", convertManifestIds);
      return tableSchemasPipelineInputDigest(input.snapshot, input.build.purpose, convertManifestIds);
    }
    case "graph": {
      const extractManifestIds = latestOutputManifestIds(
        input.runs, "extract", input.currentRun, input.outputManifestIds
      );
      const tableManifestIds = latestOutputManifestIds(
        input.runs, "tables", input.currentRun, input.outputManifestIds
      );
      assertSingleManifest("graph", extractManifestIds);
      assertSingleManifest("graph", tableManifestIds);
      return knowledgeGraphPipelineInputDigest(
        input.snapshot,
        input.build.purpose,
        [...extractManifestIds, ...tableManifestIds]
      );
    }
    case "synthesize": {
      const graphManifestIds = latestOutputManifestIds(
        input.runs, "graph", input.currentRun, input.outputManifestIds
      );
      assertSingleManifest("synthesize", graphManifestIds);
      return knowledgeSynthesisPipelineInputDigest(input.snapshot, input.build.purpose, graphManifestIds);
    }
    case "index": {
      const synthesisManifestIds = latestOutputManifestIds(
        input.runs, "synthesize", input.currentRun, input.outputManifestIds
      );
      assertSingleManifest("index", synthesisManifestIds);
      return pipelineSearchIndexInputDigest(input.snapshot, input.build.purpose, synthesisManifestIds);
    }
    case "lint": {
      const extractManifestIds = latestOutputManifestIds(
        input.runs, "extract", input.currentRun, input.outputManifestIds
      );
      const tableManifestIds = latestOutputManifestIds(
        input.runs, "tables", input.currentRun, input.outputManifestIds
      );
      const synthesisManifestIds = latestOutputManifestIds(
        input.runs, "synthesize", input.currentRun, input.outputManifestIds
      );
      const indexManifestIds = latestOutputManifestIds(
        input.runs, "index", input.currentRun, input.outputManifestIds
      );
      for (const manifestIds of [extractManifestIds, tableManifestIds, synthesisManifestIds, indexManifestIds]) {
        assertSingleManifest("lint", manifestIds);
      }
      return pipelineKnowledgeQualityInputDigest(
        input.snapshot,
        input.build.purpose,
        [...extractManifestIds, ...tableManifestIds, ...synthesisManifestIds, ...indexManifestIds]
      );
    }
    case "viz": {
      const graphManifestIds = latestOutputManifestIds(
        input.runs, "graph", input.currentRun, input.outputManifestIds
      );
      assertSingleManifest("viz", graphManifestIds);
      return knowledgeVisualizationPipelineInputDigest(input.snapshot, input.build.purpose, graphManifestIds);
    }
    case "validate": {
      const synthesisManifestIds = latestOutputManifestIds(
        input.runs, "synthesize", input.currentRun, input.outputManifestIds
      );
      const indexManifestIds = latestOutputManifestIds(
        input.runs, "index", input.currentRun, input.outputManifestIds
      );
      const lintManifestIds = latestOutputManifestIds(
        input.runs, "lint", input.currentRun, input.outputManifestIds
      );
      const visualizationManifestIds = latestOutputManifestIds(
        input.runs, "viz", input.currentRun, input.outputManifestIds
      );
      for (const manifestIds of [synthesisManifestIds, indexManifestIds, lintManifestIds, visualizationManifestIds]) {
        assertSingleManifest("validate", manifestIds);
      }
      return knowledgeValidationPipelineInputDigest(
        input.snapshot,
        input.build.purpose,
        [...synthesisManifestIds, ...indexManifestIds, ...lintManifestIds, ...visualizationManifestIds]
      );
    }
    case "package": {
      const validationManifestIds = latestOutputManifestIds(
        input.runs, "validate", input.currentRun, input.outputManifestIds
      );
      assertSingleManifest("package", validationManifestIds);
      return knowledgePackagePipelineInputDigest(input.snapshot, input.build.purpose, validationManifestIds);
    }
    default:
      throw new Error(`No B02 input digest planner exists for ${input.nextStage}`);
  }
}
