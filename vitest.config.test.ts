import { readFile } from "node:fs/promises";

import { expect, test } from "vitest";

test("keeps runtime project snapshots out of the unit-test scan", async () => {
  const source = await readFile(new URL("./vitest.config.ts", import.meta.url), "utf8");

  expect(source).toContain('"data/**"');
});
