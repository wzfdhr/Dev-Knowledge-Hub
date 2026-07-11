import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { analyzeSnapshot } from "./intelligence";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/code-intelligence"
);
const fixtureBase = path.dirname(fixtureRoot);
const resolutionFixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../test-fixtures/tsconfig-resolution"
);
const commitSha = "a".repeat(40);

describe("analyzeSnapshot", () => {
  test("extracts TS and JS symbols with exact line citations", async () => {
    const index = await analyzeSnapshot(fixtureRoot, commitSha);

    expect(index.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "src/math.ts", kind: "module", startLine: 1, endLine: 20 }),
      expect.objectContaining({ name: "Range", kind: "interface", path: "src/math.ts", startLine: 3, endLine: 6 }),
      expect.objectContaining({ name: "Operation", kind: "type", startLine: 8, endLine: 8 }),
      expect.objectContaining({ name: "Calculator", kind: "class", startLine: 10, endLine: 14 }),
      expect.objectContaining({ name: "add", kind: "function", path: "src/math.ts", startLine: 16, endLine: 18 }),
      expect.objectContaining({ name: "VERSION", kind: "variable", startLine: 20, endLine: 20 }),
      expect.objectContaining({ name: "Calculator", kind: "export", path: "src/index.ts", startLine: 1, endLine: 1 }),
      expect.objectContaining({ name: "clamp", kind: "function", path: "src/util.js", startLine: 1, endLine: 3 })
    ]));
    expect(index.symbols.every((symbol) =>
      symbol.commitSha === commitSha && symbol.blobHash.length === 64
    )).toBe(true);
  });

  test("extracts resolvable edges and package dependencies deterministically", async () => {
    const index = await analyzeSnapshot(fixtureRoot, commitSha);
    const edges = index.edges.map(({ kind, source, target }) => `${kind}:${source}->${target}`);

    expect(edges).toEqual(expect.arrayContaining([
      "imports:src/math.ts->src/util.js",
      "exports:src/index.ts->src/math.ts",
      "calls:Calculator.add->add",
      "calls:Calculator.add->clamp",
      "test-of:test/math.test.ts->src/math.ts",
      "package-dependency:fixture-app->left-pad",
      "module-dependency:src/math.ts->src/util.js"
    ]));
    expect(edges).toEqual([...edges].sort());
  });

  test("extracts Markdown, JSON, YAML, scripts, tsconfig, and test configs", async () => {
    const index = await analyzeSnapshot(fixtureRoot, commitSha);

    expect(index.documents.find((document) => document.path === "README.md")?.headings)
      .toEqual([
        { text: "Fixture App", level: 1, line: 1 },
        { text: "Development", level: 2, line: 3 }
      ]);
    expect(index.configs.find((config) => config.path === "config.yaml")?.keys)
      .toEqual(["service", "service.features", "service.features.search", "service.port"]);
    expect(index.configs.find((config) => config.path === "tsconfig.json")?.kind).toBe("tsconfig");
    expect(index.configs.map((config) => config.kind)).toEqual(expect.arrayContaining([
      "package", "playwright", "vitest"
    ]));
    expect(index.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "test", kind: "package-script", path: "package.json", startLine: 4, endLine: 4 }),
      expect.objectContaining({ name: "e2e", kind: "package-script", path: "package.json", startLine: 5, endLine: 5 })
    ]));
  });

  test("emits calls only when the compiler resolves an in-snapshot declaration", async () => {
    const index = await analyzeSnapshot(fixtureRoot, commitSha);
    const calls = index.edges.filter((edge) =>
      edge.kind === "calls" && edge.citation.path === "src/calls.ts"
    );

    expect(calls.map((edge) => `${edge.source}->${edge.target}@${edge.targetPath}`)).toEqual([
      "exercise->directLocal@src/calls.ts",
      "exercise->execute@src/calls.ts",
      "exercise->localMethod@src/call-targets.ts",
      "exercise->original@src/call-targets.ts",
      "exercise->original@src/call-targets.ts",
      "exercise->run@src/call-targets.ts"
    ]);
    expect(calls.map((edge) => edge.target)).not.toEqual(expect.arrayContaining([
      "generatedCall", "max", "packageCall", "stringify", "value"
    ]));
  });

  test("loads path aliases but rejects resolved declarations outside the indexed file set", async () => {
    const index = await analyzeSnapshot(resolutionFixtureRoot, commitSha);
    const calls = index.edges.filter((edge) => edge.kind === "calls");

    expect(calls.map((edge) => `${edge.target}@${edge.targetPath}`)).toEqual([
      "aliasedCall@src/target.ts"
    ]);
    expect(calls.map((edge) => edge.target)).not.toEqual(expect.arrayContaining([
      "generatedCall", "packageCall"
    ]));
    expect(index.files.map((file) => file.path)).not.toEqual(expect.arrayContaining([
      "dist/generated.d.ts", "node_modules/internal-pkg/index.d.ts"
    ]));
  });

  test("uses safe compiler defaults when repository tsconfig is absent or invalid", async () => {
    const [absent, invalid] = await Promise.all([
      analyzeSnapshot(path.join(fixtureBase, "no-tsconfig"), commitSha),
      analyzeSnapshot(path.join(fixtureBase, "invalid-tsconfig"), commitSha)
    ]);

    expect(absent.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "calls", target: "defaultCall", targetPath: "src/main.ts" })
    ]));
    expect(invalid.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "calls", target: "localCall", targetPath: "src/main.ts" })
    ]));
  });
});
