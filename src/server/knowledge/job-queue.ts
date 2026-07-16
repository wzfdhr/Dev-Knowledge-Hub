import { PgBoss } from "pg-boss";

import type { BuildJobQueue } from "./build-service.js";
import type { PipelineStageJob, PipelineStageJobQueue } from "./pipeline/worker.js";

const BUILD_QUEUE = "knowledge-build";
const PIPELINE_STAGE_QUEUE = "knowledge-pipeline-stage";

export class PgBossBuildJobQueue implements BuildJobQueue {
  private readonly boss: PgBoss;

  constructor(connectionString: string) {
    this.boss = new PgBoss(connectionString);
  }

  async send(buildId: string): Promise<void> {
    await this.boss.upsert(BUILD_QUEUE, { buildId }, { singletonKey: buildId });
  }

  async start(handler: (buildId: string) => Promise<void>): Promise<void> {
    await this.boss.start();
    await this.boss.createQueue(BUILD_QUEUE);
    await this.boss.work<{ buildId: string }>(BUILD_QUEUE, async (jobs) => {
      for (const job of jobs) await handler(job.data.buildId);
    });
  }

  stop(): Promise<void> {
    return this.boss.stop({ graceful: true });
  }
}

export class PgBossPipelineStageJobQueue implements PipelineStageJobQueue {
  private readonly boss: PgBoss;

  constructor(connectionString: string) {
    this.boss = new PgBoss(connectionString);
  }

  async send(job: PipelineStageJob, options: { delayMs?: number } = {}): Promise<void> {
    await this.boss.upsert(
      PIPELINE_STAGE_QUEUE,
      job,
      {
        singletonKey: job.stageRunId,
        ...(options.delayMs ? { startAfter: new Date(Date.now() + options.delayMs) } : {})
      }
    );
  }

  async start(handler: (job: PipelineStageJob) => Promise<void>): Promise<void> {
    await this.boss.start();
    await this.boss.createQueue(PIPELINE_STAGE_QUEUE);
    await this.boss.work<PipelineStageJob>(PIPELINE_STAGE_QUEUE, async (jobs) => {
      for (const job of jobs) await handler(job.data);
    });
  }

  stop(): Promise<void> {
    return this.boss.stop({ graceful: true });
  }
}
