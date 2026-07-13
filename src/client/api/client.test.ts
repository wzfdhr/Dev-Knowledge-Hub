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
});

describe("project Codex API client", () => {
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
});
