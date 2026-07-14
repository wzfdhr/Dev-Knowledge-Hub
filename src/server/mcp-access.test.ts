import { authenticatedCookie, csrfHeaders } from "./test-support/csrf";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, test, vi } from "vitest";

import { buildServer } from "./app";
import { generateKnowledge } from "./knowledge/generator";
import { analyzeSnapshot } from "./knowledge/intelligence";
import { createMcpServer } from "./mcp-stdio";
import { MemoryAppStore } from "./persistence/memory-store";
import {
  MAX_KNOWLEDGE_CHUNK_CITATIONS,
  MAX_KNOWLEDGE_CHUNK_CONTENT_CHARACTERS,
  MAX_KNOWLEDGE_PAGE_BODY_CHARACTERS
} from "./persistence/store";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../test/fixtures/code-intelligence"
);

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function adminContext() {
  const store = new MemoryAppStore();
  const app = buildServer({
    store,
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    sessionSecret: "mcp-access-session-secret",
    dataDir: "/tmp/devkh-mcp-access",
    nodeEnv: "test"
  });
  await app.inject({
    method: "POST", url: "/api/setup",
    payload: { email: "admin@example.com", password: "correct horse battery staple" }
  });
  const login = await app.inject({
    method: "POST", url: "/api/session",
    payload: { email: "admin@example.com", password: "correct horse battery staple" }
  });
  return {
    app,
    store,
    cookie: authenticatedCookie(login),
    workspaceId: (await store.defaultWorkspace())!.id
  };
}

async function publishedContext(root = fixtureRoot) {
  const context = await adminContext();
  const repository = (await context.store.createRepository(context.workspaceId, {
    kind: "local", name: "Fixture", path: root
  }))!;
  const index = await analyzeSnapshot(root, "a".repeat(40));
  const snapshotId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await context.store.createSnapshot({
    snapshot: {
      id: snapshotId,
      workspaceId: context.workspaceId,
      repositoryId: repository.id,
      commitSha: index.commitSha,
      ref: "main",
      remoteUrl: null,
      commitTimestamp: new Date("2026-07-11T00:00:00Z"),
      storagePath: root
    },
    files: index.files.map((file, position) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(position + 1).padStart(12, "0")}`,
      workspaceId: context.workspaceId,
      snapshotId,
      path: file.path,
      byteSize: file.endLine,
      contentHash: file.blobHash,
      language: null
    }))
  });
  const build = (await context.store.createBuild({
    workspaceId: context.workspaceId,
    repositoryId: repository.id,
    snapshotId,
    snapshotPath: root,
    commitSha: index.commitSha
  })).build;
  await context.store.saveKnowledge({ build, index, output: await generateKnowledge(index) });
  await context.store.transitionBuild(build.id, "queued", "ready");
  const release = await context.store.createReleaseDraft(
    context.workspaceId, repository.id, build.id, "1.0.0"
  );
  await context.store.publishRelease(context.workspaceId, release.id);
  return { ...context, repository, release, index };
}

async function connectMcp(store: MemoryAppStore, workspaceId: string) {
  const factory = createMcpServer as unknown as (context: {
    store: MemoryAppStore; workspaceId: string;
  }) => ReturnType<typeof createMcpServer>;
  const server = factory({ store, workspaceId });
  const client = new Client({ name: "mcp-contract-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  closeCallbacks.push(() => client.close(), () => server.close());
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("MCP bearer tokens", () => {
  test("shows plaintext once, persists only its hash, lists sanitized metadata, and rejects revocation", async () => {
    const { app, store, cookie } = await adminContext();
    const created = await app.inject({
      method: "POST", url: "/api/mcp/tokens", headers: { cookie, ...csrfHeaders(cookie) }, payload: { name: "CI agent" }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().token).toMatch(/^dkh_/);
    const plaintext = created.json().token as string;
    const persisted = (store as unknown as { mcpTokens: Array<Record<string, unknown>> }).mcpTokens[0];
    expect(persisted).toMatchObject({ name: "CI agent", tokenPrefix: plaintext.slice(0, 12) });
    expect(persisted.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(persisted)).not.toContain(plaintext);

    const listed = await app.inject({ method: "GET", url: "/api/mcp/tokens", headers: { cookie, ...csrfHeaders(cookie) } });
    expect(listed.json().tokens[0].tokenPrefix).toBe(plaintext.slice(0, 12));
    expect(listed.json().tokens[0]).not.toHaveProperty("prefix");
    expect(listed.json().tokens[0]).not.toHaveProperty("token");
    expect(listed.json().tokens[0]).not.toHaveProperty("tokenHash");

    expect((await app.inject({
      method: "GET", url: "/api/mcp/connection", headers: { cookie, ...csrfHeaders(cookie) }
    })).json()).toMatchObject({ endpoint: "/mcp", transport: "streamable-http" });

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const httpClient = new Client({ name: "http-contract-test", version: "0.0.0" });
    await httpClient.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${plaintext}` } }
    }));
    expect((await httpClient.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "dkh_get_architecture",
      "dkh_get_change_context",
      "dkh_get_module",
      "dkh_get_release",
      "dkh_get_source",
      "dkh_get_symbol",
      "dkh_search"
    ]);
    await httpClient.close();
    const mcpRequest = (token: string, id: number) => fetch(`${address}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} })
    });
    const authorizedMcp = await mcpRequest(plaintext, 1);
    expect(authorizedMcp.status).not.toBe(401);
    expect(authorizedMcp.headers.get("x-content-type-options")).toBe("nosniff");

    const tokenId = created.json().id as string;
    expect((await app.inject({
      method: "POST", url: `/api/mcp/tokens/${tokenId}/revoke`, headers: { cookie, ...csrfHeaders(cookie) }
    })).statusCode).toBe(200);
    expect((await mcpRequest(plaintext, 2)).status).toBe(401);
    await app.close();
  });

  test("enforces the read-only scope allowlist and rejects expired tokens explicitly", async () => {
    const { app, store, cookie } = await adminContext();
    const created = await app.inject({
      method: "POST", url: "/api/mcp/tokens", headers: { cookie, ...csrfHeaders(cookie) },
      payload: { name: "Search only", scopes: ["search"] }
    });
    const plaintext = created.json<{ token: string }>().token;
    expect(created.json()).toMatchObject({ scopes: ["search"], expiresAt: expect.any(String) });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const mcpRequest = (method: string, id: number) => fetch(`${address}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${plaintext}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: {} })
    });
    const tools = await mcpRequest("tools/list", 1).then((response) => response.json()) as { result: { tools: Array<{ name: string }> } };
    expect(tools.result.tools.map((tool) => tool.name)).not.toContain("dkh_get_source");
    expect(tools.result.tools.map((tool) => tool.name)).not.toContain("dkh_report_gap");
    (store as unknown as { mcpTokens: Array<{ expiresAt: Date }> }).mcpTokens[0].expiresAt = new Date(Date.now() - 1_000);
    const expired = await mcpRequest("tools/list", 2);
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ error: { code: "MCP_TOKEN_EXPIRED" } });
    await app.close();
  });

  test("paginates beyond one hundred tokens with totals and a continuation offset", async () => {
    const { app, store, cookie, workspaceId } = await adminContext();
    for (let index = 0; index < 125; index += 1) {
      await store.createMcpToken({
        workspaceId,
        projectId: "project-1",
        name: `Agent ${String(index).padStart(3, "0")}`,
        tokenHash: String(index).padStart(64, "0"),
        tokenPrefix: `dkh_${String(index).padStart(8, "0")}`
      });
    }

    const first = await app.inject({
      method: "GET", url: "/api/mcp/tokens?limit=100&offset=0", headers: { cookie, ...csrfHeaders(cookie) }
    });
    const second = await app.inject({
      method: "GET", url: "/api/mcp/tokens?limit=100&offset=100", headers: { cookie, ...csrfHeaders(cookie) }
    });

    expect(first.json()).toMatchObject({ total: 125, nextOffset: 100 });
    expect(first.json().tokens).toHaveLength(100);
    expect(second.json()).toMatchObject({ total: 125, nextOffset: null });
    expect(second.json().tokens).toHaveLength(25);
    await app.close();
  });
});

describe("MCP tool contract", () => {
  test("returns the exact common release envelope from all eight tools", async () => {
    const { store, workspaceId, release, index, app } = await publishedContext();
    const client = await connectMcp(store, workspaceId);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["dkh_search", { query: "add", limit: 3 }],
      ["dkh_get_architecture", {}],
      ["dkh_get_module", { moduleId: "src/math.ts" }],
      ["dkh_get_symbol", { name: "add", path: "src/math.ts" }],
      ["dkh_get_change_context", { task: "change add", paths: ["src/math.ts"] }],
      ["dkh_get_source", { path: "src/math.ts", startLine: 16, endLine: 18 }],
      ["dkh_get_release", {}],
      ["dkh_report_gap", {
        query: "add", reason: "The result needs more detail", expected: "examples"
      }]
    ];

    for (const [name, args] of calls) {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError, name).not.toBe(true);
      const envelope = response.structuredContent as {
        releaseId: string;
        commitSha: string;
        result: unknown;
        citations: unknown[];
      };
      expect(Object.keys(envelope).sort(), name).toEqual([
        "citations", "commitSha", "releaseId", "result"
      ]);
      expect(envelope, name).toMatchObject({
        releaseId: release.id,
        commitSha: index.commitSha,
        citations: expect.any(Array)
      });
      if (name === "dkh_report_gap") {
        expect(envelope.citations).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: "src/math.ts", commitSha: index.commitSha })
        ]));
        expect(envelope.result).toEqual({
          feedback: expect.objectContaining({
            query: "add",
            status: "open",
            citations: envelope.citations
          })
        });
      } else {
        expect(envelope.citations).toEqual(expect.arrayContaining([
          expect.objectContaining({
            path: expect.any(String),
            startLine: expect.any(Number),
            endLine: expect.any(Number),
            commitSha: index.commitSha,
            blobHash: expect.any(String)
          })
        ]));
      }
      expect(envelope, name).toHaveProperty("result");
    }
    await app.close();
  });

  test("returns stable unpublished and missing-citation errors", async () => {
    const unpublished = await adminContext();
    await unpublished.store.createRepository(unpublished.workspaceId, {
      kind: "local", name: "Fixture", path: fixtureRoot
    });
    const unpublishedClient = await connectMcp(unpublished.store, unpublished.workspaceId);
    const noRelease = await unpublishedClient.callTool({ name: "dkh_get_release", arguments: {} });
    expect(noRelease).toMatchObject({ isError: true });
    expect(JSON.stringify(noRelease)).toContain("UNPUBLISHED");

    const published = await publishedContext();
    published.store.knowledgePages.forEach((page) => page.chunks.forEach((chunk) => {
      chunk.citations = [];
    }));
    const citedClient = await connectMcp(published.store, published.workspaceId);
    const missing = await citedClient.callTool({ name: "dkh_get_architecture", arguments: {} });
    expect(missing).toMatchObject({ isError: true });
    expect(JSON.stringify(missing)).toContain("CITATIONS_MISSING");

    await unpublished.app.close();
    await published.app.close();
  });

  test("does not substitute generic support pages for undiscovered change context", async () => {
    const { store, workspaceId, app } = await publishedContext();
    const client = await connectMcp(store, workspaceId);

    const response = await client.callTool({
      name: "dkh_get_change_context",
      arguments: { task: "modify xyzzynotfound behavior" }
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(((response.content as Array<{ text: string }>)[0]).text).error.code)
      .toBe("NOT_FOUND");
    await app.close();
  });

  test("reports a gap with a validated architecture citation when search has no hit", async () => {
    const { store, workspaceId, release, index, app } = await publishedContext();
    const client = await connectMcp(store, workspaceId);

    const response = await client.callTool({
      name: "dkh_report_gap",
      arguments: { query: "xyzzynotfound", reason: "No matching guidance" }
    });

    expect(response.isError).not.toBe(true);
    const envelope = response.structuredContent as {
      releaseId: string;
      citations: Array<{ path: string; commitSha: string }>;
      result: { feedback: { citations: unknown[] } };
    };
    expect(envelope.releaseId).toBe(release.id);
    expect(envelope.citations.length).toBeGreaterThan(0);
    expect(envelope.citations[0]).toMatchObject({ commitSha: index.commitSha });
    expect(envelope.result.feedback.citations).toEqual(envelope.citations);
    await app.close();
  });

  test("uses targeted store lookups for architecture, module, and symbol reads", async () => {
    const { store, workspaceId, app } = await publishedContext();
    const client = await connectMcp(store, workspaceId);
    const listPages = vi.spyOn(store, "listKnowledgePages");

    await client.callTool({ name: "dkh_get_architecture", arguments: {} });
    await client.callTool({ name: "dkh_get_module", arguments: { moduleId: "src/math.ts" } });
    await client.callTool({
      name: "dkh_get_symbol",
      arguments: { name: "add", path: "src/math.ts" }
    });

    expect(listPages).not.toHaveBeenCalled();
    await app.close();
  });

  test("bounds page, citation, and release-summary responses for a large release", async () => {
    const { store, workspaceId, index, app } = await publishedContext();
    const architecture = store.knowledgePages.find((page) => page.slug === "architecture-overview")!;
    const manyCitations = index.files.flatMap((file) =>
      Array.from({ length: Math.min(file.endLine, 20) }, (_, position) => ({
        ...file,
        startLine: position + 1,
        endLine: position + 1
      }))
    ).slice(0, 120);
    architecture.chunks[0].citations = manyCitations;
    const client = await connectMcp(store, workspaceId);

    const pageResponse = await client.callTool({ name: "dkh_get_architecture", arguments: {} });
    const pageEnvelope = pageResponse.structuredContent as {
      citations: unknown[];
      result: { chunks: Array<{ citations: unknown[] }> };
    };
    expect(pageEnvelope.citations.length).toBeLessThanOrEqual(50);
    expect(pageEnvelope.result.chunks.every((chunk) => chunk.citations.length <= 8)).toBe(true);

    const releaseResponse = await client.callTool({ name: "dkh_get_release", arguments: {} });
    const releaseEnvelope = releaseResponse.structuredContent as {
      citations: unknown[];
      result: Record<string, unknown>;
    };
    expect(releaseEnvelope.citations.length).toBeLessThanOrEqual(50);
    expect(releaseEnvelope.result).toEqual(expect.objectContaining({
      pageCount: expect.any(Number),
      chunkCount: expect.any(Number),
      citationCount: expect.any(Number)
    }));
    expect(releaseEnvelope.result).not.toHaveProperty("pages");
    await app.close();
  });

  test("bounds page bodies, chunk content, and citations in the store before MCP materialization", async () => {
    const { store, workspaceId, release, index, app } = await publishedContext();
    const architecture = store.knowledgePages.find((page) => page.slug === "architecture-overview")!;
    architecture.body = "b".repeat(MAX_KNOWLEDGE_PAGE_BODY_CHARACTERS + 100);
    architecture.chunks[0].content = "c".repeat(MAX_KNOWLEDGE_CHUNK_CONTENT_CHARACTERS + 100);
    architecture.chunks[0].citations = Array.from(
      { length: MAX_KNOWLEDGE_CHUNK_CITATIONS + 5 },
      (_, indexPosition) => ({ ...index.files[0], startLine: indexPosition + 1, endLine: indexPosition + 1 })
    );

    const loaded = await store.findKnowledgePageBySlug(
      workspaceId,
      release.id,
      "architecture-overview"
    );

    expect(loaded?.body).toHaveLength(MAX_KNOWLEDGE_PAGE_BODY_CHARACTERS);
    expect(loaded?.chunks[0].content).toHaveLength(MAX_KNOWLEDGE_CHUNK_CONTENT_CHARACTERS);
    expect(loaded?.chunks[0].citations).toHaveLength(MAX_KNOWLEDGE_CHUNK_CITATIONS);
    await app.close();
  });

  test("uses all three accepted paths within eight deterministic change-context searches", async () => {
    const { store, workspaceId, app } = await publishedContext();
    const client = await connectMcp(store, workspaceId);
    const search = vi.spyOn(store, "searchKnowledge");
    const argumentsValue = {
      task: "change calculator add clamp operation range version module behavior",
      paths: [
        "src/math.ts", "src/util.js", "src/index.ts"
      ]
    };

    await client.callTool({ name: "dkh_get_change_context", arguments: argumentsValue });
    const firstQueries = search.mock.calls.map((call) => call[2]);
    expect(firstQueries.length).toBeLessThanOrEqual(8);
    expect(firstQueries).toEqual(expect.arrayContaining(argumentsValue.paths));

    search.mockClear();
    await client.callTool({ name: "dkh_get_change_context", arguments: argumentsValue });
    expect(search.mock.calls.map((call) => call[2])).toEqual(firstQueries);
    await app.close();
  });

  test("rejects four change-context paths deterministically before searching", async () => {
    const { store, workspaceId, app } = await publishedContext();
    const client = await connectMcp(store, workspaceId);
    const search = vi.spyOn(store, "searchKnowledge");
    const request = {
      name: "dkh_get_change_context",
      arguments: {
        task: "change calculator behavior",
        paths: ["src/math.ts", "src/util.js", "src/index.ts", "src/calls.ts"]
      }
    };

    const first = await client.callTool(request);
    const second = await client.callTool(request);
    const firstBody = JSON.parse(((first.content as Array<{ text: string }>)[0]).text);
    const secondBody = JSON.parse(((second.content as Array<{ text: string }>)[0]).text);

    expect(first.isError).toBe(true);
    expect(firstBody.error.code).toBe("INVALID_INPUT");
    expect(secondBody).toEqual(firstBody);
    expect(search).not.toHaveBeenCalled();
    await app.close();
  });

  test("rejects oversized strings before querying release data", async () => {
    const { store, workspaceId, app } = await publishedContext();
    const client = await connectMcp(store, workspaceId);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["dkh_search", { query: "q".repeat(501) }],
      ["dkh_get_module", { moduleId: "m".repeat(501) }],
      ["dkh_get_symbol", { name: "s".repeat(501) }],
      ["dkh_get_change_context", { task: "t".repeat(2_001) }],
      ["dkh_get_source", { path: "p".repeat(501) }],
      ["dkh_report_gap", { query: "q", reason: "r".repeat(2_001) }]
    ];

    for (const [name, args] of calls) {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError, name).toBe(true);
      expect(JSON.parse(((response.content as Array<{ text: string }>)[0]).text).error.code, name)
        .toBe("INVALID_INPUT");
    }
    await app.close();
  });

  test("returns INVALID_INPUT with deterministic details for every tool", async () => {
    const { store, workspaceId, app } = await publishedContext();
    const client = await connectMcp(store, workspaceId);
    const invalidCalls: Array<[string, Record<string, unknown>]> = [
      ["dkh_search", { limit: 0 }],
      ["dkh_get_architecture", { unexpected: true }],
      ["dkh_get_module", { moduleId: "" }],
      ["dkh_get_symbol", { name: "" }],
      ["dkh_get_change_context", { task: "", paths: [] }],
      ["dkh_get_source", { path: "src/math.ts", startLine: 0 }],
      ["dkh_get_release", { unexpected: true }],
      ["dkh_report_gap", { query: "", reason: "" }]
    ];

    for (const [name, args] of invalidCalls) {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError, name).toBe(true);
      const body = JSON.parse(((response.content as Array<{ text: string }>)[0]).text);
      expect(body.error.code, name).toBe("INVALID_INPUT");
      expect(body.error.message, name).toBe("Tool input is invalid");
      expect(body.error.details, name).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: expect.any(String), code: expect.any(String) })
      ]));
      const repeated = await client.callTool({ name, arguments: args });
      expect(JSON.parse(((repeated.content as Array<{ text: string }>)[0]).text), name).toEqual(body);
    }
    await app.close();
  });

  test("accepts exactly 500 source lines and rejects 501", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "devkh-mcp-lines-"));
    await fs.cp(fixtureRoot, root, { recursive: true });
    await fs.writeFile(
      path.join(root, "long.ts"),
      Array.from({ length: 501 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join("\n")
    );
    const { store, workspaceId, app } = await publishedContext(root);
    const client = await connectMcp(store, workspaceId);

    const accepted = await client.callTool({
      name: "dkh_get_source", arguments: { path: "long.ts", startLine: 1, endLine: 500 }
    });
    expect(accepted.isError).not.toBe(true);
    const rejected = await client.callTool({
      name: "dkh_get_source", arguments: { path: "long.ts", startLine: 1, endLine: 501 }
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.parse(((rejected.content as Array<{ text: string }>)[0]).text).error.code)
      .toBe("INVALID_INPUT");
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  test("keeps seven tools read-only and lets only report-gap create feedback", async () => {
    const { store, workspaceId, app } = await publishedContext();
    const client = await connectMcp(store, workspaceId);
    const before = JSON.stringify({
      builds: store.builds,
      releases: store.releases,
      pages: store.knowledgePages
    });
    for (const [name, args] of [
      ["dkh_search", { query: "add" }],
      ["dkh_get_architecture", {}],
      ["dkh_get_module", { moduleId: "src/math.ts" }],
      ["dkh_get_symbol", { name: "add" }],
      ["dkh_get_change_context", { task: "change add" }],
      ["dkh_get_source", { path: "src/math.ts" }],
      ["dkh_get_release", {}]
    ] as Array<[string, Record<string, unknown>]>) {
      await client.callTool({ name, arguments: args });
    }
    expect(JSON.stringify({ builds: store.builds, releases: store.releases, pages: store.knowledgePages }))
      .toBe(before);

    await client.callTool({
      name: "dkh_report_gap",
      arguments: { query: "How do I deploy?", reason: "No deployment guide", expected: "commands" }
    });
    expect((store as unknown as { feedback: unknown[] }).feedback).toHaveLength(1);
    expect(store.auditEvents.some((event) => event.action === "feedback.reported")).toBe(true);
    await app.close();
  });
});
