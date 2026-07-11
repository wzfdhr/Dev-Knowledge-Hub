import { readFile } from "node:fs/promises";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";

import {
  encryptedCredentials,
  repositories,
  sourceFiles,
  sourceSnapshots
} from "./schema";

function columnNames(table: Parameters<typeof getTableConfig>[0]) {
  return getTableConfig(table).columns.map(({ name }) => name);
}

function uniqueIndex(table: Parameters<typeof getTableConfig>[0], name: string) {
  return getTableConfig(table).indexes.find((index) => index.config.name === name)?.config.unique;
}

describe("Task 2 database contract", () => {
  test("stores repository kinds and enforces one repository per workspace", () => {
    expect(columnNames(repositories)).toEqual(expect.arrayContaining(["kind", "local_path", "clone_url"]));
    expect(uniqueIndex(repositories, "repositories_workspace_unique_idx")).toBe(true);
  });

  test("credentials belong to repositories and snapshot commits are immutable", () => {
    expect(columnNames(encryptedCredentials)).toContain("repository_id");
    expect(uniqueIndex(encryptedCredentials, "encrypted_credentials_repo_name_idx")).toBe(true);
    expect(columnNames(sourceSnapshots)).toEqual(expect.arrayContaining([
      "remote_url",
      "commit_timestamp",
      "storage_path"
    ]));
    expect(uniqueIndex(sourceSnapshots, "source_snapshots_repo_commit_idx")).toBe(true);
    expect(columnNames(sourceFiles)).toContain("byte_size");
  });

  test("checked-in migration adds secure repository snapshot fields", async () => {
    const sql = await readFile(new URL("../../drizzle/0002_secure_repository_snapshots.sql", import.meta.url), "utf8");
    expect(sql).toContain("ADD COLUMN kind text");
    expect(sql).toContain("repositories_workspace_unique_idx");
    expect(sql).toContain("encrypted_credentials_repo_name_idx");
    expect(sql).toContain("source_snapshots_repo_commit_idx");
    expect(sql).toContain("ADD COLUMN byte_size integer");
  });
});
