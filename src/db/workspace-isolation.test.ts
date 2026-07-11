import { readFile } from "node:fs/promises";

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";

import {
  adminUsers,
  agentFeedback,
  auditEvents,
  buildJobs,
  codeEdges,
  codeSymbols,
  knowledgeChunks,
  knowledgePages,
  mcpTokens,
  releaseChannels,
  releases,
  repositories,
  sourceFiles,
  sourceSnapshots
} from "./schema";

function expectCompositeIdentity(table: PgTable, indexName: string) {
  const index = getTableConfig(table).indexes.find(({ config }) => config.name === indexName);
  expect(index?.config.unique).toBe(true);
  expect(index?.config.columns.map((column) => "name" in column ? column.name : undefined)).toEqual([
    "id",
    "workspace_id"
  ]);
}

function expectCompositeReference(
  table: PgTable,
  columns: string[],
  foreignColumns: string[]
) {
  const references = getTableConfig(table).foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference();
    return {
      columns: reference.columns.map(({ name }) => name),
      foreignColumns: reference.foreignColumns.map(({ name }) => name)
    };
  });

  expect(references).toContainEqual({ columns, foreignColumns });
}

describe("workspace-isolated database relations", () => {
  test("repository snapshots and files cannot cross workspaces", () => {
    expectCompositeIdentity(repositories, "repositories_id_workspace_idx");
    expectCompositeReference(sourceSnapshots, ["repository_id", "workspace_id"], ["id", "workspace_id"]);
    expectCompositeIdentity(sourceSnapshots, "source_snapshots_id_workspace_idx");
    expectCompositeReference(sourceFiles, ["snapshot_id", "workspace_id"], ["id", "workspace_id"]);
  });

  test("build pages and chunks retain workspace ownership", () => {
    expectCompositeIdentity(buildJobs, "build_jobs_id_workspace_idx");
    expectCompositeReference(knowledgePages, ["build_job_id", "workspace_id"], ["id", "workspace_id"]);
    expectCompositeIdentity(knowledgePages, "knowledge_pages_id_workspace_idx");
    expectCompositeReference(knowledgeChunks, ["page_id", "workspace_id"], ["id", "workspace_id"]);
  });

  test("release channels cannot select a release from another workspace", () => {
    expectCompositeIdentity(releases, "releases_id_workspace_idx");
    expectCompositeReference(releaseChannels, ["release_id", "workspace_id"], ["id", "workspace_id"]);
  });

  test("tokens feedback and audit events have enforced ownership", () => {
    expectCompositeIdentity(mcpTokens, "mcp_tokens_id_workspace_idx");
    expectCompositeReference(mcpTokens, ["workspace_id"], ["id"]);
    expectCompositeReference(agentFeedback, ["page_id", "workspace_id"], ["id", "workspace_id"]);
    expectCompositeReference(auditEvents, ["actor_id", "workspace_id"], ["id", "workspace_id"]);
  });

  test("all symbol edges use workspace-isolated parent references", () => {
    expectCompositeReference(codeSymbols, ["source_file_id", "workspace_id"], ["id", "workspace_id"]);
    expectCompositeReference(codeEdges, ["source_symbol_id", "workspace_id"], ["id", "workspace_id"]);
    expectCompositeReference(codeEdges, ["target_symbol_id", "workspace_id"], ["id", "workspace_id"]);
    expectCompositeIdentity(adminUsers, "admin_users_id_workspace_idx");
  });

  test("checked-in SQL declares composite ownership constraints", async () => {
    const sql = await readFile(new URL("../../drizzle/0001_initial.sql", import.meta.url), "utf8");

    expect(sql).toContain("UNIQUE (id, workspace_id)");
    expect(sql).toContain("FOREIGN KEY (repository_id, workspace_id) REFERENCES repositories(id, workspace_id)");
    expect(sql).toContain("FOREIGN KEY (snapshot_id, workspace_id) REFERENCES source_snapshots(id, workspace_id)");
    expect(sql).toContain("FOREIGN KEY (build_job_id, workspace_id) REFERENCES build_jobs(id, workspace_id)");
    expect(sql).toContain("FOREIGN KEY (page_id, workspace_id) REFERENCES knowledge_pages(id, workspace_id)");
    expect(sql).toContain("FOREIGN KEY (release_id, workspace_id) REFERENCES releases(id, workspace_id)");
    expect(sql).toContain("FOREIGN KEY (actor_id, workspace_id) REFERENCES admin_users(id, workspace_id)");
  });
});
