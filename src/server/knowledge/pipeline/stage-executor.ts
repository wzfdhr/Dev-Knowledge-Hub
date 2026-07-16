import type { BuildStage } from "./contracts.js";
import type { PipelineStageExecutionResult, PipelineStageExecutor } from "./worker.js";

export type PipelineStageExecutors = Partial<Record<BuildStage, PipelineStageExecutor>>;

export function createPipelineStageExecutor(executors: PipelineStageExecutors): PipelineStageExecutor {
  return async (run): Promise<PipelineStageExecutionResult> => {
    const execute = executors[run.stage];
    if (!execute) throw new Error(`Pipeline stage ${run.stage} is not configured`);
    return execute(run);
  };
}
