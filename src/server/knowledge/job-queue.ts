import { PgBoss } from "pg-boss";

import type { BuildJobQueue } from "./build-service.js";

const BUILD_QUEUE = "knowledge-build";

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
