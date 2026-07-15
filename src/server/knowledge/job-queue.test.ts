import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const boss = {
    upsert: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    createQueue: vi.fn(async () => undefined),
    work: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined)
  };
  return { boss, PgBoss: vi.fn(function PgBossMock() { return boss; }) };
});

vi.mock("pg-boss", () => ({ PgBoss: mocks.PgBoss }));

import { PgBossPipelineStageJobQueue } from "./job-queue";

const job = {
  workspaceId: "workspace-1",
  projectId: "project-1",
  snapshotId: "snapshot-1",
  buildId: "build-1",
  stages: ["convert", "extract"] as const,
  stageIndex: 0,
  inputDigest: "a".repeat(64)
};

describe("PgBossPipelineStageJobQueue", () => {
  beforeEach(() => vi.clearAllMocks());

  test("uses an idempotency key scoped to one build stage", async () => {
    const queue = new PgBossPipelineStageJobQueue("postgres://localhost/devkh");

    await queue.send(job);

    expect(mocks.PgBoss).toHaveBeenCalledWith("postgres://localhost/devkh");
    expect(mocks.boss.upsert).toHaveBeenCalledWith(
      "knowledge-pipeline-stage",
      job,
      { singletonKey: "build-1:0" }
    );
  });

  test("starts a stage consumer and hands each queued job to the worker", async () => {
    const queue = new PgBossPipelineStageJobQueue("postgres://localhost/devkh");
    const handler = vi.fn(async () => undefined);

    await queue.start(handler);

    expect(mocks.boss.start).toHaveBeenCalledOnce();
    expect(mocks.boss.createQueue).toHaveBeenCalledWith("knowledge-pipeline-stage");
    const workCalls = mocks.boss.work.mock.calls as unknown as Array<[
      string,
      (jobs: Array<{ data: typeof job }>) => Promise<void>
    ]>;
    const consumer = workCalls[0]?.[1];
    expect(consumer).toBeTypeOf("function");
    await consumer!([{ data: job }]);
    expect(handler).toHaveBeenCalledWith(job);
  });
});
