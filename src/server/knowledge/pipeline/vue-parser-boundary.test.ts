import { readFile } from "node:fs/promises";

import { expect, test } from "vitest";

test("keeps the Vue SFC compiler as a server-side parser boundary", async () => {
  const [extractorSource, packageJsonSource] = await Promise.all([
    readFile(new URL("./extract-vue.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../../package.json", import.meta.url), "utf8")
  ]);
  const packageJson = JSON.parse(packageJsonSource) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  expect(extractorSource).toContain('from "@vue/compiler-sfc"');
  expect(packageJson.dependencies["@vue/compiler-sfc"]).toEqual(expect.any(String));
  expect(packageJson.dependencies.vue).toBeUndefined();
  expect(packageJson.devDependencies["@vitejs/plugin-vue"]).toBeUndefined();
});
