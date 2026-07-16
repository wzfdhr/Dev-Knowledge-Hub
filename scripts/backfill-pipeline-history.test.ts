import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("pipeline history backfill", () => {
  test("is batched and reports missing snapshots", async () => {
    const script = await readFile(path.join(root, "scripts/backfill-pipeline-history.mjs"), "utf8");

    expect(script).toContain("const BATCH_SIZE = 500");
    expect(script).toContain("missingSnapshots");
    expect(script).toContain("kernel_mode = 'legacy'");
  });
});
