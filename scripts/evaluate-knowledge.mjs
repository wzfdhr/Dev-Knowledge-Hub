import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeSnapshot } from "../src/server/knowledge/intelligence.ts";
import { generateKnowledge } from "../src/server/knowledge/generator.ts";
import {
  evaluateRetrievalCases,
  parseRetrievalCases
} from "../src/server/knowledge/retrieval-evaluation-v2.ts";
import { MemoryAppStore } from "../src/server/persistence/memory-store.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(root, "src/test/fixtures/code-intelligence");
const casesPath = path.join(root, "evaluation/knowledge-v2/cases.jsonl");
const commitSha = "e".repeat(40);

const cases = parseRetrievalCases(await readFile(casesPath, "utf8"));
const store = new MemoryAppStore();
const setup = await store.createInitialSetup("evaluation@example.com", "hash");
const repository = await store.createRepository(setup.workspace.id, {
  kind: "local", name: "Knowledge evaluation fixture", path: fixtureRoot
});
const build = (await store.createBuild({
  workspaceId: setup.workspace.id,
  repositoryId: repository.id,
  snapshotId: "knowledge-v2-evaluation-snapshot",
  snapshotPath: fixtureRoot,
  commitSha
})).build;
const index = await analyzeSnapshot(fixtureRoot, commitSha);
await store.saveKnowledge({ build, index, output: await generateKnowledge(index) });
await store.transitionBuild(build.id, "queued", "ready");
const release = await store.createReleaseDraft(setup.workspace.id, repository.id, build.id, "knowledge-v2-evaluation");
await store.publishRelease(setup.workspace.id, release.id);

const metrics = await evaluateRetrievalCases(cases, (item) => {
  if (item.project !== "fixture-a") throw new Error(`Unknown evaluation fixture project: ${item.project}`);
  return store.searchKnowledge(setup.workspace.id, repository.id, item.query, release.id);
});

console.log(JSON.stringify({ dataset: "knowledge-v2", fixture: "fixture-a", metrics }, null, 2));
