import { describe, expect, test } from "vitest";

import { MemoryAppStore } from "../persistence/memory-store";
import { executeWorkspaceTool } from "./workspace-tools";
import { frontendProjectProfileDigest } from "../../shared/frontend-project-profile";

describe("workspace MCP tools", () => {
  test("returns typed no-release context instead of a transport error", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const [project] = await store.listProjects(setup!.workspace.id);

    const result = await executeWorkspaceTool({
      store, workspaceId: setup!.workspace.id, userId: setup!.admin.id,
      scopes: ["workspace.solutions.read"]
    }, "dkh_plan_frontend_solution", {
      currentProjectId: project!.id, task: "实现下钻页面"
    });

    expect(result.structuredContent).toMatchObject({
      currentProject: { projectId: project!.id, status: "no_release", releaseId: null },
      currentProjectFacts: [], applicableExperiences: []
    });
  });

  test("requires currentProjectId, bounded tasks, and safe project-relative paths", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const context = {
      store, workspaceId: setup!.workspace.id, userId: setup!.admin.id,
      scopes: ["workspace.solutions.read" as const]
    };

    await expect(executeWorkspaceTool(context, "dkh_plan_frontend_solution", { task: "cache" }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(executeWorkspaceTool(context, "dkh_plan_frontend_solution", {
      currentProjectId: (await store.listProjects(setup!.workspace.id))[0]!.id,
      task: "cache", changedPaths: ["../secret.ts"]
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("enforces scope separation and live project access", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const [project] = await store.listProjects(setup!.workspace.id);
    const member = await store.createTeamMember(setup!.workspace.id, {
      email: "member@example.com", passwordHash: "hash", role: "member"
    }, setup!.admin.id);
    const context = {
      store, workspaceId: setup!.workspace.id, userId: member!.id,
      scopes: ["workspace.patterns.read" as const]
    };

    await expect(executeWorkspaceTool(context, "dkh_plan_frontend_solution", {
      currentProjectId: project!.id, task: "cache"
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(executeWorkspaceTool(context, "dkh_find_prior_implementations", {
      currentProjectId: project!.id, query: "cache"
    })).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  test("keeps current facts, constraints, experiences, exclusions and unknowns in separate fields", async () => {
    const snapshotId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const sourceRef = {
      snapshotId, path: "package.json", startLine: 1, endLine: 8, blobHash: "a".repeat(64)
    };
    const payload = {
      schemaVersion: 1 as const, snapshotId,
      sourceProvenance: {
        schemaVersion: 1 as const, kind: "git" as const, gitCommitSha: "c".repeat(40),
        contentVersion: "d".repeat(40), ref: "main", remoteIdentityDigest: "e".repeat(64)
      },
      analyzerManifestDigest: "f".repeat(64),
      framework: { state: "known" as const, value: { name: "react", version: "19.0.0", supported: true } },
      rendering: { state: "known" as const, value: { modes: ["csr" as const] } },
      router: { state: "unknown" as const, reason: "unresolved" as const },
      state: { state: "unknown" as const, reason: "unresolved" as const },
      data: { state: "unknown" as const, reason: "unresolved" as const },
      formLibrary: { state: "unknown" as const, reason: "unresolved" as const },
      tooling: { state: "known" as const, value: { buildTools: ["vite"], configs: ["vite.config.ts"] } },
      styles: { state: "unknown" as const, reason: "unresolved" as const },
      visualizations: { state: "unknown" as const, reason: "unresolved" as const },
      tests: { state: "unknown" as const, reason: "unresolved" as const },
      workspace: { state: "known" as const, value: { kind: "single-package" as const, packageManager: "npm" as const, packages: [""] } },
      sourceRefs: [sourceRef]
    };
    const profile = { ...payload, profileDigest: frontendProjectProfileDigest(payload) };
    const packageValue = {
      schemaVersion: 2, family: "frontend-v2", stage: "package", snapshotId,
      analyzerManifestDigest: "f".repeat(64), upstreamManifestIds: ["validate-1", "validate-2"],
      sourceArtifactId: "package", irSchemaVersion: 2, graphSchemaVersion: 2,
      projectProfileArtifactId: "profile", projectProfileDigest: profile.profileDigest,
      patternCandidatesArtifactId: "patterns",
      artifacts: {
        convert: ["convert"], extract: ["extract-1", "extract-2"],
        tables: ["tables-1", "tables-2"], graph: ["graph-1", "graph-2"],
        synthesize: ["synth-1", "synth-2", "profile"],
        index: ["index-1", "index-2", "patterns"], lint: ["lint-1", "lint-2"],
        viz: ["viz-1", "viz-2"], validate: ["validate-1", "validate-2"], package: ["package"]
      }
    };
    const store = {
      projectAccess: async () => ({ project: { id: projectId, archivedAt: null } }),
      currentRepository: async () => ({ id: "repository", projectId }),
      currentRelease: async () => ({
        id: "release", snapshotId, releaseArtifactFamily: "frontend-v2",
        packageArtifactId: "package", publishedAt: new Date()
      }),
      findSnapshotById: async () => ({ id: snapshotId, contentVersion: "d".repeat(40), commitSha: "c".repeat(40) }),
      latestSnapshot: async () => ({ id: snapshotId }),
      findArtifactById: async (id: string) => ({ id }),
      listVisibleExperienceCandidates: async () => []
    };
    const result = await executeWorkspaceTool({
      store: store as never, workspaceId: "workspace", userId: "user",
      scopes: ["workspace.solutions.read"],
      artifactReader: { getJson: async (manifest) => manifest.id === "package" ? packageValue : profile }
    }, "dkh_plan_frontend_solution", {
      currentProjectId: projectId, task: "Add a chart", changedPaths: ["src/chart.tsx"]
    });

    expect(result.structuredContent).toMatchObject({
      currentProject: { status: "ready" },
      currentProjectFacts: expect.arrayContaining([expect.objectContaining({ key: "framework" })]),
      hardConstraints: expect.arrayContaining([expect.objectContaining({ key: "tooling" })]),
      applicableExperiences: [], rejectedExperiences: [],
      unknowns: expect.arrayContaining([expect.objectContaining({ key: "router" })]),
      changeImpact: [expect.objectContaining({ path: "src/chart.tsx" })],
      verificationPlan: expect.any(Array)
    });
  });
});
