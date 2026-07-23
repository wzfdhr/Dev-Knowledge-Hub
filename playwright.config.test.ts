import { afterEach, describe, expect, test, vi } from "vitest";

describe("Playwright server isolation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test("uses independent API and web ports from the environment", async () => {
    vi.stubEnv("E2E_API_PORT", "43001");
    vi.stubEnv("E2E_WEB_PORT", "43002");
    vi.resetModules();

    const { default: config } = await import("./playwright.config");
    const servers = Array.isArray(config.webServer) ? config.webServer : [config.webServer];

    expect(servers[0]?.url).toBe("http://127.0.0.1:43001/api/health");
    expect(servers[0]?.command).toContain("E2E_API_PORT=43001");
    expect(servers[1]?.url).toBe("http://127.0.0.1:43002");
    expect(servers[1]?.command).toContain("DEVKH_API_PROXY_TARGET=http://127.0.0.1:43001");
  });
});
