import { describe, expect, test } from "vitest";

import { extractWebSource } from "./extract-web";

const digest = "a".repeat(64);

describe("extractWebSource", () => {
  test("extracts deterministic TypeScript/TSX symbols and static plus dynamic imports without executing source", () => {
    const result = extractWebSource({
      snapshotId: "snapshot-1",
      path: "src/widget.tsx",
      content: "export const Widget = () => <button/>;\nexport async function load() { return import('./lazy'); }\n",
      blobHash: digest
    });

    expect(result.ir.files).toEqual([expect.objectContaining({ path: "src/widget.tsx", language: "tsx" })]);
    expect(result.ir.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Widget", kind: "component", sourceRef: expect.objectContaining({ startLine: 1 }) }),
      expect.objectContaining({ name: "load", kind: "function", sourceRef: expect.objectContaining({ startLine: 2 }) })
    ]));
    expect(result.ir.imports).toEqual([expect.objectContaining({ specifier: "./lazy", kind: "dynamic" })]);
    expect(result.lintIssues).toEqual([]);
  });

  test("reports broken syntax as lint without dropping the safe file record", () => {
    const result = extractWebSource({
      snapshotId: "snapshot-1", path: "src/broken.js", content: "const valid = true;\nexport const = ;", blobHash: digest
    });

    expect(result.ir.files).toHaveLength(1);
    expect(result.lintIssues).toEqual([expect.objectContaining({
      rule: "WEB_PARSE_DIAGNOSTIC", severity: "warning", sourceRefs: [expect.objectContaining({ startLine: 2, endLine: 2 })]
    })]);
  });

  test("parses JavaScript and JSX imports without evaluating the source", () => {
    const result = extractWebSource({
      snapshotId: "snapshot-1",
      path: "src/page.jsx",
      content: "import React from 'react';\nexport const Page = () => <main>{globalThis.__mustNotRun()}</main>;\n",
      blobHash: digest
    });

    expect(result.ir.files[0]).toEqual(expect.objectContaining({ language: "jsx", lineCount: 2 }));
    expect(result.ir.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Page", kind: "component", sourceRef: expect.objectContaining({ startLine: 2, endLine: 2 }) })
    ]));
    expect(result.ir.imports).toEqual([expect.objectContaining({ specifier: "react", kind: "static" })]);
  });
});
