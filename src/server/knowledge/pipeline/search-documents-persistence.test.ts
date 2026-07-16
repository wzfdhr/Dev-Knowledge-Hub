import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import * as schema from "../../../db/schema";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("pipeline search document persistence", () => {
  test("keeps shadow search documents scoped to their build and source artifact", async () => {
    const sql = await readFile(path.join(repositoryRoot, "drizzle/0023_pipeline_search_documents.sql"), "utf8");

    expect(sql).toContain("CREATE TABLE pipeline_search_documents");
    expect(sql).toContain("source_artifact_id");
    expect(sql).toContain("UNIQUE (source_artifact_id, document_key)");
    expect(sql).toContain("pipeline_search_documents_scope_idx");
    expect(schema).toHaveProperty("pipelineSearchDocuments");
  });
});
