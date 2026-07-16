import { describe, expect, test, vi } from "vitest";

import {
  PipelineStageWorker,
  type PipelineStageJob,
  type PipelineStageJobQueue,
  type PipelineStageSchedule
} from "./worker";
import type { PipelineArtifactStore, PipelineStageRunRecord } from "../../persistence/store";
import type { BuildRecord } from "../build-service";

const digest = "a".repeat(64);

function createBuild(cancelRequested = false): BuildRecord {
  return {
    id: "build-1", workspaceId: "workspace-1", repositoryId: "repository-1", snapshotId: "snapshot-1",
    snapshotPath: "/tmp/snapshot", commitSha: "b".repeat(40), status: "queued", warnings: [], cancelRequested,
    purpose: { kind: "standard", feedbackIds: [], feedbackContext: [] }
  };
}

class FakePipelineStore implements PipelineArtifactStore {
  readonly runs: PipelineStageRunRecord[] = [];
  readonly failStageRunAndCreateRetry = vi.fn(async (input: {
    workspaceId: string; projectId: string; stageRunId: string; errorCode: string; errorDetail: string;
    retry?: { inputDigest: string };
  }) => {
    const failed = await this.transitionStageRun(
      input.workspaceId, input.projectId, input.stageRunId, "running", "failed",
      { errorCode: input.errorCode, errorDetail: input.errorDetail }
    );
    if (!failed || !input.retry) return { failed, retry: null };
    const retry = await this.createStageRun({
      workspaceId: failed.workspaceId, projectId: failed.projectId, snapshotId: failed.snapshotId,
      buildId: failed.buildId, stage: failed.stage, attempt: failed.attempt + 1,
      inputDigest: input.retry.inputDigest
    });
    return { failed, retry };
  });
  readonly completeStageRunAndCreateNext = vi.fn(async (input: {
    workspaceId: string; projectId: string; stageRunId: string; status: "succeeded" | "reused";
    outputManifestIds?: string[]; next?: Parameters<FakePipelineStore["createStageRun"]>[0];
  }) => {
    const completed = await this.transitionStageRun(
      input.workspaceId, input.projectId, input.stageRunId, "running", input.status,
      { outputManifestIds: input.outputManifestIds }
    );
    if (!completed) return null;
    const next = input.next ? await this.createStageRun(input.next) : null;
    return { completed, next };
  });
  constructor(readonly build: BuildRecord | null = createBuild()) {}

  async createStageRun(input: { workspaceId: string; projectId: string; snapshotId: string; buildId: string; stage: PipelineStageRunRecord["stage"]; attempt: number; inputDigest: string }) {
    const existing = this.runs.find((run) => run.buildId === input.buildId && run.stage === input.stage && run.attempt === input.attempt);
    if (existing) return existing;
    const run: PipelineStageRunRecord = {
      id: `run-${this.runs.length + 1}`, ...input, status: "queued", outputManifestIds: [],
      startedAt: null, finishedAt: null, errorCode: null, errorDetail: null
    };
    this.runs.push(run);
    return run;
  }

  async claimNextStageRun(workspaceId: string, projectId: string, scope?: { buildId?: string; stage?: PipelineStageRunRecord["stage"] }) {
    const run = this.runs.find((candidate) => candidate.workspaceId === workspaceId && candidate.projectId === projectId
      && candidate.status === "queued" && (!scope?.buildId || candidate.buildId === scope.buildId)
      && (!scope?.stage || candidate.stage === scope.stage));
    if (!run) return null;
    run.status = "running";
    run.startedAt = "2026-07-14T00:00:00.000Z";
    return run;
  }

  async claimStageRun(stageRunId: string, buildId: string, projectId: string) {
    return this.claimNextStageRun("workspace-1", projectId, { buildId, stage: this.runs.find((run) => run.id === stageRunId)?.stage });
  }

  async listQueuedStageRuns() { return this.runs.filter((run) => run.status === "queued"); }
  async listStaleRunningStageRuns() { return this.runs.filter((run) => run.status === "running"); }

  async transitionStageRun(_workspaceId: string, _projectId: string, stageRunId: string, expectedStatus: PipelineStageRunRecord["status"], status: PipelineStageRunRecord["status"], details = {}) {
    const run = this.runs.find((candidate) => candidate.id === stageRunId);
    if (!run || run.status !== expectedStatus) return null;
    run.status = status;
    run.finishedAt = "2026-07-14T00:00:01.000Z";
    Object.assign(run, details);
    return run;
  }

  async findReusableArtifact() { return null; }
  async findArtifactById() { return null; }
  async recordArtifactCacheMiss() {}
  async createArtifactWithAudit(): Promise<never> { throw new Error("not used"); }
  async getBuild() { return this.build; }
}

class FakeQueue implements PipelineStageJobQueue {
  readonly sent: PipelineStageJob[] = [];
  handler: ((job: PipelineStageJob) => Promise<void>) | null = null;
  async send(job: PipelineStageJob) { this.sent.push(job); }
  async start(handler: (job: PipelineStageJob) => Promise<void>) { this.handler = handler; }
  async stop() {}
}

const job: PipelineStageSchedule = {
  workspaceId: "workspace-1", projectId: "project-1", snapshotId: "snapshot-1", buildId: "build-1", inputDigest: digest
};
const stages = ["convert", "extract", "graph"] as const;

describe("PipelineStageWorker", () => {
  test("sends only durable stage, build, and project identifiers to the queue", async () => {
    const store = new FakePipelineStore();
    const queue = new FakeQueue();
    const worker = new PipelineStageWorker(store, queue, async () => ({ outputManifestIds: [] }), stages);

    await worker.schedule(job);

    expect(queue.sent).toEqual([
      { stageRunId: "run-1", buildId: "build-1", projectId: "project-1" }
    ]);
  });

  test("re-dispatches durable queued runs when the worker starts", async () => {
    const store = new FakePipelineStore();
    await store.createStageRun({ ...job, stage: "convert", attempt: 1 });
    const queue = new FakeQueue();
    const worker = new PipelineStageWorker(store, queue, async () => ({ outputManifestIds: [] }), stages);

    await worker.start();

    expect(queue.sent).toEqual([{ stageRunId: "run-1", buildId: "build-1", projectId: "project-1" }]);
  });

  test("succeeds one stage, then persists and queues only the next stage", async () => {
    const store = new FakePipelineStore();
    const queue = new FakeQueue();
    const worker = new PipelineStageWorker(store, queue, async () => ({ outputManifestIds: ["artifact-1"] }), stages);
    await worker.schedule(job);

    await worker.process(queue.sent[0]!);

    expect(store.completeStageRunAndCreateNext).toHaveBeenCalledOnce();
    expect(store.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "convert", status: "succeeded", outputManifestIds: ["artifact-1"] }),
      expect.objectContaining({ stage: "extract", status: "queued", inputDigest: expect.not.stringMatching(/^a{64}$/) })
    ]));
    expect(store.runs.some((run) => run.stage === "graph")).toBe(false);
    expect(queue.sent).toEqual([
      { stageRunId: "run-1", buildId: "build-1", projectId: "project-1" },
      { stageRunId: "run-2", buildId: "build-1", projectId: "project-1" }
    ]);
  });

  test("uses the stage input planner for the next durable run", async () => {
    const store = new FakePipelineStore();
    const queue = new FakeQueue();
    const nextInputDigest = vi.fn(async () => "c".repeat(64));
    const worker = new PipelineStageWorker(
      store,
      queue,
      async () => ({ outputManifestIds: ["artifact-1"] }),
      stages,
      5_000,
      { nextInputDigest }
    );
    await worker.schedule(job);

    await worker.process(queue.sent[0]!);

    expect(nextInputDigest).toHaveBeenCalledWith(expect.objectContaining({
      currentRun: expect.objectContaining({ stage: "convert" }),
      nextStage: "extract",
      outputManifestIds: ["artifact-1"]
    }));
    expect(store.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "extract", inputDigest: "c".repeat(64) })
    ]));
  });

  test("does not retry a deterministic stage after a worker failure", async () => {
    const store = new FakePipelineStore();
    const queue = new FakeQueue();
    const worker = new PipelineStageWorker(store, queue, async () => { throw new Error("parser failed"); }, ["extract", "graph"]);
    await worker.schedule(job);

    await worker.process(queue.sent[0]!);

    expect(store.runs).toEqual([expect.objectContaining({ stage: "extract", status: "failed", errorCode: "PIPELINE_STAGE_FAILED" })]);
    expect(queue.sent).toHaveLength(1);
  });

  test("preserves a failed retryable attempt before queueing its next attempt", async () => {
    const store = new FakePipelineStore();
    const queue = new FakeQueue();
    const worker = new PipelineStageWorker(store, queue, async () => { throw new Error("database unavailable"); }, stages);
    await worker.schedule(job);

    await worker.process(queue.sent[0]!);

    expect(store.failStageRunAndCreateRetry).toHaveBeenCalledWith(expect.objectContaining({
      stageRunId: "run-1", errorCode: "PIPELINE_STAGE_FAILED", retry: expect.objectContaining({ inputDigest: digest })
    }));
    expect(store.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "convert", attempt: 1, status: "failed" }),
      expect.objectContaining({ stage: "convert", attempt: 2, status: "queued", inputDigest: digest })
    ]));
    expect(queue.sent).toEqual([
      { stageRunId: "run-1", buildId: "build-1", projectId: "project-1" },
      { stageRunId: "run-2", buildId: "build-1", projectId: "project-1" }
    ]);
  });

  test("records an interrupted stale attempt before recovering its retry", async () => {
    const store = new FakePipelineStore();
    await store.createStageRun({ ...job, stage: "convert", attempt: 1 });
    const stale = store.runs[0]!;
    stale.status = "running";
    stale.startedAt = "2026-07-14T00:00:00.000Z";
    const queue = new FakeQueue();
    const worker = new PipelineStageWorker(store, queue, async () => ({ outputManifestIds: [] }), stages);

    await worker.start();
    await worker.stop();

    expect(store.failStageRunAndCreateRetry).toHaveBeenCalledWith(expect.objectContaining({
      stageRunId: stale.id,
      errorCode: "STAGE_INTERRUPTED",
      retry: expect.objectContaining({ inputDigest: digest })
    }));
    expect(store.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: stale.id, status: "failed", errorCode: "STAGE_INTERRUPTED" }),
      expect.objectContaining({ stage: "convert", attempt: 2, status: "queued" })
    ]));
  });

  test("records a cache hit as reused before scheduling the next stage", async () => {
    const store = new FakePipelineStore();
    const queue = new FakeQueue();
    const worker = new PipelineStageWorker(store, queue, async () => ({
      outputManifestIds: ["artifact-1"],
      reused: true
    }), stages);
    await worker.schedule(job);

    await worker.process(queue.sent[0]!);

    expect(store.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "convert", status: "reused", outputManifestIds: ["artifact-1"] }),
      expect.objectContaining({ stage: "extract", status: "queued" })
    ]));
  });

  test("cancels a claimed stage without executing or scheduling downstream work", async () => {
    const store = new FakePipelineStore(createBuild(true));
    const queue = new FakeQueue();
    const execute = async () => { throw new Error("must not execute"); };
    const worker = new PipelineStageWorker(store, queue, execute, stages);
    await worker.schedule(job);

    await worker.process(queue.sent[0]!);

    expect(store.runs).toEqual([expect.objectContaining({ stage: "convert", status: "cancelled" })]);
    expect(queue.sent).toHaveLength(1);
  });

  test("cancels an orphaned queued stage without executing it", async () => {
    const store = new FakePipelineStore(null);
    const queue = new FakeQueue();
    const execute = async () => { throw new Error("must not execute"); };
    const worker = new PipelineStageWorker(store, queue, execute, stages);
    await worker.schedule(job);

    await worker.process(queue.sent[0]!);

    expect(store.runs).toEqual([expect.objectContaining({ stage: "convert", status: "cancelled" })]);
    expect(queue.sent).toHaveLength(1);
  });
});
