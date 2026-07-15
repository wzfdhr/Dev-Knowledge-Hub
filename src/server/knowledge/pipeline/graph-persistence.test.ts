import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("knowledge graph migration", () => {
  test("persists sourced nodes and protects fact edges from dangling endpoints", async () => {
    const sql = await readFile(path.join(repositoryRoot, "drizzle/0020_knowledge_graph.sql"), "utf8");

    expect(sql).toContain("CREATE TABLE knowledge_graph_nodes");
    expect(sql).toContain("CREATE TABLE knowledge_graph_edges");
    expect(sql).toContain("candidate_reason");
    expect(sql).toContain("enforce_knowledge_graph_fact_edge");
    expect(sql).toContain("Graph fact edge has a dangling node");
  });
});
