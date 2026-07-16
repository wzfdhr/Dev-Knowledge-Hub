import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("pipeline history backfill", () => {
  test("scans legacy releases in batches without a release mutation query", async () => {
    const script = await readFile(path.join(root, "scripts/backfill-pipeline-history.mjs"), "utf8");

    expect(script).toContain("const BATCH_SIZE = 500");
    expect(script).toContain("missingSnapshots");
    expect(script).toContain("legacyReleasesRetained");
    expect(script).toContain("legacy-provenance-only");
    expect(script).not.toContain("UPDATE releases");
  });

  test("limits reports to a protected root and validates repository provenance", async () => {
    const script = await readFile(path.join(root, "scripts/backfill-pipeline-history.mjs"), "utf8");

    expect(script).toContain("DEVKH_DATA_DIR");
    expect(script).toContain("flag: \"wx\"");
    expect(script).toContain("rename(");
    expect(script).toContain("reportName === \".\" || reportName === \"..\"");
    expect(script).toContain("reportName === \"\"");
    expect(script).toContain("b.repository_id = r.repository_id");
    expect(script).toContain("s.repository_id = r.repository_id");
    expect(script).toContain("r.snapshot_id = b.snapshot_id");
  });
});
