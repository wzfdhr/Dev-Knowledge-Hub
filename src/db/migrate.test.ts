import { readFile, readdir } from "node:fs/promises";
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

test("defines an immutable workspace-scoped source analysis cache migration", async () => {
  const sql = await readFile(path.join(resolveMigrationDirectory(), "0032_source_analysis_artifacts.sql"), "utf8");

  expect(sql).toMatch(/CREATE TABLE source_analysis_artifacts/);
  expect(sql).toMatch(/PRIMARY KEY \(workspace_id, content_hash, analyzer_id, analyzer_version, parser_config_digest\)/);
  expect(sql).toMatch(/REFERENCES workspaces\(id\) ON DELETE CASCADE/);
  expect(sql).toMatch(/jsonb_typeof\(facts\) = 'object'/);
  expect(sql).toMatch(/octet_length\(facts::text\) <= 8388608/);
  expect(sql).toMatch(/source analysis artifacts are immutable/);
  expect(sql).not.toMatch(/project_id|snapshot_id|source_refs|storage_key/);
});
