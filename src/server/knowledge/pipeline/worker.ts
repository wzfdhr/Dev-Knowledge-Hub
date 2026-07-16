import type { BuildRecord } from "../build-service.js";
import type { PipelineArtifactStore, PipelineStageRunRecord } from "../../persistence/store.js";
import type { BuildStage } from "./contracts.js";

export interface PipelineStageSchedule {
  workspaceId: string;
  projectId: string;
  snapshotId: string;
  buildId: string;
  inputDigest: string;
}

export interface PipelineStageJob {
  stageRunId: string;
  buildId: string;
  projectId: string;
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

export type PipelineStageExecutor = (run: PipelineStageRunRecord) => Promise<PipelineStageExecutionResult>;

type PipelineWorkerStore = PipelineArtifactStore & {
  getBuild(workspaceId: string, buildId: string): Promise<BuildRecord | null>;
};

export class PipelineStageWorker {
  constructor(
    private readonly store: PipelineWorkerStore,
    private readonly queue: PipelineStageJobQueue,
    private readonly execute: PipelineStageExecutor,
    private readonly stages: readonly BuildStage[]
  ) {}

  async start(): Promise<void> {
    await this.queue.start((job) => this.process(job));
    await this.reconcileQueuedRuns();
  }

  private async reconcileQueuedRuns(): Promise<void> {
    for (const run of await this.store.listQueuedStageRuns()) {
      try {
        await this.queue.send({ stageRunId: run.id, buildId: run.buildId, projectId: run.projectId });
      } catch {
        // The durable queued row remains available for the next reconciliation pass.
      }
    }
  }

  stop(): Promise<void> {
    return this.queue.stop();
  }

  async schedule(job: PipelineStageSchedule): Promise<void> {
    const stage = this.stages[0];
    if (!stage) return;
    const run = await this.store.createStageRun({ ...job, stage, attempt: 1 });
    await this.queue.send({ stageRunId: run.id, buildId: run.buildId, projectId: run.projectId });
  }

  async process(job: PipelineStageJob): Promise<void> {
    const run = await this.store.claimStageRun(job.stageRunId, job.buildId, job.projectId);
    if (!run) return;
    const build = await this.store.getBuild(run.workspaceId, run.buildId);
    if (build && !build.cancelRequested) {
      try {
        const result = await this.execute(run);
        const nextStage = this.stages[this.stages.indexOf(run.stage) + 1];
        const advanced = await this.store.completeStageRunAndCreateNext({
          workspaceId: run.workspaceId,
          projectId: run.projectId,
          stageRunId: run.id,
          status: result.reused ? "reused" : "succeeded",
          outputManifestIds: result.outputManifestIds,
          ...(nextStage ? { next: {
            workspaceId: run.workspaceId,
            projectId: run.projectId,
            snapshotId: run.snapshotId,
            buildId: run.buildId,
            stage: nextStage,
            attempt: 1,
            inputDigest: run.inputDigest
          } } : {})
        });
        if (advanced?.next) {
          await this.queue.send({
            stageRunId: advanced.next.id,
            buildId: advanced.next.buildId,
            projectId: advanced.next.projectId
          });
        }
      } catch (error) {
        await this.store.transitionStageRun(
          run.workspaceId, run.projectId, run.id, "running", "failed", {
            errorCode: "PIPELINE_STAGE_FAILED",
            errorDetail: error instanceof Error ? error.message.slice(0, 4_000) : "Pipeline stage failed"
          }
        );
      }
      return;
    }
    await this.store.transitionStageRun(run.workspaceId, run.projectId, run.id, "running", "cancelled");
  }
}
