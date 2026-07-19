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
import type { PipelineStageRunRecord } from "../../persistence/store";
import { MemoryAppStore } from "../../persistence/memory-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(files: Record<string, string>) {
  const snapshotRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-convert-stage-snapshot-"));
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-convert-stage-artifacts-"));
  directories.push(snapshotRoot, artifactRoot);
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
      byteSize: Buffer.byteLength(content), contentHash: hash(content), language: null
    }))
  });
  const { build } = await store.createBuild({
    workspaceId, repositoryId: repository!.id, snapshotId: snapshot.id,
    snapshotPath: snapshot.storagePath, commitSha: snapshot.commitSha
  });
  const snapshotFiles = await store.listSnapshotFiles(workspaceId, snapshot.id);
  const inputDigest = normalizedSourcesPipelineInputDigest(snapshot, snapshotFiles, build.purpose);
  const artifactStore = new ArtifactStore(artifactRoot, store);
  await artifactStore.initialize();
  const run: PipelineStageRunRecord = {
    id: "run-1", workspaceId, projectId: project.id, snapshotId: snapshot.id, buildId: build.id,
    stage: "convert", attempt: 1, status: "running", inputDigest, outputManifestIds: [],
    startedAt: "2026-07-16T00:00:00.000Z", finishedAt: null, errorCode: null, errorDetail: null
  };

  return { artifactStore, build, files: snapshotFiles, project, repository: repository!, run, snapshot, snapshotRoot, store };
}

describe("normalized sources pipeline stage", () => {
  test("writes only supported text sources as a deterministic immutable artifact", async () => {
    const source = "export const answer = 42;\n";
    const readme = "# Runbook\n\nDeploy safely.\n";
    const yaml = "enabled: true\n";
    const prepared = await fixture({
      "src/app.ts": source,
      "README.md": readme,
      "config/app.yaml": yaml,
      ".env": "API_KEY=secret\n",
      "assets/logo.png": "not a PNG but unsupported"
    });
    const execute = createNormalizedSourcesStageExecutor({ store: prepared.store, artifactStore: prepared.artifactStore });

    const result = await execute(prepared.run);

    expect(result).toEqual({ outputManifestIds: [expect.any(String)], reused: false });
    expect(prepared.store.knowledgeArtifacts).toHaveLength(1);
    const artifact = prepared.store.knowledgeArtifacts[0]!;
    expect(artifact).toMatchObject({ stage: "convert", kind: "normalized-sources", producer: "deterministic" });
    await expect(prepared.artifactStore.getJson(artifact)).resolves.toEqual({
      schemaVersion: 1,
      snapshotId: prepared.snapshot.id,
      sources: [
        { snapshotId: prepared.snapshot.id, path: "README.md", content: readme, blobHash: hash(readme) },
        { snapshotId: prepared.snapshot.id, path: "config/app.yaml", content: yaml, blobHash: hash(yaml) },
        { snapshotId: prepared.snapshot.id, path: "src/app.ts", content: source, blobHash: hash(source) }
      ]
    });
  });

  test("keeps verified frontend text in normalized sources for the frontend-v2 analyzer family", async () => {
    const sources = {
      "src/App.vue": "<template><main /></template>\n",
      "src/index.html": "<main></main>\n",
      "src/app.css": ":root { --brand: blue; }\n",
      "src/theme.scss": "$brand: blue;\n",
      "src/theme.less": "@brand: blue;\n",
      "src/widget.svelte": "<main>Widget</main>\n",
      "src/page.astro": "---\nconst title = 'Page';\n---\n<main>{title}</main>\n",
      "public/icon.svg": "<svg viewBox=\"0 0 1 1\"></svg>\n"
    };
    const prepared = await fixture(sources);
    const execute = createNormalizedSourcesStageExecutor({ store: prepared.store, artifactStore: prepared.artifactStore });

    const result = await execute(prepared.run);
    const artifact = prepared.store.knowledgeArtifacts.find((candidate) => candidate.id === result.outputManifestIds![0])!;
    const value = await prepared.artifactStore.getJson(artifact) as { sources: Array<{ path: string }> };

    expect(value.sources.map((source) => source.path)).toEqual(Object.keys(sources).sort());
  });

  test("reuses the immutable artifact for the same owned run inputs", async () => {
    const prepared = await fixture({ "src/app.ts": "export const answer = 42;\n" });
    const execute = createNormalizedSourcesStageExecutor({ store: prepared.store, artifactStore: prepared.artifactStore });

    const first = await execute(prepared.run);
    const second = await execute(prepared.run);

    expect(first).toEqual({ outputManifestIds: [expect.any(String)], reused: false });
    expect(second).toEqual({ outputManifestIds: first.outputManifestIds, reused: true });
    expect(prepared.store.knowledgeArtifacts).toHaveLength(1);
  });

  test("rejects a run owned by another project or snapshot", async () => {
    const prepared = await fixture({ "src/app.ts": "export const answer = 42;\n" });
    const execute = createNormalizedSourcesStageExecutor({ store: prepared.store, artifactStore: prepared.artifactStore });
    const otherSnapshot = await prepared.store.createSnapshot({
      snapshot: {
        id: "snapshot-2", workspaceId: prepared.run.workspaceId, repositoryId: prepared.repository.id,
        commitSha: "b".repeat(40), ref: "other", remoteUrl: null,
        commitTimestamp: new Date("2026-07-16T00:00:00.000Z"), storagePath: prepared.snapshotRoot
      },
      files: []
    });

    await expect(execute({ ...prepared.run, projectId: "other-project" }))
      .rejects.toThrow("does not match the project build and snapshot");
    await expect(execute({ ...prepared.run, snapshotId: otherSnapshot.id }))
      .rejects.toThrow("does not match the project build and snapshot");
    expect(prepared.store.knowledgeArtifacts).toHaveLength(0);
  });

  test("rejects source contents that no longer match immutable snapshot metadata", async () => {
    const prepared = await fixture({ "src/app.ts": "export const answer = 42;\n" });
    const execute = createNormalizedSourcesStageExecutor({ store: prepared.store, artifactStore: prepared.artifactStore });
    await writeFile(path.join(prepared.snapshotRoot, "src", "app.ts"), "export const answer = 43;\n");

    await expect(execute(prepared.run)).rejects.toThrow("does not match persisted metadata");
    expect(prepared.store.knowledgeArtifacts).toHaveLength(0);
  });
});
