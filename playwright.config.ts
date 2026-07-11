import { defineConfig, devices } from "@playwright/test";

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
      command: "npm run dev:web -- --port 5173",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      timeout: 30_000
    }
  ],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
