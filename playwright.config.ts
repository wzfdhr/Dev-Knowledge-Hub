import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_WEB_PORT ?? 5173);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  webServer: [
    {
      command: "npm run dev:e2e-server",
      url: "http://127.0.0.1:3000/api/health",
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: `DEVKH_API_PROXY_TARGET=http://127.0.0.1:3000 npm run dev:web -- --port ${port}`,
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
