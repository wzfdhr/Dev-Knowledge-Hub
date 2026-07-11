import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";

import type { BUILD_JOB_STATUSES } from "../../shared/contracts.js";
import { generateKnowledge, type KnowledgeOutput, validateKnowledge } from "./generator.js";
import type { KnowledgeEnhancer } from "./enhancer.js";
import { analyzeSnapshot, type CodeIndex } from "./intelligence.js";

export type BuildStatus = (typeof BUILD_JOB_STATUSES)[number];

export interface BuildRecord {
  id: string;
  workspaceId: string;
  repositoryId: string;
  snapshotId: string;
  snapshotPath: string;
  commitSha: string;
  status: BuildStatus;
  warnings: KnowledgeOutput["warnings"];
  cancelRequested: boolean;
  errorMessage?: string;
}

export interface PersistedKnowledge {
  build: BuildRecord;
  index: CodeIndex;
  output: KnowledgeOutput;
}

export interface BuildPersistence {
  createBuild(
    input: Omit<BuildRecord, "id" | "status" | "warnings" | "cancelRequested">
  ): Promise<{ build: BuildRecord; created: boolean }>;
  getBuild(workspaceId: string, buildId: string): Promise<BuildRecord | null>;
  claimBuild(buildId: string): Promise<BuildRecord | null>;
  transitionBuild(
    buildId: string,
    expectedStatus: BuildStatus,
    status: BuildStatus,
    details?: { errorMessage?: string; warnings?: KnowledgeOutput["warnings"] }
  ): Promise<BuildRecord | null>;
  requestBuildCancellation(workspaceId: string, buildId: string): Promise<BuildRecord | null>;
  saveKnowledge(value: PersistedKnowledge): Promise<void>;
  listUnfinishedBuilds(): Promise<BuildRecord[]>;
  listBuilds(workspaceId: string, repositoryId: string): Promise<BuildRecord[]>;
  listBuildEvents(workspaceId: string, buildId: string): Promise<BuildEvent[]>;
}

export interface BuildJobQueue {
  send(buildId: string): Promise<void>;
  start(handler: (buildId: string) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

export interface BuildEvent {
  sequence: number;
  buildId: string;
  status: BuildStatus;
  occurredAt: string;
  errorMessage?: string;
}

class BuildCancelledError extends Error {
  constructor() {
    super("Build cancelled");
  }
}

class StaleBuildWorkerError extends Error {}

export class BuildService {
  private readonly events = new EventEmitter();
  private readonly analyze: typeof analyzeSnapshot;
  private readonly synthesize: typeof generateKnowledge;
  private readonly validate: typeof validateKnowledge;
  private readonly enhancer?: KnowledgeEnhancer;
  private readonly enhancerForWorkspace?: (workspaceId: string) => Promise<KnowledgeEnhancer | undefined>;
  private startPromise: Promise<void> | null = null;

  constructor(
    private readonly persistence: BuildPersistence,
    private readonly queue: BuildJobQueue,
    dependencies: {
      analyze?: typeof analyzeSnapshot;
      synthesize?: typeof generateKnowledge;
      validate?: typeof validateKnowledge;
      enhancer?: KnowledgeEnhancer;
      enhancerForWorkspace?: (workspaceId: string) => Promise<KnowledgeEnhancer | undefined>;
    } = {}
  ) {
    this.analyze = dependencies.analyze ?? analyzeSnapshot;
    this.synthesize = dependencies.synthesize ?? generateKnowledge;
    this.validate = dependencies.validate ?? validateKnowledge;
    this.enhancer = dependencies.enhancer;
    this.enhancerForWorkspace = dependencies.enhancerForWorkspace;
  }

  subscribe(buildId: string, listener: (event: BuildEvent) => void): () => void {
    this.events.on(buildId, listener);
    return () => this.events.off(buildId, listener);
  }

  private async emitLatest(build: BuildRecord): Promise<void> {
    const event = (await this.persistence.listBuildEvents(build.workspaceId, build.id)).at(-1);
    if (event) this.events.emit(build.id, event);
  }

  start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.startOnce().catch((error: unknown) => {
        this.startPromise = null;
        throw error;
      });
    }
    return this.startPromise;
  }

  private async startOnce(): Promise<void> {
    const recoveredBuildIds = await this.recover();
    await this.queue.start((buildId) => this.process(buildId));
    for (const buildId of recoveredBuildIds) await this.queue.send(buildId);
  }

  async stop(): Promise<void> {
    await this.queue.stop();
    this.startPromise = null;
  }

  async startBuild(
    input: Omit<BuildRecord, "id" | "status" | "warnings" | "cancelRequested">
  ): Promise<{ build: BuildRecord; created: boolean }> {
    const result = await this.persistence.createBuild(input);
    return this.enqueueBuild(result);
  }

  async enqueueBuild(
    result: { build: BuildRecord; created: boolean }
  ): Promise<{ build: BuildRecord; created: boolean }> {
    if (result.created) {
      await this.emitLatest(result.build);
      await this.queue.send(result.build.id);
    }
    return result;
  }

  async cancelBuild(workspaceId: string, buildId: string): Promise<BuildRecord | null> {
    return this.persistence.requestBuildCancellation(workspaceId, buildId);
  }

  getBuild(workspaceId: string, buildId: string): Promise<BuildRecord | null> {
    return this.persistence.getBuild(workspaceId, buildId);
  }

  listBuilds(workspaceId: string, repositoryId: string): Promise<BuildRecord[]> {
    return this.persistence.listBuilds(workspaceId, repositoryId);
  }

  listEvents(workspaceId: string, buildId: string): Promise<BuildEvent[]> {
    return this.persistence.listBuildEvents(workspaceId, buildId);
  }

  private async transition(
    buildId: string,
    expectedStatus: BuildStatus,
    status: BuildStatus,
    details?: { errorMessage?: string; warnings?: KnowledgeOutput["warnings"] }
  ): Promise<BuildRecord> {
    const build = await this.persistence.transitionBuild(buildId, expectedStatus, status, details);
    if (!build) throw new StaleBuildWorkerError();
    await this.emitLatest(build);
    return build;
  }

  private async checkCancellation(build: BuildRecord): Promise<void> {
    const latest = await this.persistence.getBuild(build.workspaceId, build.id);
    if (latest?.cancelRequested) throw new BuildCancelledError();
  }

  async process(buildId: string): Promise<void> {
    const original = await this.persistence.claimBuild(buildId);
    if (!original) return;
    let status: BuildStatus = "syncing";
    try {
      await this.emitLatest(original);
      await this.checkCancellation(original);
      await this.transition(buildId, status, "parsing");
      status = "parsing";
      const index = await this.analyze(original.snapshotPath, original.commitSha);
      await this.checkCancellation(original);
      await this.transition(buildId, status, "synthesizing");
      status = "synthesizing";
      const enhancer = this.enhancerForWorkspace
        ? await this.enhancerForWorkspace(original.workspaceId)
        : this.enhancer;
      const output = await this.synthesize(index, enhancer);
      await this.checkCancellation(original);
      await this.transition(buildId, status, "validating", { warnings: output.warnings });
      status = "validating";
      this.validate(output, index);
      await this.checkCancellation(original);
      await this.persistence.saveKnowledge({ build: original, index, output });
      await this.transition(buildId, status, "ready", { warnings: output.warnings });
    } catch (error) {
      if (error instanceof StaleBuildWorkerError) return;
      const failed = await this.persistence.transitionBuild(buildId, status, "failed", {
        errorMessage: error instanceof Error ? error.message : "Knowledge build failed"
      });
      if (failed) await this.emitLatest(failed);
    }
  }

  async recover(): Promise<string[]> {
    const queuedBuildIds: string[] = [];
    for (const build of await this.persistence.listUnfinishedBuilds()) {
      if (build.status !== "queued") {
        await this.transition(
          build.id,
          build.status,
          "failed",
          { errorMessage: "Build interrupted by server restart" }
        );
        continue;
      }
      try {
        await fs.access(build.snapshotPath);
        queuedBuildIds.push(build.id);
      } catch {
        await this.transition(
          build.id,
          build.status,
          "failed",
          { errorMessage: "Immutable snapshot is unavailable" }
        );
      }
    }
    return queuedBuildIds;
  }
}
