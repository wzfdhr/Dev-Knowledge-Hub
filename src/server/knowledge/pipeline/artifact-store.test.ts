import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ArtifactStore, ArtifactStoreCancelledError, ArtifactStoreIntegrityError } from "./artifact-store";
import type { ArtifactManifest } from "./contracts";
import type { PipelineArtifactStore } from "../../persistence/store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function manifest(input: Partial<ArtifactManifest> = {}): ArtifactManifest {
  return {
    id: randomUUID(), workspaceId: "workspace-1", projectId: "project-1", snapshotId: "snapshot-1", buildId: "build-1",
    stage: "extract", kind: "knowledge-ir", schemaVersion: 1, inputDigest: "a".repeat(64), contentDigest: "b".repeat(64),
    storageKey: "unused", sourceRefs: [], producer: "deterministic", createdAt: "2026-07-14T00:00:00.000Z", ...input
  };
}

function persistence(): PipelineArtifactStore {
  const artifacts: ArtifactManifest[] = [];
  return {
    createStageRun: vi.fn(), claimNextStageRun: vi.fn(), transitionStageRun: vi.fn(),
    findReusableArtifact: vi.fn(async (_workspaceId, projectId, snapshotId, stage, kind, inputDigest) =>
      artifacts.find((artifact) => artifact.projectId === projectId && artifact.snapshotId === snapshotId
        && artifact.stage === stage && artifact.kind === kind && artifact.inputDigest === inputDigest) ?? null),
    createArtifactWithAudit: vi.fn(async (value: ArtifactManifest) => {
      const existing = artifacts.find((artifact) => artifact.projectId === value.projectId && artifact.snapshotId === value.snapshotId
        && artifact.stage === value.stage && artifact.kind === value.kind && artifact.inputDigest === value.inputDigest);
      if (existing) return existing;
      artifacts.push(value);
      return value;
    })
  } as unknown as PipelineArtifactStore;
}

async function root() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devkh-artifact-store-"));
  directories.push(directory);
  return directory;
}

describe("ArtifactStore", () => {
  test("writes canonical JSON once and assigns a content-addressed project key", async () => {
    const store = new ArtifactStore(await root(), persistence());
    const first = await store.putJson({ manifest: manifest(), value: { z: [2, 1], a: { b: true } } });
    const second = await store.putJson({ manifest: manifest(), value: { a: { b: true }, z: [2, 1] } });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(first.manifest.storageKey).toBe(second.manifest.storageKey);
    expect(first.manifest.storageKey).toMatch(/^project-1\/snapshot-1\/extract\/[a-f0-9]{64}\.json$/);
    expect(JSON.parse(await readFile(path.join(store.root, first.manifest.storageKey), "utf8"))).toEqual({ a: { b: true }, z: [2, 1] });
  });

  test("does not reuse artifacts across projects and rejects a cancelled write before manifest creation", async () => {
    const database = persistence();
    const store = new ArtifactStore(await root(), database);
    const controller = new AbortController();
    controller.abort();

    await expect(store.putJson({ manifest: manifest(), value: { answer: 42 }, signal: controller.signal }))
      .rejects.toBeInstanceOf(ArtifactStoreCancelledError);
    expect(database.createArtifactWithAudit).not.toHaveBeenCalled();
    const first = await store.putJson({ manifest: manifest(), value: { answer: 42 } });
    const second = await store.putJson({ manifest: manifest({ projectId: "project-2" }), value: { answer: 42 } });
    expect(first.manifest.storageKey).not.toBe(second.manifest.storageKey);
    expect(database.findReusableArtifact).toHaveBeenCalledWith(
      "workspace-1", "project-2", "snapshot-1", "extract", "knowledge-ir", "a".repeat(64)
    );
  });

  test("does not create a manifest when the artifact directory cannot be written", async () => {
    const directory = await root();
    const blockedPath = path.join(directory, "blocked");
    await writeFile(blockedPath, "not a directory");
    const database = persistence();
    const store = new ArtifactStore(blockedPath, database);

    await expect(store.putJson({ manifest: manifest(), value: { answer: 42 } })).rejects.toBeDefined();
    expect(database.createArtifactWithAudit).not.toHaveBeenCalled();
  });

  test("rejects storage-key traversal and content hash mismatches", async () => {
    const store = new ArtifactStore(await root(), persistence());
    const saved = await store.putJson({ manifest: manifest(), value: { answer: 42 } });
    await writeFile(path.join(store.root, saved.manifest.storageKey), "{\"answer\":43}\n");

    await expect(store.getJson(saved.manifest)).rejects.toBeInstanceOf(ArtifactStoreIntegrityError);
    await expect(store.getJson({ ...saved.manifest, storageKey: "../outside.json" }))
      .rejects.toBeInstanceOf(ArtifactStoreIntegrityError);
  });
});
