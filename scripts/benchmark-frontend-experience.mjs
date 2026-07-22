import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { queryExperienceProjection } from "../src/server/knowledge/frontend/experience-query.ts";
import { buildSolutionContext } from "../src/server/mcp/workspace-tools.ts";
import { MemoryAppStore } from "../src/server/persistence/memory-store.ts";

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)] ?? 0;
}

const citation = {
  snapshotId: "snapshot-prior", path: "src/chart.tsx", startLine: 1, endLine: 8,
  blobHash: "a".repeat(64)
};
const candidate = {
  experienceId: "experience-chart", capability: "chart_drilldown", state: "recommended",
  supersededById: null,
  evidence: [{
    id: "evidence-chart", projectId: "project-prior", releaseId: "release-prior",
    sourceEligibility: "git", title: "Prior chart drilldown",
    observedFact: "Observed cited chart drilldown implementation", contentVersion: "content-v1",
    citations: [citation], releasePublishedAt: new Date("2026-07-20T00:00:00.000Z"), fresh: true
  }],
  decisions: [{
    id: "decision-chart", decision: "approve", basisEvidenceIds: ["evidence-chart"],
    applicability: {
      required: [{ key: "framework.name", operator: "equals", value: "react" }],
      forbidden: [], preferred: [], unsupportedWhenUnknown: []
    },
    createdAt: new Date("2026-07-21T00:00:00.000Z")
  }],
  outcomes: [], standards: []
};
const profile = {
  framework: { state: "known", value: { name: "react", version: "19.2.0", supported: true } },
  rendering: { state: "known", value: { modes: ["csr"] } },
  tooling: { state: "known", value: { buildTools: ["vite"], configs: [] } }
};

async function measure(iterations, operation) {
  const durations = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    await operation();
    durations.push(performance.now() - startedAt);
  }
  return {
    iterations,
    p50Ms: Number(percentile(durations, 0.5).toFixed(3)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...durations).toFixed(3))
  };
}

const query = await measure(500, () => queryExperienceProjection({
  store: { listVisibleExperienceCandidates: async () => [candidate] },
  workspaceId: "workspace", userId: "member", currentProjectId: "project-current",
  currentProfile: profile, query: "chart drilldown"
}));

const store = new MemoryAppStore();
const setup = await store.createInitialSetup("staging-benchmark@example.invalid", "not-used");
const [project] = await store.listProjects(setup.workspace.id);
const solutionContext = await measure(200, () => buildSolutionContext({
  context: {
    store, workspaceId: setup.workspace.id, userId: setup.admin.id,
    scopes: ["workspace.solutions.read"]
  },
  currentProjectId: project.id,
  task: "plan a chart drilldown",
  changedPaths: ["src/chart.tsx"]
}));

const output = {
  schemaVersion: 1,
  environment: "isolated-local-staging",
  productionTouched: false,
  generatedAt: new Date().toISOString(),
  thresholds: { queryP95Ms: 1_000, solutionContextP95Ms: 1_500 },
  query,
  solutionContext,
  status: query.p95Ms <= 1_000 && solutionContext.p95Ms <= 1_500 ? "passed" : "failed"
};
const outputPath = path.resolve("artifacts/frontend-experience-staging-benchmark.json");
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
if (output.status !== "passed") process.exitCode = 1;
