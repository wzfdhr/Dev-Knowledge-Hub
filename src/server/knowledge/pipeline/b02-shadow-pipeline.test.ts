import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ArtifactStore } from "./artifact-store";
import { createNormalizedSourcesStageExecutor, normalizedSourcesPipelineInputDigest } from "./convert-stage";
import { createKnowledgeIrStageExecutor } from "./extract-stage";
import { createKnowledgeGraphStageExecutor } from "./graph-stage";
import { createPipelineStageExecutor } from "./stage-executor";
import { createB02StageInputPlanner } from "./stage-planner";
import { createKnowledgeSynthesisStageExecutor } from "./synthesize-stage";
import { createTableSchemasStageExecutor } from "./tables-stage";
import { PipelineStageWorker, type PipelineStageJob, type PipelineStageJobQueue } from "./worker";
import type { ArtifactManifest } from "./contracts";
import { MemoryAppStore } from "../../persistence/memory-store";
import type { PipelineArtifactStore } from "../../persistence/store";

const directories: string[] = [];

class FakeQueue implements PipelineStageJobQueue {
  readonly sent: PipelineStageJob[] = [];
  async send(job: PipelineStageJob): Promise<void> { this.sent.push(job); }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

type PipelineStore = MemoryAppStore & PipelineArtifactStore & {
  findArtifactById(artifactId: string): Promise<ArtifactManifest | null>;
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("B02 shadow pipeline", () => {
  test("persists all deterministic stages and a project-scoped graph", async () => {
    const snapshotRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-b02-snapshot-"));
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-b02-artifacts-"));
    directories.push(snapshotRoot, artifactRoot);
    const sourcePath = "src/app.ts";
    const source = "export const answer = 42;\n";
    await mkdir(path.join(snapshotRoot, "src"), { recursive: true });
    await writeFile(path.join(snapshotRoot, sourcePath), source);

    const store = new MemoryAppStore() as PipelineStore;
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const workspaceId = setup!.workspace.id;
    const project = (await store.listProjects(workspaceId))[0]!;
    const repository = await store.createRepository(workspaceId, { kind: "upload", name: "Source" }, project.id);
    const snapshotId = randomUUID();
    const snapshot = await store.createSnapshot({
      snapshot: {
        id: snapshotId, workspaceId, repositoryId: repository!.id, commitSha: "a".repeat(40),
        ref: "main", remoteUrl: null, commitTimestamp: new Date("2026-07-16T00:00:00.000Z"), storagePath: snapshotRoot
      },
      files: [{
        id: randomUUID(), workspaceId, snapshotId, path: sourcePath,
        byteSize: Buffer.byteLength(source), contentHash: hash(source), language: "typescript"
      }]
    });
    const { build } = await store.createBuild({
      workspaceId, repositoryId: repository!.id, snapshotId: snapshot.id,
      snapshotPath: snapshot.storagePath, commitSha: snapshot.commitSha
    });
    const artifactStore = new ArtifactStore(artifactRoot, store);
    await artifactStore.initialize();
    const queue = new FakeQueue();
    const worker = new PipelineStageWorker(
      store,
      queue,
      createPipelineStageExecutor({
        convert: createNormalizedSourcesStageExecutor({ store, artifactStore }),
        extract: createKnowledgeIrStageExecutor({ store, artifactStore }),
        tables: createTableSchemasStageExecutor({ store, artifactStore }),
        graph: createKnowledgeGraphStageExecutor({ store, artifactStore }),
        synthesize: createKnowledgeSynthesisStageExecutor({ store, artifactStore })
      }),
      ["convert", "extract", "tables", "graph", "synthesize"],
      5_000,
      createB02StageInputPlanner(store)
    );
    const files = await store.listSnapshotFiles(workspaceId, snapshot.id);
    await worker.schedule({
      workspaceId, projectId: project.id, snapshotId: snapshot.id, buildId: build.id,
      inputDigest: normalizedSourcesPipelineInputDigest(snapshot, files, build.purpose)
    });

    for (let index = 0; index < queue.sent.length; index += 1) {
      await worker.process(queue.sent[index]!);
    }

    const runs = await store.listPipelineStageRuns(workspaceId, project.id, build.id);
    expect(runs.find((run) => run.stage === "extract")?.errorDetail).toBeNull();
    expect(runs.map((run) => [run.stage, run.status])).toEqual([
      ["convert", "succeeded"], ["extract", "succeeded"], ["tables", "succeeded"], ["graph", "succeeded"],
      ["synthesize", "succeeded"]
    ]);
    await expect(store.getKnowledgeGraph(workspaceId, project.id, build.id)).resolves.toMatchObject({
      nodes: expect.arrayContaining([expect.objectContaining({
        kind: "module", name: "app.ts", qualifiedName: sourcePath
      })])
    });
  });
});
