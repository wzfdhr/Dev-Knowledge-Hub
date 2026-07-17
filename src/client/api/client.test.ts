import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("release API client", () => {
  test("requests one exact encoded release ID", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      release: { id: "release / old", version: "0.1.0" }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetch);

    await api.getRelease("release / old");

    expect(fetch).toHaveBeenCalledWith(
      "/api/releases/release%20%2F%20old",
      expect.objectContaining({ credentials: "same-origin" })
    );
  });

  test("uses the dedicated rollback endpoint for one exact release ID", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      release: { id: "release / old", version: "0.1.0" }, previousReleaseId: "release-current"
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetch);

    await api.rollbackRelease("release / old");

    expect(fetch).toHaveBeenCalledWith(
      "/api/releases/release%20%2F%20old/rollback",
      expect.objectContaining({ method: "POST", credentials: "same-origin" })
    );
  });
});

describe("build API client", () => {
  test("requests a comparison for one exact encoded build ID", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      buildId: "build / shadow", comparison: { blockingDefects: [], compatibilityDifferences: [], expectedImprovements: [], citations: { valid: true, total: 0, invalid: [] } }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    await api.getBuildComparison("build / shadow");

    expect(fetch).toHaveBeenCalledWith(
      "/api/builds/build%20%2F%20shadow/comparison",
      expect.objectContaining({ credentials: "same-origin" })
    );
  });

  test("sends an explicit LLM opt-in only when requested", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      build: { id: "build-1", status: "queued" }, created: true
    }), { status: 202, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    await api.startBuild("snapshot-1", { allowLlm: true });

    expect(fetch).toHaveBeenCalledWith("/api/builds", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ snapshotId: "snapshot-1", allowLlm: true })
    }));
  });
});

describe("project graph API client", () => {
  test("pins graph exports to the selected published release", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      release: { id: "release / old", version: "1.0.0" }, format: "mermaid", data: "flowchart TD"
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    await api.getProjectGraph("project / one", "mermaid", { releaseId: "release / old" });

    expect(fetch).toHaveBeenCalledWith(
      "/api/projects/project%20%2F%20one/graph?format=mermaid&releaseId=release+%2F+old",
      expect.objectContaining({ credentials: "same-origin" })
    );
  });
});

describe("project Codex API client", () => {
  test("sends only the selected filtered folder files with their relative paths", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      snapshotId: "snapshot-1", sourceVersion: "a".repeat(40), fileCount: 1, unchanged: false, ignored: { total: 0, reasons: {} }
    }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("document", { cookie: "devkh_csrf=signed-nonce" });
    const file = new File(["export {};"], "index.ts", { type: "text/typescript" });

    await api.uploadFolder("project-1", [{ path: "src/index.ts", file }]);

    expect(fetch).toHaveBeenCalledWith("/api/projects/project-1/folder-import", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "x-devkh-csrf": "signed-nonce" })
    }));
    const call = (fetch.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    const body = call?.[1].body as FormData;
    expect(body.getAll("files").map((value) => (value as File).name)).toEqual(["src/index.ts"]);
  });

  test("attaches the double-submit CSRF header to cookie-authenticated writes", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      id: "token", projectId: "project-1", name: "Local Codex", token: "dkh_secret"
    }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("document", { cookie: "devkh_csrf=signed-nonce" });

    await api.createMcpToken("Local Codex", "project-1");

    expect(fetch).toHaveBeenCalledWith("/api/mcp/tokens", expect.objectContaining({
      headers: expect.objectContaining({ "x-devkh-csrf": "signed-nonce" })
    }));
  });

  test("creates an MCP token with an explicit project scope", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      id: "token", projectId: "project-1", name: "Local Codex", token: "dkh_secret"
    }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    await api.createMcpToken("Local Codex", "project-1");

    expect(fetch).toHaveBeenCalledWith("/api/mcp/tokens", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "Local Codex", projectId: "project-1" })
    }));
  });

  test("rotates one MCP token through its dedicated endpoint", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      previous: { id: "old", revokedAt: "2026-07-14T00:00:00.000Z" },
      replacement: { id: "new", projectId: "project-1", name: "Local Codex" },
      token: "dkh_replacement"
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    await api.rotateMcpToken("old token");

    expect(fetch).toHaveBeenCalledWith("/api/mcp/tokens/old%20token/rotate", expect.objectContaining({
      method: "POST"
    }));
  });
});
