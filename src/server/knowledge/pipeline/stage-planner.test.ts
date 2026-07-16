import { randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import { knowledgeIrPipelineInputDigest } from "./extract-stage";
import { knowledgeGraphPipelineInputDigest } from "./graph-stage";
import { createB02StageInputPlanner } from "./stage-planner";
import { knowledgeSynthesisPipelineInputDigest } from "./synthesize-stage";
import { pipelineSearchIndexInputDigest } from "./index-stage";
import { tableSchemasPipelineInputDigest } from "./tables-stage";
import type { PipelineStageRunRecord } from "../../persistence/store";
import { MemoryAppStore } from "../../persistence/memory-store";

function completed(run: PipelineStageRunRecord, outputManifestIds: string[]): PipelineStageRunRecord {
  return { ...run, status: "succeeded", outputManifestIds, finishedAt: "2026-07-16T00:00:01.000Z" };
}

describe("B02 stage input planner", () => {
  test("derives downstream digests from the stage-specific persisted artifacts", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const workspaceId = setup!.workspace.id;
    const project = (await store.listProjects(workspaceId))[0]!;
    const repository = await store.createRepository(workspaceId, { kind: "upload", name: "Source" }, project.id);
    const snapshot = await store.createSnapshot({
      snapshot: {
        id: randomUUID(), workspaceId, repositoryId: repository!.id, commitSha: "a".repeat(40),
        ref: "main", remoteUrl: null, commitTimestamp: new Date("2026-07-16T00:00:00.000Z"), storagePath: "/tmp/snapshot"
      },
      files: []
    });
    const { build } = await store.createBuild({
      workspaceId, repositoryId: repository!.id, snapshotId: snapshot.id,
      snapshotPath: snapshot.storagePath, commitSha: snapshot.commitSha
    });
    const base: PipelineStageRunRecord = {
      id: "convert-run", workspaceId, projectId: project.id, snapshotId: snapshot.id, buildId: build.id,
      stage: "convert", attempt: 1, status: "running", inputDigest: "b".repeat(64), outputManifestIds: [],
      startedAt: "2026-07-16T00:00:00.000Z", finishedAt: null, errorCode: null, errorDetail: null
    };
    const runs: PipelineStageRunRecord[] = [completed(base, ["convert-artifact"])];
    const scoped = Object.create(store) as MemoryAppStore & {
      listPipelineStageRuns: () => Promise<PipelineStageRunRecord[]>;
    };
    scoped.listPipelineStageRuns = async () => [...runs];
    const planner = createB02StageInputPlanner(scoped);

    await expect(planner.nextInputDigest({
      currentRun: base,
      build,
      nextStage: "extract",
      outputManifestIds: ["convert-artifact"]
    })).resolves.toBe(knowledgeIrPipelineInputDigest(snapshot, build.purpose, ["convert-artifact"]));

    const extract = completed({ ...base, id: "extract-run", stage: "extract" }, ["extract-artifact"]);
    runs.push(extract);
    await expect(planner.nextInputDigest({
      currentRun: extract,
      build,
      nextStage: "tables",
      outputManifestIds: extract.outputManifestIds
    })).resolves.toBe(tableSchemasPipelineInputDigest(snapshot, build.purpose, ["convert-artifact"]));

    const tables = completed({ ...base, id: "tables-run", stage: "tables" }, ["tables-artifact"]);
    runs.push(tables);
    await expect(planner.nextInputDigest({
      currentRun: tables,
      build,
      nextStage: "graph",
      outputManifestIds: tables.outputManifestIds
    })).resolves.toBe(knowledgeGraphPipelineInputDigest(
      snapshot,
      build.purpose,
      ["extract-artifact", "tables-artifact"]
    ));

    const graph = completed({ ...base, id: "graph-run", stage: "graph" }, ["graph-artifact"]);
    runs.push(graph);
    await expect(planner.nextInputDigest({
      currentRun: graph,
      build,
      nextStage: "synthesize",
      outputManifestIds: graph.outputManifestIds
    })).resolves.toBe(knowledgeSynthesisPipelineInputDigest(snapshot, build.purpose, ["graph-artifact"]));

    const synthesize = completed({ ...base, id: "synthesize-run", stage: "synthesize" }, ["pages-artifact"]);
    runs.push(synthesize);
    await expect(planner.nextInputDigest({
      currentRun: synthesize,
      build,
      nextStage: "index",
      outputManifestIds: synthesize.outputManifestIds
    })).resolves.toBe(pipelineSearchIndexInputDigest(snapshot, build.purpose, ["pages-artifact"]));
  });
});
