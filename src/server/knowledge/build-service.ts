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
  transitionBuild(
    buildId: string,
    status: BuildStatus,
    details?: { errorMessage?: string; warnings?: KnowledgeOutput["warnings"] }
  ): Promise<BuildRecord>;
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

export class BuildService {
  private readonly events = new EventEmitter();
  private readonly analyze: typeof analyzeSnapshot;
  private readonly synthesize: typeof generateKnowledge;
  private readonly validate: typeof validateKnowledge;
  private readonly enhancer?: KnowledgeEnhancer;

  constructor(
    private readonly persistence: BuildPersistence,
    private readonly queue: BuildJobQueue,
    dependencies: {
      analyze?: typeof analyzeSnapshot;
      synthesize?: typeof generateKnowledge;
      validate?: typeof validateKnowledge;
      enhancer?: KnowledgeEnhancer;
    } = {}
  ) {
    this.analyze = dependencies.analyze ?? analyzeSnapshot;
    this.synthesize = dependencies.synthesize ?? generateKnowledge;
    this.validate = dependencies.validate ?? validateKnowledge;
    this.enhancer = dependencies.enhancer;
  }

  subscribe(buildId: string, listener: (event: BuildEvent) => void): () => void {
    this.events.on(buildId, listener);
    return () => this.events.off(buildId, listener);
  }

  private emit(build: BuildRecord): void {
    this.events.emit(build.id, {
      buildId: build.id,
      status: build.status,
      occurredAt: new Date().toISOString(),
      ...(build.errorMessage ? { errorMessage: build.errorMessage } : {})
    } satisfies BuildEvent);
  }

  async start(): Promise<void> {
    await this.queue.start((buildId) => this.process(buildId));
    await this.recover();
  }

  stop(): Promise<void> {
    return this.queue.stop();
  }

  async startBuild(
    input: Omit<BuildRecord, "id" | "status" | "warnings" | "cancelRequested">
  ): Promise<{ build: BuildRecord; created: boolean }> {
    const result = await this.persistence.createBuild(input);
    if (result.created) {
      this.emit(result.build);
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
    status: BuildStatus,
    details?: { errorMessage?: string; warnings?: KnowledgeOutput["warnings"] }
  ): Promise<BuildRecord> {
    const build = await this.persistence.transitionBuild(buildId, status, details);
    this.emit(build);
    return build;
  }

  private async checkCancellation(build: BuildRecord): Promise<void> {
    const latest = await this.persistence.getBuild(build.workspaceId, build.id);
    if (latest?.cancelRequested) throw new BuildCancelledError();
  }

  async process(buildId: string): Promise<void> {
    const unfinished = await this.persistence.listUnfinishedBuilds();
    const original = unfinished.find((build) => build.id === buildId);
    if (!original) return;
    try {
      await this.transition(buildId, "syncing");
      await this.checkCancellation(original);
      await this.transition(buildId, "parsing");
      const index = await this.analyze(original.snapshotPath, original.commitSha);
      await this.checkCancellation(original);
      await this.transition(buildId, "synthesizing");
      const output = await this.synthesize(index, this.enhancer);
      await this.checkCancellation(original);
      await this.transition(buildId, "validating", { warnings: output.warnings });
      this.validate(output, index);
      await this.checkCancellation(original);
      await this.persistence.saveKnowledge({ build: original, index, output });
      await this.transition(buildId, "ready", { warnings: output.warnings });
    } catch (error) {
      await this.transition(buildId, "failed", {
        errorMessage: error instanceof Error ? error.message : "Knowledge build failed"
      });
    }
  }

  async recover(): Promise<void> {
    for (const build of await this.persistence.listUnfinishedBuilds()) {
      try {
        await fs.access(build.snapshotPath);
        await this.queue.send(build.id);
      } catch {
        await this.transition(build.id, "failed", { errorMessage: "Immutable snapshot is unavailable" });
      }
    }
  }
}
