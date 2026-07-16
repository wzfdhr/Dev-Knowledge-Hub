import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("historical release backfill is batched and reports missing snapshots", async () => {
  const script = await readFile(path.join(root, "scripts/backfill-pipeline-history.mjs"), "utf8");

  assert.match(script, /const BATCH_SIZE = 500/);
  assert.match(script, /missingSnapshots/);
  assert.match(script, /kernel_mode = 'legacy'/);
});
