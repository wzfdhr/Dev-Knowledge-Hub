import { describe, expect, test, vi } from "vitest";

import { createPipelineStageExecutor } from "./stage-executor";
import type { PipelineStageRunRecord } from "../../persistence/store";

const run: PipelineStageRunRecord = {
  id: "run-1", workspaceId: "workspace-1", projectId: "project-1", snapshotId: "snapshot-1", buildId: "build-1",
  stage: "convert", attempt: 1, status: "running", inputDigest: "a".repeat(64), outputManifestIds: [],
  startedAt: "2026-07-16T00:00:00.000Z", finishedAt: null, errorCode: null, errorDetail: null
};

describe("pipeline stage executor", () => {
  test("dispatches a run only to its registered stage executor", async () => {
    const convert = vi.fn(async () => ({ outputManifestIds: ["artifact-1"] }));
    const execute = createPipelineStageExecutor({ convert });

    await expect(execute(run)).resolves.toEqual({ outputManifestIds: ["artifact-1"] });
    expect(convert).toHaveBeenCalledWith(run);
  });

  test("rejects a stage that is not registered in this pipeline generation", async () => {
    const execute = createPipelineStageExecutor({ convert: async () => ({}) });

    await expect(execute({ ...run, stage: "extract" })).rejects.toThrow("not configured");
  });
});
