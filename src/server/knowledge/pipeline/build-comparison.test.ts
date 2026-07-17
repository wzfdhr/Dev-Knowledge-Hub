import { randomUUID } from "node:crypto";

import { expect, test } from "vitest";

import { buildKnowledgeKernelComparison, PipelineComparisonUnavailableError } from "./build-comparison";

const workspaceId = randomUUID();
const projectId = randomUUID();
const repositoryId = randomUUID();
const snapshotId = randomUUID();
const buildId = randomUUID();
const citation = {
  path: "src/math.ts", startLine: 1, endLine: 4, commitSha: "a".repeat(40), blobHash: "b".repeat(64)
};

test("compares persisted legacy and shadow outputs only within the build project", async () => {
  const artifact = (id: string, stage: string, kind: string) => ({
    id, workspaceId, projectId, snapshotId, buildId, stage, kind, schemaVersion: 1,
    inputDigest: "c".repeat(64), contentDigest: "d".repeat(64), storageKey: `project/${id}.json`,
    sourceRefs: [], producer: "deterministic", createdAt: new Date().toISOString()
  });
  const synthesis = artifact("synthesis", "synthesize", "knowledge-pages");
  const quality = artifact("quality", "lint", "knowledge-quality");
  const store = {
    getBuild: async () => ({ id: buildId, workspaceId, repositoryId, snapshotId, commitSha: citation.commitSha }),
    getRepository: async () => ({ id: repositoryId, workspaceId, projectId }),
    listKnowledgePagesForBuild: async () => [{
      id: "page", workspaceId, repositoryId, buildId, slug: "math", title: "Math", body: "math",
      chunks: [{ id: "chunk", heading: null, content: "math", citations: [citation] }]
    }],
    knowledgeMetadataForBuild: async () => ({
      symbols: [{ name: "add", kind: "function", path: "src/math.ts", startLine: 1, endLine: 4, exported: true }],
      dependencies: []
    }),
    getKnowledgeGraph: async () => ({
      nodes: [
        { id: "module", projectId, snapshotId, kind: "module", name: "math.ts", qualifiedName: "src/math.ts", candidate: false, sourceRefs: [{ ...citation, snapshotId }], attributes: {} },
        { id: "symbol", projectId, snapshotId, kind: "symbol", name: "add", qualifiedName: "add", candidate: false, sourceRefs: [{ ...citation, snapshotId }], attributes: {} }
      ],
      edges: [{ id: "contains", fromNodeId: "module", toNodeId: "symbol", kind: "contains", candidate: false, confidence: 1, sourceRefs: [{ ...citation, snapshotId }] }]
    }),
    listPipelineSearchDocuments: async () => [{
      id: "document", workspaceId, projectId, snapshotId, buildId, sourceArtifactId: synthesis.id,
      documentKey: "math:0", kind: "page", title: "Math", content: "math", citations: [{ ...citation, snapshotId }], metadata: {}, createdAt: new Date()
    }],
    listPipelineStageRuns: async () => [
      { id: "synthesis-run", workspaceId, projectId, snapshotId, buildId, stage: "synthesize", attempt: 1, status: "succeeded", inputDigest: "e".repeat(64), outputManifestIds: [synthesis.id], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), errorCode: null, errorDetail: null },
      { id: "quality-run", workspaceId, projectId, snapshotId, buildId, stage: "lint", attempt: 1, status: "succeeded", inputDigest: "f".repeat(64), outputManifestIds: [quality.id], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), errorCode: null, errorDetail: null }
    ],
    findArtifactById: async (id: string) => id === synthesis.id ? synthesis : id === quality.id ? quality : null
  };
  const reader = {
    getJson: async (manifest: { id: string }) => manifest.id === synthesis.id
      ? { schemaVersion: 1, output: { pages: [{ id: "page", slug: "math", title: "Math", body: "math", citations: [citation], chunks: [{ id: "chunk", heading: null, content: "math", citations: [citation] }] }] } }
      : {
        trust: {
          targetKind: "knowledge", targetId: buildId, score: 0.95, citationScore: 1,
          parserScore: 1, freshnessScore: 1, lintPenalty: 0.05, reasons: ["fixture"]
        },
        issues: [{ id: "issue" }]
      }
  };

  const result = await buildKnowledgeKernelComparison({
    store: store as never, reader, workspaceId, projectId, buildId
  });

  expect(result.comparison.blockingDefects).toEqual([]);
  expect(result.comparison.citations.valid).toBe(true);
  expect(result.comparison.expectedImprovements).toEqual(expect.arrayContaining([
    expect.objectContaining({ area: "quality", key: "trust" })
  ]));
});

test("rejects a comparison request when the build repository belongs to another project", async () => {
  await expect(buildKnowledgeKernelComparison({
    store: {
      getBuild: async () => ({ id: buildId, workspaceId, repositoryId, snapshotId, commitSha: citation.commitSha }),
      getRepository: async () => ({ id: repositoryId, workspaceId, projectId: randomUUID() })
    } as never,
    reader: { getJson: async () => ({}) },
    workspaceId,
    projectId,
    buildId
  })).rejects.toBeInstanceOf(PipelineComparisonUnavailableError);
});
