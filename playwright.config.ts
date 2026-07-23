import { defineConfig, devices } from "@playwright/test";

const apiPort = Number(process.env.E2E_API_PORT ?? 3000);
const webPort = Number(process.env.E2E_WEB_PORT ?? 5173);
const apiURL = `http://127.0.0.1:${apiPort}`;
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  webServer: [
    {
      command: `E2E_API_PORT=${apiPort} npm run dev:e2e-server`,
      url: `${apiURL}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: `DEVKH_API_PROXY_TARGET=${apiURL} npm run dev:web -- --port ${webPort}`,
      url: baseURL,
      reuseExistingServer: false,
      timeout: 30_000
    }
  ],
  use: {
    baseURL,
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
