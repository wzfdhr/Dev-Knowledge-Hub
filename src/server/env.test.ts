import { describe, expect, test } from "vitest";

import { loadEnv } from "./env";

describe("loadEnv", () => {
  test("test mode can load defaults without production secrets", () => {
    expect(loadEnv({ mode: "test", env: {} })).toMatchObject({
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 3000,
      dataDir: "./data"
    });
  });

  test("production mode rejects missing required secrets", () => {
    expect(() => loadEnv({ mode: "production", env: {} })).toThrow(/DATABASE_URL/);
  });
});
