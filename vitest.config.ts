import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "src/test/fixtures/**", "tests/e2e/**"],
    setupFiles: ["src/test/setup.ts"],
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
