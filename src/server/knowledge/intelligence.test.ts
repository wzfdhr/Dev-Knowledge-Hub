import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { analyzeSnapshot, SnapshotIntegrityError } from "./intelligence";

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

  test("accepts only an exact persisted file set with matching raw-byte hashes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-integrity-valid-"));
    const content = Buffer.from("export const answer = 42;\n");
    const blobHash = createHash("sha256").update(content).digest("hex");
    try {
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "src", "answer.ts"), content);

      const index = await analyzeSnapshot(
        root,
        commitSha,
        new Map([["src/answer.ts", blobHash]])
      );

      expect(index.files).toEqual([
        expect.objectContaining({ path: "src/answer.ts", blobHash })
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "missing persisted metadata",
      files: [["src/present.ts", Buffer.from("export {};\n")]] as const,
      hashes: new Map<string, string>(),
      detail: "persisted file metadata is missing"
    },
    {
      name: "a missing disk file",
      files: [] as const,
      hashes: new Map([["src/missing.ts", "f".repeat(64)]]),
      detail: "file set mismatch"
    },
    {
      name: "an extra disk file",
      files: [["src/extra.ts", Buffer.from("export {};\n")]] as const,
      hashes: new Map([["src/known.ts", "f".repeat(64)]]),
      detail: "file set mismatch"
    },
    {
      name: "tampered bytes",
      files: [["src/tampered.ts", Buffer.from("export const value = 2;\n")]] as const,
      hashes: new Map([["src/tampered.ts", createHash("sha256").update("export const value = 1;\n").digest("hex")]]),
      detail: "hash mismatch for src/tampered.ts"
    },
    {
      name: "invalid UTF-8",
      files: [["src/invalid.ts", Buffer.from([0xc3, 0x28, 0x0a])]] as const,
      hashes: new Map([["src/invalid.ts", createHash("sha256").update(Buffer.from([0xc3, 0x28, 0x0a])).digest("hex")]]),
      detail: "invalid UTF-8 for src/invalid.ts"
    }
  ])("rejects $name with the stable integrity error", async ({ files, hashes, detail }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-integrity-invalid-"));
    try {
      for (const [relativePath, content] of files) {
        await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
        await writeFile(path.join(root, relativePath), content);
      }

      await expect(analyzeSnapshot(root, commitSha, hashes)).rejects.toMatchObject({
        name: SnapshotIntegrityError.name,
        code: "SNAPSHOT_INTEGRITY_FAILED",
        message: `Snapshot integrity failed: ${detail}`
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skips invalid UTF-8 text even when it contains no NUL byte", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-invalid-utf8-"));
    try {
      await writeFile(path.join(root, "invalid.ts"), Buffer.from([0xc3, 0x28, 0x0a]));

      const index = await analyzeSnapshot(root, commitSha);

      expect(index.files).toEqual([]);
      expect(index.symbols).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
