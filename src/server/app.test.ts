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
});
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
