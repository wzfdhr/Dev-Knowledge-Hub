import { readFile } from "node:fs/promises";

import { expect, test } from "vitest";

test("proxies local development API calls to production by default", async () => {
  const source = await readFile(new URL("./vite.config.ts", import.meta.url), "utf8");

  expect(source).toContain("DEVKH_API_PROXY_TARGET");
  expect(source).toContain("izbp13w996yh3m83ypf3crz.tailf6e278.ts.net");
  expect(source).toContain("cookie.replace");
});

test("builds the Vue console as a separate entry without replacing React", async () => {
  const source = await readFile(new URL("./vite.config.ts", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  expect(source).toContain("@vitejs/plugin-vue");
  expect(source).toContain("vue()");
  expect(source).toContain("console-vue/index.html");
  expect(source).toContain("index.html");
  expect(packageJson.dependencies.vue).toBe("^3.5.13");
  expect(packageJson.devDependencies["@vitejs/plugin-vue"]).toBe("^6.0.8");
  expect(packageJson.dependencies["aheart-ui"]).toBeUndefined();
  expect(packageJson.dependencies["ant-design-vue"]).toBeUndefined();
  expect(packageJson.dependencies["element-plus"]).toBeUndefined();
});
