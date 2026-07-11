import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test, vi } from "vitest";

import {
  BuildService,
  type BuildJobQueue,
  type BuildPersistence,
  type BuildRecord,
  type PersistedKnowledge
} from "./build-service";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/code-intelligence"
);

class FakeBuildPersistence implements BuildPersistence {
  readonly builds: BuildRecord[] = [];
  readonly transitions: string[] = [];
  readonly knowledge: PersistedKnowledge[] = [];
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
    return { build, created: true };
  }

  async getBuild(workspaceId: string, buildId: string) {
    return this.builds.find((build) => build.workspaceId === workspaceId && build.id === buildId) ?? null;
  }

  async transitionBuild(buildId: string, status: BuildRecord["status"], details?: {
    errorMessage?: string;
    warnings?: BuildRecord["warnings"];
  }) {
    const build = this.builds.find((candidate) => candidate.id === buildId)!;
    build.status = status;
    if (details?.errorMessage) build.errorMessage = details.errorMessage;
    if (details?.warnings) build.warnings = details.warnings;
    this.transitions.push(status);
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
  async listBuildEvents() { return []; }
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
});
