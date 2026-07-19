import { describe, expect, test } from "vitest";

import type { PipelineStageRunRecord } from "../../persistence/store";
import { frontendCandidateRunStatus } from "./preview-status";

function run(stage: PipelineStageRunRecord["stage"], attempt: number, status: PipelineStageRunRecord["status"]): PipelineStageRunRecord {
  return {
    id: `${stage}-${attempt}`, workspaceId: "workspace", projectId: "project", snapshotId: "snapshot",
    buildId: "build", stage, attempt, status, inputDigest: "a".repeat(64), outputManifestIds: [],
    startedAt: null, finishedAt: null, errorCode: status === "failed" ? "STAGE_FAILED" : null, errorDetail: null
  };
}

describe("frontend candidate run status", () => {
  test("reports only the latest attempt failure and lets a successful package win", () => {
    expect(frontendCandidateRunStatus([run("extract", 1, "failed")])).toMatchObject({
      status: "candidate_failed", failedStage: { stage: "extract", errorCode: "STAGE_FAILED" }
    });
    expect(frontendCandidateRunStatus([run("extract", 1, "failed"), run("extract", 2, "running")]))
      .toEqual({ status: "candidate_pending" });
    expect(frontendCandidateRunStatus([
      run("extract", 1, "failed"), run("extract", 2, "succeeded"), run("package", 1, "succeeded")
    ])).toEqual({ status: "ready" });
  });
});
