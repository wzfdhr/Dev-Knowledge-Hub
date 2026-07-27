import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [
      ...configDefaults.exclude,
      "**/.worktrees/**",
      "data/**",
      "fixtures/frontend/**",
      "src/test/fixtures/**",
      "tests/e2e/**",
      "scripts/backup/**",
      "scripts/monitoring/**",
      "scripts/migrations/backfill-source-blobs.test.mjs"
    ],
    setupFiles: ["src/test/setup.ts"],
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
