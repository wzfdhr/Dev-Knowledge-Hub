import { describe, expect, test } from "vitest";

import { scanDirectory, scanSelectedFiles, type DirectoryHandle } from "./folder-import";

function browserFile(name: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  return {
    name,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(0)
  } as File;
}

function file(name: string, content: string) {
  return { kind: "file" as const, name, getFile: async () => browserFile(name, content) };
}

function directory(name: string, entries: DirectoryHandle[]) {
  return {
    kind: "directory" as const,
    name,
    async *values() {
      yield* entries;
    }
  };
}

describe("folder import scanning", () => {
  test("recursively collects accepted project files and explains exclusions", async () => {
    const report = await scanDirectory(directory("demo", [
      directory("src", [file("main.ts", "export const answer = 42;"), file("generated.ts", "// @generated")]),
      directory("node_modules", [file("package.json", "{}")]),
      file(".env", "TOKEN=secret"),
      file("cover.png", "not source")
    ]));

    expect(report.acceptedFiles.map((item) => item.path)).toEqual(["src/main.ts"]);
    expect(report.ignored).toEqual({
      total: 4,
      reasons: {
        excluded_directory: 1,
        generated: 1,
        sensitive_file: 1,
        unsupported_extension: 1
      }
    });
  });

  test("uses browser relative paths from the directory input fallback", async () => {
    const files = [
      Object.assign(browserFile("main.ts", "export {};"), { webkitRelativePath: "demo/src/main.ts" }),
      Object.assign(browserFile("logo.png", "asset"), { webkitRelativePath: "demo/logo.png" })
    ];

    const report = await scanSelectedFiles(files);

    expect(report.acceptedFiles.map((item) => item.path)).toEqual(["src/main.ts"]);
    expect(report.ignored.reasons).toEqual({ unsupported_extension: 1 });
  });
});
