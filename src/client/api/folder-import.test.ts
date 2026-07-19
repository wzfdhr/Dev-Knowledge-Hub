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

  test("skips excluded directories without descending into their files", async () => {
    const excludedFile = {
      kind: "file" as const,
      name: "index.ts",
      getFile: async (): Promise<File> => { throw new Error("excluded directories must not be read"); }
    };
    const report = await scanDirectory(directory("demo", [
      directory("node_modules", [excludedFile]),
      directory("src", [file("main.ts", "export {}; ")])
    ]));

    expect(report.acceptedFiles.map((item) => item.path)).toEqual(["src/main.ts"]);
    expect(report.ignored.reasons).toEqual({ excluded_directory: 1 });
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

  test("collects frontend text but rejects binary assets before reading their contents", async () => {
    const binaryAsset = {
      name: "logo.png",
      size: 1024,
      arrayBuffer: async () => { throw new Error("FK06 binary assets must not be read"); },
      webkitRelativePath: "demo/assets/logo.png"
    } as unknown as File;
    const sources = [
      ["App.vue", "<template><main /></template>"],
      ["index.html", "<main></main>"],
      ["app.css", ":root { --brand: blue; }"],
      ["theme.scss", "$brand: blue;"],
      ["icon.svg", "<svg viewBox=\"0 0 1 1\"></svg>"]
    ].map(([name, content]) => Object.assign(browserFile(name!, content!), {
      webkitRelativePath: `demo/src/${name}`
    }));

    const report = await scanSelectedFiles([...sources, binaryAsset]);

    expect(report.acceptedFiles.map((item) => item.path)).toEqual([
      "src/App.vue", "src/index.html", "src/app.css", "src/theme.scss", "src/icon.svg"
    ]);
    expect(report.ignored.reasons).toEqual({ unsupported_extension: 1 });
  });

  test("does not count ignored dependency files against the accepted-file limit", async () => {
    const ignoredFiles = Array.from({ length: 50_001 }, (_, index) => ({
      name: `${index}.js`, size: 1, arrayBuffer: async () => { throw new Error("ignored content must not be read"); },
      webkitRelativePath: `demo/node_modules/package/${index}.js`
    } as unknown as File));
    const accepted = Object.assign(browserFile("main.ts", "export {};"), { webkitRelativePath: "demo/src/main.ts" });

    const report = await scanSelectedFiles([...ignoredFiles, accepted]);

    expect(report.acceptedFiles.map((item) => item.path)).toEqual(["src/main.ts"]);
    expect(report.ignored.reasons).toEqual({ excluded_directory: 50_001 });
  });

  test("skips a 60,000-file dependency directory without reading its files and keeps valid files below the limit", async () => {
    let dependencyReads = 0;
    const dependencyFiles = Array.from({ length: 60_000 }, (_, index) => ({
      kind: "file" as const,
      name: `${index}.js`,
      getFile: async (): Promise<File> => {
        dependencyReads += 1;
        throw new Error("excluded dependency files must not be read");
      }
    }));
    const accepted = Array.from({ length: 2_000 }, (_, index) => file(`${index}.ts`, `export const value${index} = ${index};`));

    const report = await scanDirectory(directory("demo", [
      directory("node_modules", dependencyFiles),
      directory("src", accepted)
    ]));

    expect(dependencyReads).toBe(0);
    expect(report.acceptedFiles).toHaveLength(2_000);
    expect(report.ignored.reasons).toEqual({ excluded_directory: 1 });
  });

  test("allows exactly 50,000 accepted files and rejects the 50,001st before upload", async () => {
    const acceptedFiles = Array.from({ length: 50_000 }, (_, index) =>
      Object.assign(browserFile(`${index}.ts`, "export {};"), { webkitRelativePath: `demo/src/${index}.ts` })
    );
    const allowed = await scanSelectedFiles(acceptedFiles);
    expect(allowed.acceptedFiles).toHaveLength(50_000);

    const tooMany = [...acceptedFiles, Object.assign(browserFile("overflow.ts", "export {};"), {
      webkitRelativePath: "demo/src/overflow.ts"
    })];
    await expect(scanSelectedFiles(tooMany)).rejects.toThrow("可采集文件超过 50,000 个");
  }, 30_000);

  test("reports reading and filtering progress while scanning", async () => {
    const progress: Array<{ phase: string; processedFiles?: number; totalFiles?: number }> = [];

    await scanDirectory(directory("demo", [
      file("one.ts", "export const one = 1;"),
      file("two.ts", "export const two = 2;")
    ]), { onProgress: (value) => progress.push(value) });

    expect(progress[0]).toMatchObject({ phase: "reading", processedFiles: 0 });
    expect(progress).toContainEqual(expect.objectContaining({ phase: "filtering", processedFiles: 2, totalFiles: 2 }));
  });
});
