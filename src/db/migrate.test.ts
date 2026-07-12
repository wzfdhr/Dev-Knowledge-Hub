import { readdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";

import { resolveMigrationDirectory } from "./migrate";

test("resolves production migrations from the application working directory", () => {
  expect(resolveMigrationDirectory("/srv/devkh")).toBe(path.join("/srv/devkh", "drizzle"));
});

test("assigns every migration a unique ordered prefix", async () => {
  const names = (await readdir(resolveMigrationDirectory()))
    .filter((name) => name.endsWith(".sql"));
  const prefixes = names.map((name) => name.split("_", 1)[0]);

  expect(new Set(prefixes).size).toBe(prefixes.length);
});
