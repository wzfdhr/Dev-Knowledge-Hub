import type { BuildRecord } from "../build-service.js";
import type { PipelineArtifactStore, PipelineStageRunRecord } from "../../persistence/store.js";
import type { BuildStage } from "./contracts.js";
import { pipelineInputDigest } from "./input-digest.js";

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
  send(job: PipelineStageJob, options?: { delayMs?: number }): Promise<void>;
  start(handler: (job: PipelineStageJob) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

export interface PipelineStageExecutionResult {
  outputManifestIds?: string[];
  reused?: boolean;
}

export type PipelineStageExecutor = (run: PipelineStageRunRecord) => Promise<PipelineStageExecutionResult>;

export interface PipelineStageInputPlanner {
  nextInputDigest(input: {
    currentRun: PipelineStageRunRecord;
    build: BuildRecord;
    nextStage: BuildStage;
    outputManifestIds: readonly string[];
  }): Promise<string>;
}

type PipelineWorkerStore = PipelineArtifactStore & {
  getBuild(workspaceId: string, buildId: string): Promise<BuildRecord | null>;
};

const RETRYABLE_STAGES = new Set<BuildStage>(["convert", "graph", "index", "package"]);
const MAX_STAGE_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [5_000, 30_000] as const;

function shouldRetry(run: PipelineStageRunRecord): boolean {
  return RETRYABLE_STAGES.has(run.stage) && run.attempt < MAX_STAGE_ATTEMPTS;
}

function retryDelayMs(run: PipelineStageRunRecord): number {
  return RETRY_DELAYS_MS[run.attempt - 1] ?? RETRY_DELAYS_MS.at(-1)!;
}

export class PipelineStageWorker {
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: PipelineWorkerStore,
    private readonly queue: PipelineStageJobQueue,
    private readonly execute: PipelineStageExecutor,
    private readonly stages: readonly BuildStage[],
    private readonly reconcileIntervalMs = 5_000,
    private readonly inputPlanner?: PipelineStageInputPlanner
  ) {}

  async start(): Promise<void> {
    await this.queue.start((job) => this.process(job));
    await this.reconcileQueuedRuns();
    this.reconcileTimer = setInterval(() => {
      void this.reconcileQueuedRuns();
    }, this.reconcileIntervalMs);
    this.reconcileTimer.unref?.();
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
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
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
        const outputManifestIds = result.outputManifestIds ?? [];
        const defaultNextInputDigest = nextStage ? pipelineInputDigest({
          stage: nextStage,
          snapshotId: run.snapshotId,
          upstreamManifestIds: outputManifestIds,
          parserConfigVersion: "pipeline-v1",
          purpose: {
            kind: build.purpose.kind,
            feedbackIds: build.purpose.feedbackIds,
            remediationIds: build.purpose.remediationContext?.map((context) => context.remediationId) ?? []
          }
        }) : undefined;
        const nextInputDigest = nextStage
          ? await this.inputPlanner?.nextInputDigest({
            currentRun: run,
            build,
            nextStage,
            outputManifestIds
          }) ?? defaultNextInputDigest
          : undefined;
        const advanced = await this.store.completeStageRunAndCreateNext({
          workspaceId: run.workspaceId,
          projectId: run.projectId,
          stageRunId: run.id,
          status: result.reused ? "reused" : "succeeded",
          outputManifestIds,
          ...(nextStage ? { next: {
            workspaceId: run.workspaceId,
            projectId: run.projectId,
            snapshotId: run.snapshotId,
            buildId: run.buildId,
            stage: nextStage,
            attempt: 1,
            inputDigest: nextInputDigest!
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
        const failed = await this.store.failStageRunAndCreateRetry({
          workspaceId: run.workspaceId,
          projectId: run.projectId,
          stageRunId: run.id,
          errorCode: "PIPELINE_STAGE_FAILED",
          errorDetail: error instanceof Error ? error.message.slice(0, 4_000) : "Pipeline stage failed",
          ...(shouldRetry(run) ? { retry: { inputDigest: run.inputDigest } } : {})
        });
        if (failed.retry) {
          await this.queue.send({
            stageRunId: failed.retry.id,
            buildId: failed.retry.buildId,
            projectId: failed.retry.projectId
          }, { delayMs: retryDelayMs(run) });
        }
      }
      return;
    }
    await this.store.transitionStageRun(run.workspaceId, run.projectId, run.id, "running", "cancelled");
  }
}
