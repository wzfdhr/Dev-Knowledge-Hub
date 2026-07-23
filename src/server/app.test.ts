import { describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";

import { buildServer } from "./app";
import { MemoryAppStore } from "./persistence/memory-store";
import type { ReleaseRecord } from "./persistence/store";
import { hashPassword } from "./security/password";
import { authenticatedCookie, csrfHeaders } from "./test-support/csrf";

function testServer() {
  return buildServer({
    store: new MemoryAppStore(),
    masterKey: Buffer.alloc(32, 1).toString("base64"),
    sessionSecret: "health-test-session-secret",
    dataDir: "/tmp/devkh-health-test",
    nodeEnv: "test"
  });
}

describe("buildServer", () => {
  test("GET /api/health returns service health payload", async () => {
    const app = testServer();

    const response = await app.inject({
      method: "GET",
      url: "/api/health"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "dev-knowledge-hub"
    });

    await app.close();
  });

  test("serves the client entrypoint for direct application routes", async () => {
    const clientDir = await mkdtemp(path.join(os.tmpdir(), "devkh-client-"));
    await writeFile(path.join(clientDir, "index.html"), "<head><!-- devkh:csp-nonce --></head><main>console entrypoint</main>");
    const app = buildServer({
      store: new MemoryAppStore(),
      masterKey: Buffer.alloc(32, 1).toString("base64"),
      sessionSecret: "spa-route-test-session-secret",
      dataDir: "/tmp/devkh-spa-test",
      nodeEnv: "production",
      clientDir
    });

    const response = await app.inject({ method: "GET", url: "/knowledge" });

    expect(response.statusCode).toBe(200);
    const policy = response.headers["content-security-policy"];
    const nonce = policy?.match(/style-src 'self' 'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeDefined();
    expect(response.body).toContain(`content="${nonce}"`);
    expect(response.body).not.toContain("<!-- devkh:csp-nonce -->");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain("console entrypoint");

    const laterResponse = await app.inject({ method: "GET", url: "/projects" });
    const laterNonce = laterResponse.headers["content-security-policy"]
      ?.match(/style-src 'self' 'nonce-([^']+)'/)?.[1];
    expect(laterNonce).toBeDefined();
    expect(laterNonce).not.toBe(nonce);
    await app.close();
  });

  test("redirects the root path to the project center before static directory handling", async () => {
    const clientDir = await mkdtemp(path.join(os.tmpdir(), "devkh-root-redirect-"));
    await writeFile(path.join(clientDir, "index.html"), "<head><!-- devkh:csp-nonce --></head><main>console entrypoint</main>");
    const app = buildServer({
      store: new MemoryAppStore(),
      masterKey: Buffer.alloc(32, 1).toString("base64"),
      sessionSecret: "root-redirect-test-session-secret",
      dataDir: "/tmp/devkh-root-redirect-test",
      nodeEnv: "production",
      clientDir
    });

    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/projects");
    await app.close();
  });

  test("keeps built client assets on the static file route", async () => {
    const clientDir = await mkdtemp(path.join(os.tmpdir(), "devkh-client-"));
    await mkdir(path.join(clientDir, "assets"));
    await writeFile(path.join(clientDir, "index.html"), "<head><!-- devkh:csp-nonce --></head><main>console entrypoint</main>");
    await writeFile(path.join(clientDir, "assets", "app.css"), "body { color: red; }");
    const app = buildServer({
      store: new MemoryAppStore(),
      masterKey: Buffer.alloc(32, 1).toString("base64"),
      sessionSecret: "spa-assets-test-session-secret",
      dataDir: "/tmp/devkh-spa-assets-test",
      nodeEnv: "production",
      clientDir
    });

    const response = await app.inject({ method: "GET", url: "/assets/app.css" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("body { color: red; }");
    expect(response.headers["content-type"]).toContain("text/css");
    expect(response.headers["cache-control"]).not.toBe("no-store");
    await app.close();
  });

  test("serves React and retires the isolated Vue console route", async () => {
    const clientDir = await mkdtemp(path.join(os.tmpdir(), "devkh-client-"));
    await writeFile(path.join(clientDir, "index.html"), "<head><!-- devkh:csp-nonce --></head><main>react console</main>");
    const app = buildServer({
      store: new MemoryAppStore(),
      masterKey: Buffer.alloc(32, 1).toString("base64"),
      sessionSecret: "vue-spa-route-test-session-secret",
      dataDir: path.join(clientDir, "data"),
      nodeEnv: "test",
      clientDir
    });

    const vueResponse = await app.inject({ method: "GET", url: "/console-vue/health" });
    const reactResponse = await app.inject({ method: "GET", url: "/projects" });

    expect(vueResponse.statusCode).toBe(404);
    expect(vueResponse.body).not.toContain("react console");
    expect(reactResponse.statusCode).toBe(200);
    expect(reactResponse.body).toContain("react console");
    await app.close();
  });

  test("rotates an MCP token only for the owning project administrator", async () => {
    const store = new MemoryAppStore();
    const password = "correct horse battery staple";
    const setup = await store.createInitialSetup("admin@example.com", await hashPassword(password));
    const project = (await store.listProjects(setup!.workspace.id))[0];
    const previous = await store.createMcpToken({
      workspaceId: setup!.workspace.id,
      projectId: project.id,
      name: "Codex",
      tokenHash: "old-hash",
      tokenPrefix: "dkh_old"
    });
    const secret = "rotation-test-session-secret";
    const app = buildServer({
      store,
      masterKey: Buffer.alloc(32, 1).toString("base64"),
      sessionSecret: secret,
      dataDir: "/tmp/devkh-rotation-test",
      nodeEnv: "test"
    });
    const login = await app.inject({
      method: "POST", url: "/api/session", payload: { email: "admin@example.com", password }
    });
    const cookie = authenticatedCookie(login);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/tokens/${previous.id}/rotate`,
      headers: { cookie, ...csrfHeaders(cookie) }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      previous: { id: previous.id, revokedAt: expect.any(String) },
      replacement: { projectId: project.id, name: "Codex", revokedAt: null },
      token: expect.stringMatching(/^dkh_/)
    });
    expect(await store.findActiveMcpToken("old-hash")).toBeNull();
    await app.close();
  });

  test("rejects MCP token rotation by a project member without revoking the token", async () => {
    const store = new MemoryAppStore();
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const project = (await store.listProjects(setup!.workspace.id))[0];
    const password = "correct horse battery staple";
    const member = await store.createTeamMember(setup!.workspace.id, {
      email: "member@example.com", passwordHash: await hashPassword(password), role: "member"
    }, setup!.admin.id);
    await store.addProjectMember(setup!.workspace.id, project.id, member!.id, "member", setup!.admin.id);
    const token = await store.createMcpToken({
      workspaceId: setup!.workspace.id,
      projectId: project.id,
      name: "Codex",
      tokenHash: "active-hash",
      tokenPrefix: "dkh_active"
    });
    const secret = "rotation-member-test-session-secret";
    const app = buildServer({
      store,
      masterKey: Buffer.alloc(32, 1).toString("base64"),
      sessionSecret: secret,
      dataDir: "/tmp/devkh-rotation-member-test",
      nodeEnv: "test"
    });
    const login = await app.inject({
      method: "POST", url: "/api/session", payload: { email: "member@example.com", password }
    });
    const cookie = authenticatedCookie(login);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp/tokens/${token.id}/rotate`,
      headers: { cookie, ...csrfHeaders(cookie) }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "PROJECT_ACCESS_DENIED" } });
    expect(await store.findActiveMcpToken("active-hash")).toMatchObject({ id: token.id });
    await app.close();
  });

  test("governs recommendations and queues trusted and ordinary feedback separately", async () => {
    const store = new MemoryAppStore();
    const password = "correct horse battery staple";
    const setup = await store.createInitialSetup("admin@example.com", await hashPassword(password));
    const [project] = await store.listProjects(setup!.workspace.id);
    const repository = await store.createRepository(
      setup!.workspace.id,
      { kind: "git", name: "Frontend", url: "https://example.test/frontend.git" },
      project!.id
    );
    const sourceRelease: ReleaseRecord = {
      id: randomUUID(), workspaceId: setup!.workspace.id, repositoryId: repository!.id,
      buildId: randomUUID(), snapshotId: randomUUID(), version: "frontend-v2.0.0",
      kernelMode: "pipeline", packageArtifactId: randomUUID(), releaseArtifactFamily: "frontend-v2",
      packageStageRunId: randomUUID(), frontendIrSchemaVersion: 2, frontendGraphSchemaVersion: 2,
      analyzerManifestDigest: "a".repeat(64), createdAt: new Date(), publishedAt: new Date()
    };
    store.releases.push(sourceRelease);
    const experienceId = randomUUID();
    const evidence = await store.saveObservedPatternEvidence({
      id: randomUUID(), workspaceId: setup!.workspace.id, patternGroupId: experienceId,
      projectId: project!.id, releaseId: sourceRelease.id, snapshotId: sourceRelease.snapshotId,
      capability: "forms", sourceEligibility: "git", title: "Validated submit boundary",
      observedFact: "Uses a schema before submission", profileDigest: "b".repeat(64),
      contentVersion: "content-v1", citations: [{
        snapshotId: sourceRelease.snapshotId, path: "src/form.tsx", startLine: 1, endLine: 2,
        blobHash: "c".repeat(64)
      }]
    });
    const secret = "experience-governance-test-secret";
    const app = buildServer({
      store, masterKey: Buffer.alloc(32, 1).toString("base64"), sessionSecret: secret,
      dataDir: "/tmp/devkh-experience-governance-test", nodeEnv: "test"
    });
    const login = await app.inject({
      method: "POST", url: "/api/session", payload: { email: "admin@example.com", password }
    });
    const cookie = authenticatedCookie(login);
    const headers = { cookie, ...csrfHeaders(cookie) };

    const decisionResponse = await app.inject({
      method: "POST", url: `/api/knowledge/experiences/${experienceId}/decisions`, headers,
      payload: {
        decision: "approve", reason: "Reusable and cited", basisEvidenceIds: [evidence.id],
        applicability: { required: [], forbidden: [], preferred: [], unsupportedWhenUnknown: [] }
      }
    });
    expect(decisionResponse.statusCode).toBe(201);
    const decisionId = decisionResponse.json().decision.id as string;

    const verifyResponse = await app.inject({
      method: "POST", url: `/api/knowledge/experiences/${experienceId}/reviews`, headers,
      payload: {
        action: "verify", reason: "Citation checked", basisEvidenceIds: [evidence.id],
        decisionId: null, supersededById: null
      }
    });
    expect(verifyResponse.statusCode).toBe(201);
    const recommendResponse = await app.inject({
      method: "POST", url: `/api/knowledge/experiences/${experienceId}/reviews`, headers,
      payload: {
        action: "recommend", reason: "Approved", basisEvidenceIds: [evidence.id],
        decisionId, supersededById: null
      }
    });
    expect(recommendResponse.statusCode).toBe(201);

    const outcomeResponse = await app.inject({
      method: "POST", url: `/api/knowledge/experiences/${experienceId}/outcomes/manual`, headers,
      payload: {
        evidenceId: evidence.id, outcome: "rolled_back", sourceVersion: "content-v1",
        checks: [{ name: "rollback", status: "failed" }], reportDigest: null
      }
    });
    expect(outcomeResponse.statusCode).toBe(201);
    expect(store.experienceReviewItems).toEqual([
      expect.objectContaining({ kind: "trusted_negative_outcome", priority: "high" })
    ]);

    const memberPassword = "member password is long enough";
    const member = await store.createTeamMember(setup!.workspace.id, {
      email: "member@example.com", passwordHash: await hashPassword(memberPassword), role: "member"
    }, setup!.admin.id);
    await store.addProjectMember(
      setup!.workspace.id, project!.id, member!.id, "member", setup!.admin.id
    );
    const memberLogin = await app.inject({
      method: "POST", url: "/api/session",
      payload: { email: "member@example.com", password: memberPassword }
    });
    const memberCookie = authenticatedCookie(memberLogin);
    const feedbackResponse = await app.inject({
      method: "POST", url: `/api/knowledge/experiences/${experienceId}/feedback`,
      headers: { cookie: memberCookie, ...csrfHeaders(memberCookie) },
      payload: {
        evidenceId: evidence.id, event: "failed", currentProjectId: project!.id,
        sourceVersion: "content-v1", taskSummary: "The member implementation failed"
      }
    });
    expect(feedbackResponse.statusCode).toBe(202);
    expect(store.experienceOutcomes).toHaveLength(1);
    expect(store.experienceReviewItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "user_feedback", priority: "normal", feedbackEvent: "failed" })
    ]));

    store.experienceEvidence.find((item) => item.id === evidence.id)!.citations = [];
    const lintResponse = await app.inject({
      method: "POST", url: "/api/knowledge/experience-lint", headers
    });
    expect(lintResponse.statusCode).toBe(200);
    expect(lintResponse.json()).toMatchObject({
      schemaVersion: 1,
      diagnostics: [expect.objectContaining({
        rule: "EXPERIENCE_CITATION_MISSING", severity: "error", patternGroupId: experienceId
      })]
    });
    expect(store.experienceReviewItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "knowledge_lint", priority: "high" })
    ]));
    await app.close();
  });

  test("returns typed experience and solution contexts when the current project has no release", async () => {
    const store = new MemoryAppStore();
    const password = "correct horse battery staple";
    const setup = await store.createInitialSetup("admin@example.com", await hashPassword(password));
    const [project] = await store.listProjects(setup!.workspace.id);
    const app = buildServer({
      store,
      masterKey: Buffer.alloc(32, 1).toString("base64"),
      sessionSecret: "experience-ui-route-test-secret",
      dataDir: "/tmp/devkh-experience-ui-route-test",
      nodeEnv: "test"
    });
    const login = await app.inject({
      method: "POST", url: "/api/session", payload: { email: "admin@example.com", password }
    });
    const cookie = authenticatedCookie(login);

    const library = await app.inject({
      method: "GET",
      url: `/api/knowledge/experiences?currentProjectId=${project!.id}`,
      headers: { cookie }
    });
    expect(library.statusCode).toBe(200);
    expect(library.json()).toMatchObject({
      state: "no_release", currentProject: { projectId: project!.id, status: "no_release" },
      experiences: [], rejectedExperiences: []
    });

    const preview = await app.inject({
      method: "POST",
      url: `/api/projects/${project!.id}/frontend-solution-context`,
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { task: "为图表增加下钻", changedPaths: ["src/chart.tsx"] }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      context: {
        schemaVersion: 1,
        currentProject: { projectId: project!.id, status: "no_release" },
        applicableExperiences: [],
        changeImpact: [{ path: "src/chart.tsx" }]
      }
    });

    const invalidPath = await app.inject({
      method: "POST",
      url: `/api/projects/${project!.id}/frontend-solution-context`,
      headers: { cookie, ...csrfHeaders(cookie) },
      payload: { task: "unsafe path", changedPaths: ["../outside.ts"] }
    });
    expect(invalidPath.statusCode).toBe(400);
    expect(invalidPath.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
    await app.close();
  });
});
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
