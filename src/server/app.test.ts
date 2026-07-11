import { afterEach, describe, expect, test } from "vitest";

import { buildServer } from "./app";

describe("buildServer", () => {
  afterEach(async () => {
    const app = buildServer();
    await app.close();
  });

  test("GET /api/health returns service health payload", async () => {
    const app = buildServer();

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
