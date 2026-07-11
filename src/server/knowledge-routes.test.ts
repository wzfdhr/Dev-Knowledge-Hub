import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { buildServer } from "./app";
import { BuildService, type BuildJobQueue } from "./knowledge/build-service";
import { generateKnowledge } from "./knowledge/generator";
import { analyzeSnapshot } from "./knowledge/intelligence";
import { MemoryAppStore } from "./persistence/memory-store";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../test/fixtures/code-intelligence"
);

class TestQueue implements BuildJobQueue {
  sent: string[] = [];
  async send(buildId: string) { this.sent.push(buildId); }
  async start() {}
  async stop() {}
}

async function authenticatedApp() {
  const store = new MemoryAppStore();
  const buildService = new BuildService(store, new TestQueue());
  const app = buildServer({
    store,
    buildService,
    masterKey: Buffer.alloc(32, 3).toString("base64"),
    sessionSecret: "knowledge-route-session-secret",
    dataDir: "/tmp/devkh-knowledge-route",
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
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
  const connected = await app.inject({
    method: "POST", url: "/api/repositories", headers: { cookie },
    payload: { kind: "local", name: "Fixture", path: fixtureRoot }
  });
  const repositoryId = connected.json().repository.id as string;
  const workspaceId = (await store.defaultWorkspace())!.id;
  const index = await analyzeSnapshot(fixtureRoot, "1".repeat(40));
  await store.createSnapshot({
    snapshot: {
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId,
      repositoryId,
      commitSha: index.commitSha,
      ref: "main",
      remoteUrl: null,
      commitTimestamp: new Date("2026-07-11T00:00:00Z"),
      storagePath: fixtureRoot
    },
    files: index.files.map((file, position) => ({
      id: `00000000-0000-4000-8000-${String(position + 1).padStart(12, "0")}`,
      workspaceId,
      snapshotId: "11111111-1111-4111-8111-111111111111",
      path: file.path,
      byteSize: 1,
      contentHash: file.blobHash,
      language: null
    }))
  });
  return { app, store, buildService, cookie, repositoryId, workspaceId, index };
}

describe("knowledge API contracts", () => {
  test("starts, lists, reads, cancels, and streams build state", async () => {
    const { app, cookie } = await authenticatedApp();
    const started = await app.inject({
      method: "POST", url: "/api/builds", headers: { cookie },
      payload: { snapshotId: "11111111-1111-4111-8111-111111111111" }
    });
    expect(started.statusCode).toBe(202);
    const buildId = started.json().build.id as string;

    expect((await app.inject({ method: "GET", url: "/api/builds", headers: { cookie } })).json().builds)
      .toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/api/builds/${buildId}`, headers: { cookie } })).statusCode)
      .toBe(200);
    expect((await app.inject({
      method: "POST", url: `/api/builds/${buildId}/cancel`, headers: { cookie }
    })).json().build.cancelRequested).toBe(true);
    const events = await app.inject({
      method: "GET", url: `/api/builds/${buildId}/events?once=true`, headers: { cookie }
    });
    expect(events.headers["content-type"]).toContain("text/event-stream");
    expect(events.body).toContain("event: build");
    expect(events.body).toContain("\"status\":\"queued\"");
    await app.close();
  });

  test("drafts and manually publishes a release, then serves pages, search, and source", async () => {
    const { app, store, cookie, repositoryId, workspaceId, index } = await authenticatedApp();
    const build = (await store.createBuild({
      workspaceId,
      repositoryId,
      snapshotId: "11111111-1111-4111-8111-111111111111",
      snapshotPath: fixtureRoot,
      commitSha: index.commitSha
    })).build;
    await store.saveKnowledge({ build, index, output: await generateKnowledge(index) });
    await store.transitionBuild(build.id, "ready");

    const draft = await app.inject({
      method: "POST", url: "/api/releases", headers: { cookie },
      payload: { buildId: build.id, version: "1.0.0" }
    });
    expect(draft.statusCode).toBe(201);
    expect((await app.inject({
      method: "GET", url: "/api/releases/current", headers: { cookie }
    })).statusCode).toBe(404);
    const releaseId = draft.json().release.id as string;
    expect((await app.inject({
      method: "POST", url: `/api/releases/${releaseId}/publish`, headers: { cookie }
    })).statusCode).toBe(200);

    const pages = await app.inject({ method: "GET", url: "/api/knowledge/pages", headers: { cookie } });
    expect(pages.json().pages.length).toBeGreaterThan(4);
    const pageId = pages.json().pages[0].id as string;
    expect((await app.inject({
      method: "GET", url: `/api/knowledge/pages/${encodeURIComponent(pageId)}`, headers: { cookie }
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "GET", url: "/api/knowledge/search?q=add", headers: { cookie }
    })).json().results[0].kind).toBe("symbol");
    const source = await app.inject({
      method: "GET",
      url: "/api/knowledge/source?path=src/math.ts&startLine=16&endLine=18",
      headers: { cookie }
    });
    expect(source.json()).toEqual(expect.objectContaining({
      path: "src/math.ts", startLine: 16, endLine: 18
    }));
    expect(source.json().content).toContain("export function add");
    expect((await app.inject({ method: "GET", url: "/api/releases", headers: { cookie } })).json().releases)
      .toHaveLength(1);
    await app.close();
  });
});
