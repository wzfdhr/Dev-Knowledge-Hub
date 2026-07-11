import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test, vi } from "vitest";

import {
  BuildService,
  type BuildEvent,
  type BuildJobQueue,
  type BuildPersistence,
  type BuildRecord,
  type PersistedKnowledge
} from "./build-service";
import { analyzeSnapshot } from "./intelligence";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/code-intelligence"
);

class FakeBuildPersistence implements BuildPersistence {
  readonly builds: BuildRecord[] = [];
  readonly transitions: string[] = [];
  readonly knowledge: PersistedKnowledge[] = [];
  readonly buildEvents: BuildEvent[] = [];
  private nextSequence = 1;
  currentReleaseId = "release-current";

  async createBuild(input: Omit<BuildRecord, "id" | "status" | "warnings" | "cancelRequested">) {
    const active = this.builds.find((build) =>
      build.repositoryId === input.repositoryId
      && !["ready", "published", "failed"].includes(build.status)
    );
    if (active) return { build: active, created: false };
    const build: BuildRecord = {
      ...input,
      id: `build-${this.builds.length + 1}`,
      status: "queued",
      warnings: [],
      cancelRequested: false
    };
    this.builds.push(build);
    this.transitions.push("queued");
    this.buildEvents.push({
      sequence: this.nextSequence++, buildId: build.id, status: "queued",
      occurredAt: new Date().toISOString()
    });
    return { build, created: true };
  }

  async getBuild(workspaceId: string, buildId: string) {
    return this.builds.find((build) => build.workspaceId === workspaceId && build.id === buildId) ?? null;
  }

  async claimBuild(buildId: string) {
    return this.transitionBuild(buildId, "queued", "syncing");
  }

  async transitionBuild(
    buildId: string,
    expectedStatus: BuildRecord["status"],
    status: BuildRecord["status"], details?: {
    errorMessage?: string;
    warnings?: BuildRecord["warnings"];
  }) {
    const build = this.builds.find((candidate) => candidate.id === buildId)!;
    if (build.status !== expectedStatus) return null;
    build.status = status;
    if (details?.errorMessage) build.errorMessage = details.errorMessage;
    if (details?.warnings) build.warnings = details.warnings;
    this.transitions.push(status);
    this.buildEvents.push({
      sequence: this.nextSequence++, buildId, status, occurredAt: new Date().toISOString(),
      ...(details?.errorMessage ? { errorMessage: details.errorMessage } : {})
    });
    return build;
  }

  async requestBuildCancellation(workspaceId: string, buildId: string) {
    const build = await this.getBuild(workspaceId, buildId);
    if (!build) return null;
    build.cancelRequested = true;
    return build;
  }

  async saveKnowledge(value: PersistedKnowledge) {
    this.knowledge.push(value);
  }

  async listUnfinishedBuilds() {
    return this.builds.filter((build) => !["ready", "published", "failed"].includes(build.status));
  }
  async listBuilds(workspaceId: string, repositoryId: string) {
    return this.builds.filter((build) =>
      build.workspaceId === workspaceId && build.repositoryId === repositoryId
    );
  }
  async listBuildEvents(_workspaceId: string, buildId: string) {
    return this.buildEvents.filter((event) => event.buildId === buildId);
  }
}

class FakeQueue implements BuildJobQueue {
  readonly sent: string[] = [];
  handler: ((buildId: string) => Promise<void>) | null = null;

  async send(buildId: string) { this.sent.push(buildId); }
  async start(handler: (buildId: string) => Promise<void>) { this.handler = handler; }
  async stop() { this.handler = null; }
}

function input(repositoryId = "repo-1") {
  return {
    workspaceId: "workspace-1",
    repositoryId,
    snapshotId: "snapshot-1",
    snapshotPath: fixtureRoot,
    commitSha: "c".repeat(40)
  };
}

describe("BuildService", () => {
  test("runs the durable state machine and persists validated knowledge", async () => {
    const persistence = new FakeBuildPersistence();
    const service = new BuildService(persistence, new FakeQueue());
    const events: string[] = [];
    service.subscribe("build-1", (event) => events.push(event.status));

    const { build } = await service.startBuild(input());
    await service.process(build.id);

    expect(persistence.transitions).toEqual([
      "queued", "syncing", "parsing", "synthesizing", "validating", "ready"
    ]);
    expect(persistence.knowledge).toHaveLength(1);
    expect(events).toEqual(["queued", "syncing", "parsing", "synthesizing", "validating", "ready"]);
  });

  test("returns the active build instead of enqueueing a second repository build", async () => {
    const persistence = new FakeBuildPersistence();
    const queue = new FakeQueue();
    const service = new BuildService(persistence, queue);

    const first = await service.startBuild(input());
    const second = await service.startBuild({ ...input(), snapshotId: "snapshot-2" });

    expect(first.created).toBe(true);
    expect(second).toEqual({ build: first.build, created: false });
    expect(queue.sent).toEqual([first.build.id]);
  });

  test("honors cancellation between stages and leaves the current release unchanged", async () => {
    const persistence = new FakeBuildPersistence();
    const service = new BuildService(persistence, new FakeQueue(), {
      analyze: async (...args) => {
        await service.cancelBuild("workspace-1", "build-1");
        const { analyzeSnapshot } = await import("./intelligence");
        return analyzeSnapshot(...args);
      }
    });

    const { build } = await service.startBuild(input());
    await service.process(build.id);

    expect(build.status).toBe("failed");
    expect(build.errorMessage).toBe("Build cancelled");
    expect(persistence.knowledge).toHaveLength(0);
    expect(persistence.currentReleaseId).toBe("release-current");
  });

  test("marks failures without persisting knowledge or changing a release", async () => {
    const persistence = new FakeBuildPersistence();
    const service = new BuildService(persistence, new FakeQueue(), {
      analyze: vi.fn(async () => { throw new Error("parse exploded"); })
    });
    const { build } = await service.startBuild(input());

    await service.process(build.id);

    expect(build.status).toBe("failed");
    expect(build.errorMessage).toBe("parse exploded");
    expect(persistence.currentReleaseId).toBe("release-current");
  });

  test("re-enqueues recoverable unfinished builds and fails missing snapshots", async () => {
    const persistence = new FakeBuildPersistence();
    const queue = new FakeQueue();
    const service = new BuildService(persistence, queue);
    const recoverable = (await persistence.createBuild(input())).build;
    const missing = (await persistence.createBuild({ ...input("repo-2"), snapshotPath: "/missing" })).build;

    await service.recover();

    expect(queue.sent).toContain(recoverable.id);
    expect(missing.status).toBe("failed");
    expect(missing.errorMessage).toMatch(/snapshot/i);
  });

  test("marks an interrupted claimed build failed during restart recovery", async () => {
    const persistence = new FakeBuildPersistence();
    const queue = new FakeQueue();
    const service = new BuildService(persistence, queue);
    const interrupted = (await persistence.createBuild(input())).build;
    await persistence.claimBuild(interrupted.id);
    await persistence.transitionBuild(interrupted.id, "syncing", "parsing");

    await service.recover();

    expect(interrupted.status).toBe("failed");
    expect(interrupted.errorMessage).toMatch(/restart/i);
    expect(queue.sent).not.toContain(interrupted.id);
  });

  test("claims a queued build exactly once under concurrent redelivery", async () => {
    const persistence = new FakeBuildPersistence();
    const analyze = vi.fn(async (...args: Parameters<typeof analyzeSnapshot>) => analyzeSnapshot(...args));
    const service = new BuildService(persistence, new FakeQueue(), { analyze });
    const { build } = await service.startBuild(input());

    await Promise.all([service.process(build.id), service.process(build.id)]);

    expect(analyze).toHaveBeenCalledOnce();
    expect(build.status).toBe("ready");
    expect(persistence.transitions.filter((status) => status === "syncing")).toHaveLength(1);
    expect(persistence.transitions.filter((status) => status === "ready")).toHaveLength(1);
  });

  test("a stale worker cannot mark a ready build failed", async () => {
    const persistence = new FakeBuildPersistence();
    const service = new BuildService(persistence, new FakeQueue(), {
      analyze: vi.fn(async () => {
        persistence.builds[0].status = "ready";
        throw new Error("late worker failure");
      })
    });
    const { build } = await service.startBuild(input());

    await service.process(build.id);

    expect(build.status).toBe("ready");
    expect(build.errorMessage).toBeUndefined();
    expect(persistence.transitions.at(-1)).not.toBe("failed");
  });
});
