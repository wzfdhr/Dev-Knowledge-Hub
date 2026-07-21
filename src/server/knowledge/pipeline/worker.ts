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
const PARSER_RUNTIME_ERROR_CODES = new Set([
  "PARSER_RUNTIME_UNAVAILABLE",
  "PARSER_TIMEOUT",
  "PARSER_CANCELLED",
  "PARSER_WORKER_CRASH",
  "PARSER_OUTPUT_LIMIT",
  "PARSER_INVALID_REQUEST"
]);
const MAX_STAGE_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [5_000, 30_000] as const;

function shouldRetry(run: PipelineStageRunRecord): boolean {
  return RETRYABLE_STAGES.has(run.stage) && run.attempt < MAX_STAGE_ATTEMPTS;
}

function retryDelayMs(run: PipelineStageRunRecord): number {
  return RETRY_DELAYS_MS[run.attempt - 1] ?? RETRY_DELAYS_MS.at(-1)!;
}

function pipelineErrorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string"
    && PARSER_RUNTIME_ERROR_CODES.has(error.code)) return error.code;
  return "PIPELINE_STAGE_FAILED";
}

export class PipelineStageWorker {
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: PipelineWorkerStore,
    private readonly queue: PipelineStageJobQueue,
    private readonly execute: PipelineStageExecutor,
    private readonly stages: readonly BuildStage[],
    private readonly reconcileIntervalMs = 5_000,
    private readonly inputPlanner?: PipelineStageInputPlanner,
    private readonly staleRunAfterMs = 5 * 60_000
  ) {}

  private async enqueue(job: PipelineStageJob, options?: { delayMs?: number }): Promise<void> {
    try {
      await this.queue.send(job, options);
    } catch {
      // The stage run is already durable. Reconciliation will retry delivery.
    }
  }

  async start(): Promise<void> {
    await this.queue.start((job) => this.process(job));
    await this.recoverStaleRuns();
    await this.reconcileQueuedRuns();
    this.reconcileTimer = setInterval(() => {
      void this.reconcileQueuedRuns();
    }, this.reconcileIntervalMs);
    this.reconcileTimer.unref?.();
  }

  private async reconcileQueuedRuns(): Promise<void> {
    for (const run of await this.store.listQueuedStageRuns()) {
      await this.enqueue({ stageRunId: run.id, buildId: run.buildId, projectId: run.projectId });
    }
  }

  private async recoverStaleRuns(): Promise<void> {
    const staleBefore = new Date(Date.now() - this.staleRunAfterMs);
    for (const run of await this.store.listStaleRunningStageRuns(staleBefore)) {
      const recovered = await this.store.failStageRunAndCreateRetry({
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        stageRunId: run.id,
        errorCode: "STAGE_INTERRUPTED",
        errorDetail: "Pipeline worker stopped before this stage completed",
        ...(shouldRetry(run) ? { retry: {
          inputDigest: run.inputDigest,
          availableAt: new Date(Date.now() + retryDelayMs(run))
        } } : {})
      });
      if (recovered.retry) {
        await this.enqueue({
          stageRunId: recovered.retry.id,
          buildId: recovered.retry.buildId,
          projectId: recovered.retry.projectId
        }, { delayMs: retryDelayMs(run) });
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
    await this.enqueue({ stageRunId: run.id, buildId: run.buildId, projectId: run.projectId });
  }

  async dispatch(job: PipelineStageJob): Promise<void> {
    await this.enqueue(job);
  }

  async process(job: PipelineStageJob): Promise<void> {
    const run = await this.store.claimStageRun(job.stageRunId, job.buildId, job.projectId);
    if (!run) return;
    const build = await this.store.getBuild(run.workspaceId, run.buildId);
    if (build && !build.cancelRequested) {
      try {
        const result = await this.execute(run);
        const currentBuild = await this.store.getBuild(run.workspaceId, run.buildId);
        if (!currentBuild || currentBuild.cancelRequested) {
          await this.store.transitionStageRun(run.workspaceId, run.projectId, run.id, "running", "cancelled");
          return;
        }
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
          await this.enqueue({
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
          errorCode: pipelineErrorCode(error),
          errorDetail: error instanceof Error ? error.message.slice(0, 4_000) : "Pipeline stage failed",
          ...(shouldRetry(run) ? { retry: {
            inputDigest: run.inputDigest,
            availableAt: new Date(Date.now() + retryDelayMs(run))
          } } : {})
        });
        if (failed.retry) {
          await this.enqueue({
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
