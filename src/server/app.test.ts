import { describe, expect, test } from "vitest";

import { buildServer } from "./app";
import { MemoryAppStore } from "./persistence/memory-store";

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
    await writeFile(path.join(clientDir, "index.html"), "<main>console entrypoint</main>");
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
    expect(response.body).toContain("console entrypoint");
    await app.close();
  });
});
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
