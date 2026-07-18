import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "**/.worktrees/**", "fixtures/frontend/**", "src/test/fixtures/**", "tests/e2e/**", "scripts/backup/**", "scripts/monitoring/**"],
    setupFiles: ["src/test/setup.ts"],
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
