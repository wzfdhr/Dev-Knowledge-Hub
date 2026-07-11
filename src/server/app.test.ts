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
});
