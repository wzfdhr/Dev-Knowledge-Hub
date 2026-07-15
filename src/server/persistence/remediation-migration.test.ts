import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("remediation identity migration", () => {
  test("assigns every legacy case a lint issue identity and enforces one case per source build", async () => {
    const sql = await readFile(path.join(repositoryRoot, "drizzle/0022_remediation_issue_identity.sql"), "utf8");

    expect(sql).toContain("ADD COLUMN issue_id text");
    expect(sql).toContain("SET issue_id = issue->>'id'");
    expect(sql).toContain("UNIQUE (workspace_id, source_build_id, issue_id)");
  });
});
