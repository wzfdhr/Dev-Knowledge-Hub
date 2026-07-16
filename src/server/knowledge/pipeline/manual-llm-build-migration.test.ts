import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("manual LLM build migration", () => {
  test("persists explicit opt-in with a deterministic default", async () => {
    const sql = await readFile(path.join(repositoryRoot, "drizzle/0026_manual_llm_builds.sql"), "utf8");

    expect(sql).toContain("allow_llm boolean NOT NULL DEFAULT false");
  });
});
