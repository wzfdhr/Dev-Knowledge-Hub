import type { BuildRecord } from "../build-service.js";
import type { PipelineArtifactStore, PipelineStageRunRecord } from "../../persistence/store.js";
import type { BuildStage } from "./contracts.js";

export interface PipelineStageJob {
  workspaceId: string;
  projectId: string;
  snapshotId: string;
  buildId: string;
  stages: readonly BuildStage[];
  stageIndex: number;
  inputDigest: string;
}

export interface PipelineStageJobQueue {
  send(job: PipelineStageJob): Promise<void>;
  start(handler: (job: PipelineStageJob) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

export interface PipelineStageExecutionResult {
  outputManifestIds?: string[];
  reused?: boolean;
}

export type PipelineStageExecutor = (
  run: PipelineStageRunRecord,
  job: PipelineStageJob
) => Promise<PipelineStageExecutionResult>;

type PipelineWorkerStore = PipelineArtifactStore & {
  getBuild(workspaceId: string, buildId: string): Promise<BuildRecord | null>;
};

export class PipelineStageWorker {
  constructor(
    private readonly store: PipelineWorkerStore,
    private readonly queue: PipelineStageJobQueue,
    private readonly execute: PipelineStageExecutor
  ) {}

  async start(): Promise<void> {
    await this.queue.start((job) => this.process(job));
  }

  stop(): Promise<void> {
    return this.queue.stop();
  }

  async schedule(job: PipelineStageJob): Promise<void> {
    const stage = job.stages[job.stageIndex];
    if (!stage) return;
    await this.store.createStageRun({
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      snapshotId: job.snapshotId,
      buildId: job.buildId,
      stage,
      attempt: 1,
      inputDigest: job.inputDigest
    });
    await this.queue.send(job);
  }

  async process(job: PipelineStageJob): Promise<void> {
    const stage = job.stages[job.stageIndex];
    if (!stage) return;
    const run = await this.store.claimNextStageRun(job.workspaceId, job.projectId, {
      buildId: job.buildId,
      stage
    });
    if (!run) return;
    const build = await this.store.getBuild(job.workspaceId, job.buildId);
    if (build && !build.cancelRequested) {
      try {
        const result = await this.execute(run, job);
        const completed = await this.store.transitionStageRun(
          job.workspaceId,
          job.projectId,
          run.id,
          "running",
          result.reused ? "reused" : "succeeded",
          { outputManifestIds: result.outputManifestIds }
        );
        if (!completed) return;
        const nextStageIndex = job.stageIndex + 1;
        if (job.stages[nextStageIndex]) {
          await this.schedule({ ...job, stageIndex: nextStageIndex });
        }
        return;
      } catch (error) {
        await this.store.transitionStageRun(
          job.workspaceId, job.projectId, run.id, "running", "failed", {
            errorCode: "PIPELINE_STAGE_FAILED",
            errorDetail: error instanceof Error ? error.message.slice(0, 4_000) : "Pipeline stage failed"
          }
        );
        return;
      }
    }
    await this.store.transitionStageRun(
      job.workspaceId, job.projectId, run.id, "running", "cancelled"
    );
  }
}
