import { describe, expect, test, vi } from "vitest";

import type { BuildRecord } from "../build-service";
import { knowledgeIrPipelineInputDigest } from "../pipeline/extract-stage";
import type { ArtifactManifest } from "../pipeline/contracts";
import type { PipelineStageRunRecord, SourceSnapshotRecord } from "../../persistence/store";
import { createFrontendModeStageInputPlanner } from "./shadow-stage";

const snapshot = {
  id: "snapshot-1",
  workspaceId: "workspace-1",
  repositoryId: "repository-1",
  commitSha: "a".repeat(40),
  ref: "main",
  remoteUrl: null,
  commitTimestamp: new Date("2026-07-18T00:00:00.000Z"),
  storagePath: "/tmp/snapshot"
} as SourceSnapshotRecord;

const build = {
  id: "build-1",
  workspaceId: "workspace-1",
  repositoryId: "repository-1",
  snapshotId: snapshot.id,
  purpose: { kind: "standard", feedbackIds: [] }
} as BuildRecord;

const convertRun = {
  id: "run-convert",
  workspaceId: "workspace-1",
  projectId: "project-1",
  snapshotId: snapshot.id,
  buildId: build.id,
  stage: "convert",
  attempt: 1,
  status: "succeeded",
  inputDigest: "input",
  outputManifestIds: ["normalized-1"],
  startedAt: null,
  finishedAt: null,
  errorCode: null,
  errorDetail: null
} as PipelineStageRunRecord;

const normalizedManifest = {
  id: "normalized-1",
  workspaceId: "workspace-1",
  projectId: "project-1",
  snapshotId: snapshot.id,
  buildId: build.id,
  stage: "convert",
  kind: "normalized-sources",
  schemaVersion: 1
} as ArtifactManifest;

describe("project frontend mode stage planning", () => {
  test("uses the persisted project mode only when leaving convert", async () => {
    const modeForProject = vi.fn().mockResolvedValue("legacy");
    const store = {
      findSnapshotById: vi.fn().mockResolvedValue(snapshot),
      listPipelineStageRuns: vi.fn().mockResolvedValue([convertRun]),
      findArtifactById: vi.fn().mockResolvedValue(normalizedManifest)
    };
    const planner = createFrontendModeStageInputPlanner(store as never, modeForProject);

    const digest = await planner.nextInputDigest({
      currentRun: convertRun,
      build,
      nextStage: "extract",
      outputManifestIds: convertRun.outputManifestIds
    });

    expect(digest).toBe(knowledgeIrPipelineInputDigest(snapshot, build.purpose, [normalizedManifest.id]));
    expect(modeForProject).toHaveBeenCalledWith("workspace-1", "project-1");
  });

  test("continues an existing family without consulting a changed project override", async () => {
    const modeForProject = vi.fn().mockResolvedValue("legacy");
    const frontendManifest = {
      ...normalizedManifest,
      id: "frontend-ir-1",
      stage: "extract",
      kind: "frontend-ir-v2",
      schemaVersion: 2
    } as ArtifactManifest;
    const legacyManifest = {
      ...normalizedManifest,
      id: "knowledge-ir-1",
      stage: "extract",
      kind: "knowledge-ir",
      schemaVersion: 1
    } as ArtifactManifest;
    const extractRun = {
      ...convertRun,
      id: "run-extract",
      stage: "extract",
      outputManifestIds: [legacyManifest.id, frontendManifest.id]
    } as PipelineStageRunRecord;
    const manifests = new Map([
      [normalizedManifest.id, normalizedManifest],
      [legacyManifest.id, legacyManifest],
      [frontendManifest.id, frontendManifest]
    ]);
    const store = {
      findSnapshotById: vi.fn().mockResolvedValue(snapshot),
      listPipelineStageRuns: vi.fn().mockResolvedValue([convertRun, extractRun]),
      findArtifactById: vi.fn((id: string) => Promise.resolve(manifests.get(id) ?? null))
    };
    const planner = createFrontendModeStageInputPlanner(store as never, modeForProject);

    await planner.nextInputDigest({
      currentRun: extractRun,
      build,
      nextStage: "tables",
      outputManifestIds: extractRun.outputManifestIds
    });

    expect(modeForProject).not.toHaveBeenCalled();
  });

  test("fails instead of silently downgrading when a persisted stage artifact is missing", async () => {
    const extractRun = {
      ...convertRun,
      id: "run-extract",
      stage: "extract",
      outputManifestIds: ["missing-artifact"]
    } as PipelineStageRunRecord;
    const planner = createFrontendModeStageInputPlanner({
      findSnapshotById: vi.fn().mockResolvedValue(snapshot),
      listPipelineStageRuns: vi.fn().mockResolvedValue([convertRun, extractRun]),
      findArtifactById: vi.fn().mockResolvedValue(null)
    } as never, vi.fn().mockResolvedValue("legacy"));

    await expect(planner.nextInputDigest({
      currentRun: extractRun,
      build,
      nextStage: "tables",
      outputManifestIds: extractRun.outputManifestIds
    })).rejects.toThrow("output manifest is unavailable");
  });
});
