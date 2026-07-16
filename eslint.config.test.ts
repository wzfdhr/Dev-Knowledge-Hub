import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

describe("ESLint configuration", () => {
  test("ignores Playwright result artifacts", async () => {
    const config = await readFile(new URL("./eslint.config.js", import.meta.url), "utf8");

    expect(config).toContain('"test-results"');
  });
});
