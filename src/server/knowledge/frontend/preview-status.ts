import type { PipelineStageRunRecord } from "../../persistence/store.js";

export type FrontendCandidateRunStatus =
  | { status: "ready" }
  | { status: "candidate_pending" }
  | { status: "candidate_failed"; failedStage: { stage: string; errorCode: string | null } };

export function frontendCandidateRunStatus(runs: readonly PipelineStageRunRecord[]): FrontendCandidateRunStatus {
  if (runs.some((run) => run.stage === "package" && (run.status === "succeeded" || run.status === "reused"))) {
    return { status: "ready" };
  }
  const latestByStage = new Map<string, PipelineStageRunRecord>();
  for (const run of runs) {
    const latest = latestByStage.get(run.stage);
    if (!latest || run.attempt >= latest.attempt) latestByStage.set(run.stage, run);
  }
  const failed = [...latestByStage.values()].findLast((run) => run.status === "failed" || run.status === "cancelled");
  return failed
    ? { status: "candidate_failed", failedStage: { stage: failed.stage, errorCode: failed.errorCode } }
    : { status: "candidate_pending" };
}
