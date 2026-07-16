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
    expect(sql).toContain("missing a non-empty issue.id");
    expect(sql).toContain("duplicate issue identities");
  });

  test("preserves legacy history while requiring dismissal reasons for new events", async () => {
    const sql = await readFile(path.join(repositoryRoot, "drizzle/0029_remediation_dismissal_reason.sql"), "utf8");

    expect(sql).toContain("ADD COLUMN reason text");
    expect(sql).toContain("remediation_events_dismissal_reason_check");
    expect(sql).toContain("NOT VALID");
    expect(sql).toContain("char_length(reason) <= 500");
  });
});
