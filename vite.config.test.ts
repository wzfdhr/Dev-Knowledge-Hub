import { readFile } from "node:fs/promises";

import { expect, test } from "vitest";

test("proxies local development API calls to production by default", async () => {
  const source = await readFile(new URL("./vite.config.ts", import.meta.url), "utf8");

  expect(source).toContain("DEVKH_API_PROXY_TARGET");
  expect(source).toContain("izbp13w996yh3m83ypf3crz.tailf6e278.ts.net");
  expect(source).toContain("cookie.replace");
});
