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

describe("rate-limited API requests", () => {
  test("does not automatically retry authentication requests", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      error: { code: "RATE_LIMITED", message: "Too many requests" }
    }), { status: 429, headers: { "retry-after": "60", "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    await expect(api.login({ email: "admin@example.com", password: "password" }))
      .rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
    expect(fetch).toHaveBeenCalledTimes(1);
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

describe("frontend preview API client", () => {
  test("requests the exact project candidate preview", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ status: "source_missing", preview: null }), {
      status: 200, headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetch);

    await api.getProjectFrontendPreview("project / one");

    expect(fetch).toHaveBeenCalledWith(
      "/api/projects/project%20%2F%20one/frontend-preview",
      expect.objectContaining({ credentials: "same-origin" })
    );
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
  test("resumes one paged upload session and sends only server-required source bytes", async () => {
    const responses = [
      { status: 201, body: { id: "session-1", status: "open", entryCount: 2, expiresAt: "2026-07-20T00:00:00.000Z" } },
      { status: 200, body: { entries: [
        { ordinal: 0, disposition: "upload_required", trust: "pending" },
        { ordinal: 1, disposition: "metadata_only", trust: "client_unverified" }
      ] } },
      { status: 200, body: { ordinal: 0, disposition: "upload_required", trust: "server_verified" } },
      { status: 201, body: {
        snapshotId: "snapshot-1", sourceVersion: "a".repeat(40), fileCount: 1, unchanged: false,
        ignored: { total: 0, reasons: {} }, assetCount: 1
      } }
    ];
    const fetch = vi.fn(async () => {
      const response = responses.shift()!;
      return new Response(JSON.stringify(response.body), {
        status: response.status, headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("document", { cookie: "devkh_csrf=signed-nonce" });
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn()
    });
    const file = new File(["export {};"], "index.ts", { type: "text/typescript" });
    const asset = new File(["png"], "logo.png", { type: "image/png" });

    await api.uploadFolder("project-1", "repository-1", [
      { path: "src/index.ts", kind: "source", file },
      { path: "assets/logo.png", kind: "asset", file: asset }
    ]);

    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => url)).toEqual([
      "/api/projects/project-1/upload-sessions",
      "/api/projects/project-1/upload-sessions/session-1/manifest-pages/0",
      "/api/projects/project-1/upload-sessions/session-1/files/0",
      "/api/projects/project-1/upload-sessions/session-1/commit"
    ]);
    expect(calls[2]?.[1]).toEqual(expect.objectContaining({
      method: "PUT",
      body: file,
      headers: expect.objectContaining({ "content-type": "application/octet-stream" })
    }));
  });

  test("uploads each manifest page before retaining decisions from later pages", async () => {
    const files = Array.from({ length: 501 }, (_, ordinal) => ({
      path: ordinal === 0 || ordinal === 500 ? `src/${ordinal}.ts` : `assets/${ordinal}.png`,
      kind: ordinal === 0 || ordinal === 500 ? "source" as const : "asset" as const,
      file: new File([ordinal === 0 || ordinal === 500 ? "export {};" : ""], `${ordinal}`)
    }));
    const responses = [
      new Response(JSON.stringify({ id: "session-pages", status: "open", entryCount: 501, expiresAt: "2026-07-20T00:00:00.000Z" }), { status: 201 }),
      new Response(JSON.stringify({ entries: [{ ordinal: 0, disposition: "upload_required", trust: "pending" }] }), { status: 200 }),
      new Response(JSON.stringify({ ordinal: 0, disposition: "upload_required", trust: "server_verified" }), { status: 200 }),
      new Response(JSON.stringify({ entries: [{ ordinal: 500, disposition: "upload_required", trust: "pending" }] }), { status: 200 }),
      new Response(JSON.stringify({ ordinal: 500, disposition: "upload_required", trust: "server_verified" }), { status: 200 }),
      new Response(JSON.stringify({ snapshotId: "snapshot-pages", sourceVersion: "d".repeat(40), fileCount: 2, textBytes: 20, unchanged: false, ignored: { total: 0, reasons: {} }, assetCount: 499 }), { status: 201 })
    ];
    const fetch = vi.fn(async () => responses.shift()!);
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });

    await api.uploadFolder("project-1", "repository-1", files);

    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => url)).toEqual([
      "/api/projects/project-1/upload-sessions",
      "/api/projects/project-1/upload-sessions/session-pages/manifest-pages/0",
      "/api/projects/project-1/upload-sessions/session-pages/files/0",
      "/api/projects/project-1/upload-sessions/session-pages/manifest-pages/1",
      "/api/projects/project-1/upload-sessions/session-pages/files/500",
      "/api/projects/project-1/upload-sessions/session-pages/commit"
    ]);
  });

  test("reuses the durable session key after an interrupted manifest request", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key))
    });
    const responseQueue = [
      new Response(JSON.stringify({ id: "session-1", status: "open", entryCount: 1, expiresAt: "2026-07-20T00:00:00.000Z" }), { status: 201 }),
      new Response(JSON.stringify({ error: { code: "TEMPORARY", message: "interrupted" } }), { status: 500 }),
      new Response(JSON.stringify({ id: "session-1", status: "open", entryCount: 1, expiresAt: "2026-07-20T00:00:00.000Z" }), { status: 201 }),
      new Response(JSON.stringify({ entries: [{ ordinal: 0, disposition: "upload_required", trust: "pending" }] }), { status: 200 }),
      new Response(JSON.stringify({ ordinal: 0, disposition: "upload_required", trust: "server_verified" }), { status: 200 }),
      new Response(JSON.stringify({ snapshotId: "snapshot-1", sourceVersion: "b".repeat(40), fileCount: 1, unchanged: false, ignored: { total: 0, reasons: {} }, assetCount: 0 }), { status: 201 })
    ];
    const fetch = vi.fn(async () => responseQueue.shift()!);
    vi.stubGlobal("fetch", fetch);
    const files = [{
      path: "src/index.ts", kind: "source" as const,
      file: new File(["export {};"], "index.ts", { type: "text/typescript" })
    }];

    await expect(api.uploadFolder("project-1", "repository-1", files)).rejects.toMatchObject({ code: "TEMPORARY" });
    await expect(api.uploadFolder("project-1", "repository-1", files)).resolves.toMatchObject({ snapshotId: "snapshot-1" });

    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]?.[1].headers).toMatchObject({ "Idempotency-Key": expect.any(String) });
    expect((calls[2]?.[1].headers as Record<string, string>)["Idempotency-Key"])
      .toBe((calls[0]?.[1].headers as Record<string, string>)["Idempotency-Key"]);
    expect(storage.size).toBe(0);
  });

  test("does not retransmit files already verified before an interrupted commit", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key))
    });
    const responses = [
      new Response(JSON.stringify({ id: "session-resume", status: "open", entryCount: 1, expiresAt: "2026-07-20T00:00:00.000Z" }), { status: 201 }),
      new Response(JSON.stringify({ entries: [{ ordinal: 0, disposition: "upload_required", trust: "pending" }] }), { status: 200 }),
      new Response(JSON.stringify({ ordinal: 0, disposition: "upload_required", trust: "server_verified" }), { status: 200 }),
      new Response(JSON.stringify({ error: { code: "TEMPORARY", message: "commit interrupted" } }), {
        status: 500, headers: { "content-type": "application/json" }
      }),
      new Response(JSON.stringify({ id: "session-resume", status: "open", entryCount: 1, expiresAt: "2026-07-20T00:00:00.000Z" }), { status: 201 }),
      new Response(JSON.stringify({ entries: [{ ordinal: 0, disposition: "upload_required", trust: "server_verified" }] }), { status: 200 }),
      new Response(JSON.stringify({
        snapshotId: "snapshot-resume", sourceVersion: "e".repeat(40), fileCount: 1, textBytes: 10,
        unchanged: false, ignored: { total: 0, reasons: {} }, assetCount: 0
      }), { status: 201 })
    ];
    const fetch = vi.fn(async () => responses.shift()!);
    vi.stubGlobal("fetch", fetch);
    const files = [{
      path: "src/index.ts", kind: "source" as const,
      file: new File(["export {};"], "index.ts", { type: "text/typescript" })
    }];

    await expect(api.uploadFolder("project-1", "repository-1", files)).rejects.toMatchObject({ code: "TEMPORARY" });
    await expect(api.uploadFolder("project-1", "repository-1", files))
      .resolves.toMatchObject({ snapshotId: "snapshot-resume" });

    const fileRequests = (fetch.mock.calls as unknown as Array<[string, RequestInit]>).filter(([, init]) =>
      init.method === "PUT" && init.headers && (init.headers as Record<string, string>)["content-type"] === "application/octet-stream"
    );
    expect(fileRequests).toHaveLength(1);
    expect(storage.size).toBe(0);
  });

  test("clears and cancels a terminal upload session instead of replaying it for 23 hours", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key))
    });
    const responses = [
      new Response(JSON.stringify({ id: "session-terminal", status: "open", entryCount: 1, expiresAt: "2026-07-20T00:00:00.000Z" }), { status: 201 }),
      new Response(JSON.stringify({ error: { code: "UPLOAD_SESSION_INVALIDATED", message: "source changed" } }), {
        status: 409, headers: { "content-type": "application/json" }
      }),
      new Response(null, { status: 204 })
    ];
    const fetch = vi.fn(async () => responses.shift()!);
    vi.stubGlobal("fetch", fetch);

    await expect(api.uploadFolder("project-1", "repository-1", [{
      path: "src/index.ts", kind: "source",
      file: new File(["export {};"], "index.ts", { type: "text/typescript" })
    }])).rejects.toMatchObject({ code: "UPLOAD_SESSION_INVALIDATED" });

    expect(storage.size).toBe(0);
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.at(-1)?.[0]).toBe(
      "/api/projects/project-1/upload-sessions/session-terminal"
    );
    expect(calls.at(-1)?.[1]).toEqual(expect.objectContaining({ method: "DELETE" }));
  });

  test("waits for Retry-After and resumes a rate-limited source upload", async () => {
    const responses = [
      new Response(JSON.stringify({ id: "session-1", status: "open", entryCount: 1, expiresAt: "2026-07-20T00:00:00.000Z" }), { status: 201 }),
      new Response(JSON.stringify({ entries: [{ ordinal: 0, disposition: "upload_required", trust: "pending" }] }), { status: 200 }),
      new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "Too many requests" } }), {
        status: 429, headers: { "retry-after": "0.001", "content-type": "application/json" }
      }),
      new Response(JSON.stringify({ ordinal: 0, disposition: "upload_required", trust: "server_verified" }), { status: 200 }),
      new Response(JSON.stringify({
        snapshotId: "snapshot-1", sourceVersion: "c".repeat(40), fileCount: 1, textBytes: 10,
        unchanged: false, ignored: { total: 0, reasons: {} }, assetCount: 0
      }), { status: 201 })
    ];
    const fetch = vi.fn(async () => responses.shift()!);
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
    const upload = api.uploadFolder("project-1", "repository-1", [{
      path: "src/index.ts", kind: "source",
      file: new File(["export {};"], "index.ts", { type: "text/typescript" })
    }]);

    await expect(upload).resolves.toMatchObject({ snapshotId: "snapshot-1" });
    expect(fetch).toHaveBeenCalledTimes(5);
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
