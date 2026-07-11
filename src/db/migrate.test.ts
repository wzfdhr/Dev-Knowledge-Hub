import path from "node:path";

import { expect, test } from "vitest";

import { resolveMigrationDirectory } from "./migrate";

test("resolves production migrations from the application working directory", () => {
  expect(resolveMigrationDirectory("/srv/devkh")).toBe(path.join("/srv/devkh", "drizzle"));
});
