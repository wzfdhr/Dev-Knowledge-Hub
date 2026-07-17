import { describe, expect, test } from "vitest";

import { buildKnowledgeGraph, validateKnowledgeGraph } from "./graph";

const sourceRef = {
  snapshotId: "snapshot-1",
  path: "src/math.ts",
  startLine: 1,
  endLine: 4,
  blobHash: "a".repeat(64)
};

describe("buildKnowledgeGraph", () => {
  test("creates sourced facts for known modules, symbols, tables, and static imports", () => {
    const graph = buildKnowledgeGraph({
      projectId: "project-1",
      ir: {
        schemaVersion: 1,
        snapshotId: "snapshot-1",
        files: [
          { path: "src/math.ts", language: "typescript", contentDigest: "b".repeat(64), lineCount: 4, sourceRef },
          { path: "src/util.ts", language: "typescript", contentDigest: "c".repeat(64), lineCount: 1, sourceRef: { ...sourceRef, path: "src/util.ts", endLine: 1 } }
        ],
        symbols: [{ id: "symbol-add", kind: "function", name: "add", qualifiedName: "add", signature: "(a, b)", sourceRef }],
        imports: [{ fromPath: "src/math.ts", specifier: "./util", kind: "static", sourceRef }],
        documents: [{ id: "document-readme", title: "Guide", text: "Run tests.", sourceRef: { ...sourceRef, path: "README.md", endLine: 1 } }],
        tables: [{
          id: "table-users", name: "users", sourcePath: "data/users.csv", rowCount: 1, candidate: false,
          sourceRefs: [{ ...sourceRef, path: "data/users.csv", endLine: 2 }],
          columns: [{ name: "email", type: "string", nullable: false, sensitive: true, formulaLike: false, sourceRefs: [{ ...sourceRef, path: "data/users.csv", endLine: 2 }] }]
        }],
        sourceRefs: [sourceRef]
      }
    });

    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "module", qualifiedName: "src/math.ts", candidate: false }),
      expect.objectContaining({ kind: "symbol", qualifiedName: "add", candidate: false }),
      expect.objectContaining({ kind: "table", qualifiedName: "data/users.csv", candidate: false }),
      expect.objectContaining({ kind: "column", qualifiedName: "data/users.csv.email", candidate: false })
    ]));
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "imports", candidate: false }),
      expect.objectContaining({ kind: "contains", candidate: false })
    ]));
    expect(() => validateKnowledgeGraph(graph)).not.toThrow();
  });

  test("marks dynamic and unresolved imports as candidates instead of asserting unsupported facts", () => {
    const graph = buildKnowledgeGraph({
      projectId: "project-1",
      ir: {
        schemaVersion: 1, snapshotId: "snapshot-1",
        files: [{ path: "src/main.ts", language: "typescript", contentDigest: "b".repeat(64), lineCount: 1, sourceRef }],
        symbols: [],
        imports: [
          { fromPath: "src/main.ts", specifier: "./missing", kind: "static", sourceRef },
          { fromPath: "src/main.ts", specifier: "./lazy", kind: "dynamic", sourceRef }
        ],
        documents: [], tables: [], sourceRefs: [sourceRef]
      }
    });

    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidate: true, candidateReason: "unresolved_import" }),
      expect.objectContaining({ candidate: true, candidateReason: "dynamic_import" })
    ]));
    expect(() => validateKnowledgeGraph({ ...graph, edges: [{ ...graph.edges[0]!, candidate: false, sourceRefs: [] }] }))
      .toThrow("Graph fact edge has no source references");
  });

  test("merges repeated deterministic edges while retaining every source reference", () => {
    const secondImport = { ...sourceRef, startLine: 3, endLine: 3 };
    const graph = buildKnowledgeGraph({
      projectId: "project-1",
      ir: {
        schemaVersion: 1, snapshotId: "snapshot-1",
        files: [
          { path: "src/main.ts", language: "typescript", contentDigest: "b".repeat(64), lineCount: 3, sourceRef },
          { path: "src/util.ts", language: "typescript", contentDigest: "c".repeat(64), lineCount: 1, sourceRef: { ...sourceRef, path: "src/util.ts", endLine: 1 } }
        ],
        symbols: [],
        imports: [
          { fromPath: "src/main.ts", specifier: "./util", kind: "static", sourceRef },
          { fromPath: "src/main.ts", specifier: "./util", kind: "static", sourceRef: secondImport }
        ],
        documents: [], tables: [], sourceRefs: [sourceRef, secondImport]
      }
    });

    const imports = graph.edges.filter((item) => item.kind === "imports");
    expect(imports).toHaveLength(1);
    expect(imports[0]?.sourceRefs).toEqual([sourceRef, secondImport]);
  });
});
