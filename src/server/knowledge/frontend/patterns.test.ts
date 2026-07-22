import { describe, expect, test, vi } from "vitest";

import {
  extractObservedPatterns,
  indexPublishedFrontendPatternEvidence
} from "./patterns";

const ref = {
  snapshotId: "snapshot-1", path: "src/chart.tsx", startLine: 10, endLine: 18,
  blobHash: "a".repeat(64)
};

describe("observable frontend patterns", () => {
  test("extracts a cited chart drilldown fact without inventing a decision", () => {
    const entity = (id: string, kind: string, facets: Record<string, Record<string, unknown>>) => ({
      id, kind, facets, sourceRefs: [ref]
    });
    const chart = entity("chart", "visualization", { "visualization-core": { events: ["click"] } });
    const component = entity("component", "component", { "react-core": { component: true } });
    const graph = {
      schemaVersion: 2, snapshotId: "snapshot-1", analyzerManifestDigest: "b".repeat(64),
      nodes: [chart, component],
      edges: [{
        id: "edge", kind: "visualizes", evidenceClass: "fact", confidence: 1,
        fromEntityId: "component", toEntityId: "chart", sourceRefs: [ref]
      }]
    };
    const profile = {
      snapshotId: "snapshot-1", profileDigest: "c".repeat(64),
      analyzerManifestDigest: "b".repeat(64),
      framework: { state: "known", value: { name: "react", version: "19.0.0", supported: true } }
    };

    const artifact = extractObservedPatterns({ profile: profile as never, graph: graph as never, ir: { ...graph, entities: graph.nodes } as never });

    expect(artifact.candidates).toContainEqual(expect.objectContaining({
      capability: "chart_drilldown",
      evidenceType: "observed_fact",
      sourceRefs: [ref]
    }));
    expect(artifact.candidates[0]).not.toHaveProperty("selectedApproach");
    expect(artifact.candidates[0]!.groupKey).toMatch(/^[a-f0-9]{64}$/);
  });

  test("does not index an unverified upload as workspace evidence", async () => {
    const saveObservedPatternEvidence = vi.fn();
    const store = {
      getRelease: vi.fn(async () => ({
        id: "release-1", workspaceId: "workspace-1", repositoryId: "repository-1",
        snapshotId: "snapshot-1", releaseArtifactFamily: "frontend-v2",
        packageArtifactId: "package-1", publishedAt: new Date()
      })),
      getRepository: vi.fn(async () => ({
        id: "repository-1", workspaceId: "workspace-1", projectId: "project-1", kind: "upload"
      })),
      findSnapshotById: vi.fn(async () => ({
        id: "snapshot-1", workspaceId: "workspace-1", repositoryId: "repository-1",
        commitSha: "content-1", ref: "upload/content-1", remoteUrl: null,
        commitTimestamp: new Date(), storagePath: "/tmp/snapshot", sourceKind: "upload",
        gitCommitSha: null, contentVersion: "content-1", attestation: "unverified",
        linkedGitCommitSha: null, remoteIdentityDigest: null
      })),
      saveObservedPatternEvidence
    };

    await expect(indexPublishedFrontendPatternEvidence({
      store: store as never,
      reader: { getJson: vi.fn() },
      workspaceId: "workspace-1",
      releaseId: "release-1"
    })).resolves.toEqual({ indexed: 0, reason: "SOURCE_NOT_ELIGIBLE" });
    expect(saveObservedPatternEvidence).not.toHaveBeenCalled();
  });

  test("uses deterministic evidence identities when the same release is indexed again", async () => {
    const pattern = {
      candidateId: "d".repeat(64), groupKey: "e".repeat(64), capability: "chart_drilldown",
      evidenceType: "observed_fact", frameworkFamily: "react", relationKinds: ["visualizes"],
      staticFacetKeys: ["visualization-core.events"], observedFact: "Observed cited visualizes implementation relation",
      sourceRefs: [ref]
    };
    const packageValue = {
      schemaVersion: 2, family: "frontend-v2", stage: "package", snapshotId: "snapshot-1",
      analyzerManifestDigest: "b".repeat(64), upstreamManifestIds: ["validation-v1", "validation-v2"],
      sourceArtifactId: "package-v1", irSchemaVersion: 2, graphSchemaVersion: 2,
      projectProfileArtifactId: "profile", projectProfileDigest: "c".repeat(64),
      patternCandidatesArtifactId: "patterns",
      artifacts: {
        convert: ["convert-v1"], extract: ["extract-v1", "extract-v2"],
        tables: ["tables-v1", "tables-v2"], graph: ["graph-v1", "graph-v2"],
        synthesize: ["synthesize-v1", "synthesize-v2", "profile"],
        index: ["index-v1", "index-v2", "patterns"], lint: ["lint-v1", "lint-v2"],
        viz: ["viz-v1", "viz-v2"], validate: ["validation-v1", "validation-v2"],
        package: ["package-v1"]
      }
    };
    const manifests = new Map([
      ["package", { id: "package", kind: "frontend-pipeline-package", schemaVersion: 2, snapshotId: "snapshot-1" }],
      ["patterns", { id: "patterns", kind: "frontend-pattern-candidates", schemaVersion: 1, snapshotId: "snapshot-1" }]
    ]);
    const saved = new Map<string, unknown>();
    const saveObservedPatternEvidence = vi.fn(async (input: { id: string }) => {
      saved.set(input.id, input);
      return { ...input, revokedAt: null, createdAt: new Date() };
    });
    const store = {
      getRelease: vi.fn(async () => ({
        id: "release-1", workspaceId: "workspace-1", repositoryId: "repository-1",
        snapshotId: "snapshot-1", releaseArtifactFamily: "frontend-v2",
        packageArtifactId: "package", publishedAt: new Date()
      })),
      getRepository: vi.fn(async () => ({
        id: "repository-1", workspaceId: "workspace-1", projectId: "project-1", kind: "git",
        name: "Frontend", localPath: null, cloneUrl: "https://example.test/frontend.git",
        defaultBranch: "main", archivedAt: null, hasCredential: false
      })),
      findSnapshotById: vi.fn(async () => ({
        id: "snapshot-1", workspaceId: "workspace-1", repositoryId: "repository-1",
        commitSha: "f".repeat(40), ref: "origin/main", remoteUrl: "https://example.test/frontend.git",
        commitTimestamp: new Date(), storagePath: "/tmp/snapshot", sourceKind: "git",
        gitCommitSha: "f".repeat(40), contentVersion: "1".repeat(40), attestation: null,
        linkedGitCommitSha: null, remoteIdentityDigest: "2".repeat(64)
      })),
      findArtifactById: vi.fn(async (id: string) => manifests.get(id) ?? null),
      saveObservedPatternEvidence
    };
    const reader = { getJson: vi.fn(async (manifest: { id: string }) => manifest.id === "package"
      ? packageValue
      : { schemaVersion: 1, snapshotId: "snapshot-1", analyzerManifestDigest: "b".repeat(64), profileDigest: "c".repeat(64), candidates: [pattern] }) };
    const input = { store: store as never, reader: reader as never, workspaceId: "workspace-1", releaseId: "release-1" };

    await expect(indexPublishedFrontendPatternEvidence(input)).resolves.toEqual({ indexed: 1 });
    await expect(indexPublishedFrontendPatternEvidence(input)).resolves.toEqual({ indexed: 1 });
    expect(saved.size).toBe(1);
    expect(saveObservedPatternEvidence.mock.calls[0]![0].id)
      .toBe(saveObservedPatternEvidence.mock.calls[1]![0].id);
  });
});
