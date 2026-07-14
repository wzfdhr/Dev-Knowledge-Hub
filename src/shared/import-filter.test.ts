import { describe, expect, test } from "vitest";

import { filterImportFile, isExcludedImportDirectory } from "./import-filter";

describe("filterImportFile", () => {
  test("keeps supported source files and reports local exclusions", () => {
    expect(filterImportFile({ path: "src/main.ts", byteSize: 12 })).toEqual({ accepted: true });
    expect(filterImportFile({ path: "node_modules/react/index.js", byteSize: 12 }))
      .toEqual({ accepted: false, reason: "excluded_directory" });
    expect(filterImportFile({ path: ".env", byteSize: 12 }))
      .toEqual({ accepted: false, reason: "sensitive_file" });
    expect(filterImportFile({ path: "assets/logo.png", byteSize: 12 }))
      .toEqual({ accepted: false, reason: "unsupported_extension" });
  });

  test("rejects generated, binary and oversized source files when content is available", () => {
    expect(filterImportFile({ path: "src/generated.ts", byteSize: 20, content: new TextEncoder().encode("// @generated") }))
      .toEqual({ accepted: false, reason: "generated" });
    expect(filterImportFile({ path: "src/data.ts", byteSize: 2, content: new Uint8Array([0xff, 0xfe]) }))
      .toEqual({ accepted: false, reason: "binary" });
    expect(filterImportFile({ path: "src/large.ts", byteSize: 1024 * 1024 + 1 }))
      .toEqual({ accepted: false, reason: "file_too_large" });
  });

  test("recognizes common dependency and generated-output directories before file scanning", () => {
    expect(isExcludedImportDirectory("node_modules")).toBe(true);
    expect(isExcludedImportDirectory(".pnpm-store")).toBe(true);
    expect(isExcludedImportDirectory(".venv")).toBe(true);
    expect(isExcludedImportDirectory(".next")).toBe(true);
    expect(isExcludedImportDirectory("vendor")).toBe(false);
  });
});
