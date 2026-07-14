import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, test } from "vitest";

import { generateKnowledge } from "./generator";
import { analyzeSnapshot } from "./intelligence";
import { MemoryAppStore } from "../persistence/memory-store";

interface RetrievalCase {
  id: string;
  query: string;
  expectedTitle?: string;
  expectNoResults?: boolean;
}

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/code-intelligence");
const casesPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../evaluation/retrieval-cases.v1.json");

async function evaluationCases(): Promise<RetrievalCase[]> {
  return JSON.parse(await readFile(casesPath, "utf8")) as RetrievalCase[];
}

describe("versioned retrieval evaluation", () => {
  let store: MemoryAppStore;
  let workspaceId: string;
  let repositoryId: string;
  let releaseId: string;
  let commitSha: string;

  beforeEach(async () => {
    store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    workspaceId = setup!.workspace.id;
    repositoryId = (await store.createRepository(workspaceId, {
      kind: "local", name: "Evaluation fixture", path: fixtureRoot
    }))!.id;
    commitSha = "e".repeat(40);
    const build = (await store.createBuild({
      workspaceId, repositoryId, snapshotId: "evaluation-snapshot", snapshotPath: fixtureRoot, commitSha
    })).build;
    const index = await analyzeSnapshot(fixtureRoot, commitSha);
    await store.saveKnowledge({ build, index, output: await generateKnowledge(index) });
    await store.transitionBuild(build.id, "queued", "ready");
    const release = await store.createReleaseDraft(workspaceId, repositoryId, build.id, "evaluation-v1");
    await store.publishRelease(workspaceId, release.id);
    releaseId = release.id;
  });

  test("keeps Recall@5, MRR, citation validity, and no-result precision at the versioned baseline", async () => {
    const cases = await evaluationCases();
    let reciprocalRank = 0;
    let recalls = 0;
    let citations = 0;
    let validCitations = 0;
    let expectedResultCases = 0;
    let noResultCases = 0;
    let invalidNoResultHits = 0;

    for (const item of cases) {
      const results = await store.searchKnowledge(workspaceId, repositoryId, item.query, releaseId);
      if (item.expectNoResults) {
        noResultCases += 1;
        if (results.length) invalidNoResultHits += 1;
        continue;
      }
      expect(item.expectedTitle, `${item.id} must define an expected title`).toBeTruthy();
      expectedResultCases += 1;
      const rank = results.findIndex((result) => result.title === item.expectedTitle);
      if (rank >= 0 && rank < 5) recalls += 1;
      if (rank >= 0) reciprocalRank += 1 / (rank + 1);
      for (const citation of results.flatMap((result) => result.citations)) {
        citations += 1;
        if (citation.commitSha === commitSha && citation.startLine >= 1 && citation.endLine >= citation.startLine) {
          validCitations += 1;
        }
      }
    }

    const recallAt5 = recalls / expectedResultCases;
    const mrr = reciprocalRank / expectedResultCases;
    const citationValidity = citations === 0 ? 0 : validCitations / citations;
    const invalidHitRate = noResultCases === 0 ? 0 : invalidNoResultHits / noResultCases;
    expect({ recallAt5, mrr, citationValidity, invalidHitRate }).toEqual({
      recallAt5: 1, mrr: 1, citationValidity: 1, invalidHitRate: 0
    });
  });
});
