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
const casesPath = path.join(root, "evaluation/knowledge-v2/cases.jsonl");
const commitSha = "e".repeat(40);

const cases = parseRetrievalCases(await readFile(casesPath, "utf8"));
const store = new MemoryAppStore();
const setup = await store.createInitialSetup("evaluation@example.com", "hash");
const fixtureRoots = {
  "fixture-a": path.join(root, "src/test/fixtures/code-intelligence"),
  "fixture-b": path.join(root, "src/test/fixtures/knowledge-evaluation-b")
};

const fixtures = new Map();
for (const [name, fixtureRoot] of Object.entries(fixtureRoots)) {
  const project = await store.createProject(setup.workspace.id, {
    name: `Knowledge evaluation ${name}`,
    slug: name
  }, setup.admin.id);
  if (!project) throw new Error(`Unable to create evaluation project for ${name}`);
  const repository = await store.createRepository(setup.workspace.id, {
    kind: "local", name: `Knowledge evaluation ${name}`, path: fixtureRoot
  }, project.id);
  if (!repository) throw new Error(`Unable to create evaluation repository for ${name}`);
  const build = (await store.createBuild({
    workspaceId: setup.workspace.id,
    repositoryId: repository.id,
    snapshotId: `knowledge-v2-${name}-snapshot`,
    snapshotPath: fixtureRoot,
    commitSha
  })).build;
  const index = await analyzeSnapshot(fixtureRoot, commitSha);
  await store.saveKnowledge({ build, index, output: await generateKnowledge(index) });
  await store.transitionBuild(build.id, "queued", "ready");
  const release = await store.createReleaseDraft(setup.workspace.id, repository.id, build.id, `knowledge-v2-${name}`);
  await store.publishRelease(setup.workspace.id, release.id);
  fixtures.set(name, { repository, release });
}

const metrics = await evaluateRetrievalCases(cases, (item) => {
  const fixture = fixtures.get(item.project);
  if (!fixture) throw new Error(`Unknown evaluation fixture project: ${item.project}`);
  return store.searchKnowledge(setup.workspace.id, fixture.repository.id, item.query, fixture.release.id);
});

console.log(JSON.stringify({ dataset: "knowledge-v2", fixtures: [...fixtures.keys()], metrics }, null, 2));
