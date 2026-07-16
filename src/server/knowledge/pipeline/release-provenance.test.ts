import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("pipeline release provenance migration", () => {
  test("keeps legacy releases readable and requires a matching package for pipeline provenance", async () => {
    const sql = await readFile(path.join(repositoryRoot, "drizzle/0024_release_pipeline_provenance.sql"), "utf8");

    expect(sql).toContain("kernel_mode");
    expect(sql).toContain("package_artifact_id");
    expect(sql).toContain("DEFAULT 'legacy'");
    expect(sql).toContain("Pipeline release must reference a matching package artifact");
  });

  test("exposes immutable provenance in the Drizzle release model", async () => {
    const schema = await readFile(path.join(repositoryRoot, "src/db/schema.ts"), "utf8");

    expect(schema).toContain('kernelMode: text("kernel_mode").notNull().default("legacy")');
    expect(schema).toContain('packageArtifactId: uuid("package_artifact_id")');
  });
});
