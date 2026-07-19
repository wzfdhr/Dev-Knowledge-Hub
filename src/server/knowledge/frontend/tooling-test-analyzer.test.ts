import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { analyzeToolingTestSource } from "./tooling-test-analyzer.js";

function input(path: string, content: string) {
  return {
    snapshotId: "snapshot-tooling",
    path,
    content,
    blobHash: createHash("sha256").update(content).digest("hex"),
    packageKey: "app",
    resolutions: [{ specifier: "./app", resolvedPath: "src/app.tsx" }]
  };
}

describe("analyzeToolingTestSource", () => {
  test("models Vite plugins, aliases, proxy, build, and test configuration", () => {
    const content = [
      "import react from '@vitejs/plugin-react';",
      "import { defineConfig } from 'vite';",
      "export default defineConfig({ plugins: [react()], resolve: { alias: { '@': './src' } }, build: { sourcemap: true, rollupOptions: { output: { manualChunks: { vendor: ['react'] } } } }, server: { proxy: { '/api': 'http://127.0.0.1:3000' } }, test: { environment: 'jsdom' } });"
    ].join("\n");
    const output = analyzeToolingTestSource(input("vite.config.ts", content));

    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "tooling_config",
        name: "vite",
        facets: { "tooling-test-core": expect.objectContaining({
          plugins: ["react"], aliases: ["@"], proxyPaths: ["/api"], manualChunks: ["vendor"], testEnvironment: "jsdom"
        }) }
      })
    ]));
  });

  test("models component tests, render targets, mocks, and fixtures", () => {
    const content = [
      "import { render, screen } from '@testing-library/react';",
      "import { describe, expect, test, vi, beforeEach } from 'vitest';",
      "import { App } from './app';",
      "beforeEach(() => vi.restoreAllMocks());",
      "describe('App', () => { test('renders heading', () => { vi.mock('./api'); render(<App />); expect(screen.getByRole('heading')).toBeDefined(); }); });"
    ].join("\n");
    const output = analyzeToolingTestSource(input("src/app.test.tsx", content));

    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "test_case", name: "renders heading", attributes: { testKind: { state: "known", value: "component" } } }),
      expect.objectContaining({ kind: "test_fixture", name: "beforeEach" })
    ]));
    expect(output.edges).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "tests" })]));
  });

  test("models Playwright routes, locators, and network mocks", () => {
    const content = "test('opens dashboard', async ({ page }) => { await page.route('**/api/**', route => route.fulfill({ json: {} })); await page.goto('/dashboard'); await expect(page.getByRole('heading')).toBeVisible(); });";
    const output = analyzeToolingTestSource(input("e2e/dashboard.spec.ts", content));
    const scenario = output.entities.find((entity) => entity.kind === "test_case");

    expect(scenario).toMatchObject({
      attributes: { testKind: { state: "known", value: "e2e" } },
      facets: { "tooling-test-core": expect.objectContaining({ routes: ["/dashboard"], locators: ["getByRole"], networkMocks: ["**/api/**"] }) }
    });
  });

  test("keeps secondary frontend tooling at explicit basic recognition", () => {
    const content = "export default { stories: ['../src/**/*.stories.tsx'], addons: ['@storybook/addon-a11y'] };";
    const output = analyzeToolingTestSource(input(".storybook/main.ts", content));

    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "tooling_config",
        name: "storybook",
        completeness: "partial",
        facets: { "tooling-test-core": expect.objectContaining({ supportLevel: "basic-recognition" }) }
      })
    ]));
  });
});
