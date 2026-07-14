import { describe, expect, test } from "vitest";

import {
  BUILD_STAGES,
  assertValidStageRuns,
  canTransitionStage,
  legacyBuildStatus,
  stageRunSchema,
  type StageRun
} from "./contracts";

function stageRun(overrides: Partial<StageRun> = {}): StageRun {
  return {
    id: "stage-run-1",
    buildId: "build-1",
    stage: "convert",
    attempt: 1,
    status: "queued",
    inputDigest: "a".repeat(64),
    outputManifestIds: [],
    startedAt: null,
    finishedAt: null,
    errorCode: null,
    errorDetail: null,
    ...overrides
  };
}

describe("knowledge pipeline contracts", () => {
  test("rejects unknown stages and malformed stage-run payloads", () => {
    expect(BUILD_STAGES).toEqual([
      "convert", "extract", "tables", "graph", "synthesize",
      "index", "lint", "viz", "validate", "package"
    ]);
    expect(stageRunSchema.safeParse({ ...stageRun(), stage: "deploy" }).success).toBe(false);
    expect(stageRunSchema.safeParse({ ...stageRun(), inputDigest: "short" }).success).toBe(false);
  });

  test("rejects duplicated stage attempts and an invalid stage order", () => {
    expect(() => assertValidStageRuns([
      stageRun(),
      stageRun({ id: "stage-run-2" })
    ])).toThrow("Duplicate stage attempt");
    expect(() => assertValidStageRuns([
      stageRun({ stage: "extract", status: "queued" }),
      stageRun({ id: "stage-run-2", stage: "convert", status: "succeeded", startedAt: "2026-07-14T00:00:00.000Z", finishedAt: "2026-07-14T00:00:01.000Z" })
    ])).toThrow("Pipeline stages are out of order");
  });

  test("allows only explicit state transitions", () => {
    expect(canTransitionStage("queued", "running")).toBe(true);
    expect(canTransitionStage("running", "succeeded")).toBe(true);
    expect(canTransitionStage("running", "failed")).toBe(true);
    expect(canTransitionStage("succeeded", "running")).toBe(false);
    expect(canTransitionStage("queued", "succeeded")).toBe(false);
  });

  test("projects stage runs to the existing build status contract", () => {
    expect(legacyBuildStatus([])).toBe("queued");
    expect(legacyBuildStatus([stageRun({ status: "running", startedAt: "2026-07-14T00:00:00.000Z" })])).toBe("syncing");
    expect(legacyBuildStatus([stageRun({ status: "failed", startedAt: "2026-07-14T00:00:00.000Z", finishedAt: "2026-07-14T00:00:01.000Z", errorCode: "PARSE_INVALID", errorDetail: "invalid source" })])).toBe("failed");
    expect(legacyBuildStatus([stageRun({ stage: "package", status: "succeeded", startedAt: "2026-07-14T00:00:00.000Z", finishedAt: "2026-07-14T00:00:01.000Z" })])).toBe("ready");
    expect(legacyBuildStatus([stageRun({ stage: "package", status: "succeeded", startedAt: "2026-07-14T00:00:00.000Z", finishedAt: "2026-07-14T00:00:01.000Z" })], { published: true })).toBe("published");
  });
});
