import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("pipeline retry scheduling migration", () => {
  test("persists retry availability before queued runs may be reclaimed", async () => {
    const sql = await readFile(path.join(repositoryRoot, "drizzle/0025_stage_run_retry_schedule.sql"), "utf8");

    expect(sql).toContain("available_at timestamptz NOT NULL DEFAULT now()");
    expect(sql).toContain("build_stage_runs_available_claim_idx");
  });
});
