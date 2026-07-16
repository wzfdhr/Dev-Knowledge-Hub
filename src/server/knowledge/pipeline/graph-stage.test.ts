import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ArtifactStore } from "./artifact-store";
import {
  createNormalizedSourcesStageExecutor,
  normalizedSourcesPipelineInputDigest
} from "./convert-stage";
import {
  createKnowledgeIrStageExecutor,
  knowledgeIrPipelineInputDigest
} from "./extract-stage";
import {
  createKnowledgeGraphStageExecutor,
  knowledgeGraphPipelineInputDigest,
  type KnowledgeGraphStageStore
} from "./graph-stage";
import {
  createTableSchemasStageExecutor,
  tableSchemasPipelineInputDigest
} from "./tables-stage";
import type { ArtifactManifest } from "./contracts";
import type { PipelineStageRunRecord } from "../../persistence/store";
import { MemoryAppStore } from "../../persistence/memory-store";

const directories: string[] = [];
type StageTestStore = KnowledgeGraphStageStore & Pick<MemoryAppStore, "listSnapshotFiles">;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function completedRun(
  run: PipelineStageRunRecord,
  outputManifestIds: string[],
  status: "succeeded" | "reused" | "failed" = "succeeded"
): PipelineStageRunRecord {
  return {
    ...run,
    status,
    outputManifestIds,
    finishedAt: status === "failed" ? null : "2026-07-16T00:00:01.000Z"
  };
}

function stageStore(
  store: MemoryAppStore,
  stageRuns: readonly PipelineStageRunRecord[],
  onSave?: () => void
): StageTestStore {
  const scoped = Object.create(store) as StageTestStore;
  scoped.findArtifactById = async (artifactId: string): Promise<ArtifactManifest | null> =>
    store.knowledgeArtifacts.find((candidate) => candidate.id === artifactId) ?? null;
  scoped.listPipelineStageRuns = async () => [...stageRuns];
  if (onSave) {
    scoped.saveKnowledgeGraph = async (input) => {
      onSave();
      await store.saveKnowledgeGraph(input);
    };
  }
  return scoped;
}

async function fixture() {
  const snapshotRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-graph-stage-snapshot-"));
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-graph-stage-artifacts-"));
  directories.push(snapshotRoot, artifactRoot);
  const files = {
    "src/app.ts": "import { helper } from './util';\nimport('./lazy');\nexport const answer = helper;\n",
    "src/util.ts": "export const helper = 42;\n",
    "src/lazy.ts": "export const lazy = true;\n"
  };
  await Promise.all(Object.entries(files).map(async ([filePath, content]) => {
    await mkdir(path.join(snapshotRoot, path.dirname(filePath)), { recursive: true });
    await writeFile(path.join(snapshotRoot, filePath), content);
  }));

  const store = new MemoryAppStore();
  const setup = await store.createInitialSetup("admin@example.com", "hash");
  const workspaceId = setup!.workspace.id;
  const project = (await store.listProjects(workspaceId))[0]!;
  const repository = await store.createRepository(workspaceId, { kind: "upload", name: "Source" }, project.id);
  const snapshot = await store.createSnapshot({
    snapshot: {
      id: "snapshot-1", workspaceId, repositoryId: repository!.id, commitSha: "a".repeat(40),
      ref: "main", remoteUrl: null, commitTimestamp: new Date("2026-07-16T00:00:00.000Z"), storagePath: snapshotRoot
    },
    files: Object.entries(files).map(([filePath, content]) => ({
      id: randomUUID(), workspaceId, snapshotId: "snapshot-1", path: filePath,
      byteSize: Buffer.byteLength(content), contentHash: hash(content), language: "typescript"
    }))
  });
  const { build } = await store.createBuild({
    workspaceId, repositoryId: repository!.id, snapshotId: snapshot.id,
    snapshotPath: snapshot.storagePath, commitSha: snapshot.commitSha
  });
  const artifactStore = new ArtifactStore(artifactRoot, store);
  await artifactStore.initialize();
  const snapshotFiles = await store.listSnapshotFiles(workspaceId, snapshot.id);
  const convertRun: PipelineStageRunRecord = {
    id: "convert-run", workspaceId, projectId: project.id, snapshotId: snapshot.id, buildId: build.id,
    stage: "convert", attempt: 1, status: "running",
    inputDigest: normalizedSourcesPipelineInputDigest(snapshot, snapshotFiles, build.purpose), outputManifestIds: [],
    startedAt: "2026-07-16T00:00:00.000Z", finishedAt: null, errorCode: null, errorDetail: null
  };
  const convert = await createNormalizedSourcesStageExecutor({ store, artifactStore })(convertRun);
  const convertComplete = completedRun(convertRun, convert.outputManifestIds!, "reused");
  const extractRun: PipelineStageRunRecord = {
    ...convertRun,
    id: "extract-run",
    stage: "extract",
    outputManifestIds: [],
    inputDigest: knowledgeIrPipelineInputDigest(snapshot, build.purpose, convert.outputManifestIds!)
  };
  const extract = await createKnowledgeIrStageExecutor({
    store: stageStore(store, [convertComplete]), artifactStore
  })(extractRun);
  const tablesRun: PipelineStageRunRecord = {
    ...convertRun,
    id: "tables-run",
    stage: "tables",
    outputManifestIds: [],
    inputDigest: tableSchemasPipelineInputDigest(snapshot, build.purpose, convert.outputManifestIds!)
  };
  const tables = await createTableSchemasStageExecutor({
    store: stageStore(store, [convertComplete]), artifactStore
  })(tablesRun);
  const extractComplete = completedRun(extractRun, extract.outputManifestIds!, "reused");
  const tablesComplete = completedRun(tablesRun, tables.outputManifestIds!);
  const upstreamManifestIds = [...extract.outputManifestIds!, ...tables.outputManifestIds!];
  const graphRun: PipelineStageRunRecord = {
    ...convertRun,
    id: "graph-run",
    stage: "graph",
    outputManifestIds: [],
    inputDigest: knowledgeGraphPipelineInputDigest(snapshot, build.purpose, upstreamManifestIds)
  };

  return {
    artifactStore, build, extractComplete, graphRun, project, snapshot, store, tablesComplete, upstreamManifestIds, workspaceId
  };
}

describe("knowledge graph pipeline stage", () => {
  test("writes a deterministic graph artifact and persists fact and candidate edges once", async () => {
    const prepared = await fixture();
    let saves = 0;
    const execute = createKnowledgeGraphStageExecutor({
      store: stageStore(prepared.store, [prepared.extractComplete, prepared.tablesComplete], () => { saves += 1; }),
      artifactStore: prepared.artifactStore
    });

    const first = await execute(prepared.graphRun);

    expect(first).toEqual({ outputManifestIds: [expect.any(String)], reused: false });
    const artifact = prepared.store.knowledgeArtifacts.find((candidate) => candidate.id === first.outputManifestIds![0])!;
    expect(artifact).toMatchObject({ stage: "graph", kind: "knowledge-graph", producer: "deterministic" });
    const graph = await prepared.artifactStore.getJson(artifact) as { nodes: unknown[]; edges: Array<{ candidate: boolean; candidateReason?: string; kind: string }> };
    expect(graph.nodes).not.toHaveLength(0);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "imports", candidate: false }),
      expect.objectContaining({ kind: "imports", candidate: true, candidateReason: "dynamic_import" })
    ]));
    await expect(prepared.store.getKnowledgeGraph(prepared.workspaceId, prepared.project.id, prepared.build.id)).resolves.toEqual({
      nodes: graph.nodes,
      edges: graph.edges
    });

    await expect(execute(prepared.graphRun)).resolves.toEqual({ outputManifestIds: first.outputManifestIds, reused: true });
    expect(saves).toBe(1);
  });

  test("rejects graph runs from another project or snapshot", async () => {
    const prepared = await fixture();
    const execute = createKnowledgeGraphStageExecutor({
      store: stageStore(prepared.store, [prepared.extractComplete, prepared.tablesComplete]), artifactStore: prepared.artifactStore
    });

    await expect(execute({ ...prepared.graphRun, projectId: "other-project" }))
      .rejects.toThrow("does not match the project build and snapshot");
    await expect(execute({ ...prepared.graphRun, snapshotId: "other-snapshot" }))
      .rejects.toThrow("does not match the project build and snapshot");
  });

  test("rejects failed extract or tables upstream runs", async () => {
    const prepared = await fixture();
    const execute = (runs: readonly PipelineStageRunRecord[]) => createKnowledgeGraphStageExecutor({
      store: stageStore(prepared.store, runs), artifactStore: prepared.artifactStore
    });

    await expect(execute([
      completedRun(prepared.extractComplete, prepared.extractComplete.outputManifestIds, "failed"),
      prepared.tablesComplete
    ])(prepared.graphRun)).rejects.toThrow("requires a succeeded or reused extract run");
    await expect(execute([
      prepared.extractComplete,
      completedRun(prepared.tablesComplete, prepared.tablesComplete.outputManifestIds, "failed")
    ])(prepared.graphRun)).rejects.toThrow("requires a succeeded or reused tables run");
  });

  test("reuses an existing graph artifact for identical extract and tables manifests", async () => {
    const prepared = await fixture();
    const execute = createKnowledgeGraphStageExecutor({
      store: stageStore(prepared.store, [prepared.extractComplete, prepared.tablesComplete]), artifactStore: prepared.artifactStore
    });

    const first = await execute(prepared.graphRun);
    const second = await execute(prepared.graphRun);

    expect(first).toEqual({ outputManifestIds: [expect.any(String)], reused: false });
    expect(second).toEqual({ outputManifestIds: first.outputManifestIds, reused: true });
  });
});
