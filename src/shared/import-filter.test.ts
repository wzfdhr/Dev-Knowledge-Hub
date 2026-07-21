import { describe, expect, test } from "vitest";

import { filterImportFile, importLanguageForPath, isExcludedImportDirectory } from "./import-filter";

describe("filterImportFile", () => {
  test("keeps supported source files and reports local exclusions", () => {
    expect(filterImportFile({ path: "src/main.ts", byteSize: 12 })).toEqual({ accepted: true });
    expect(filterImportFile({ path: "data/usage.csv", byteSize: 12 })).toEqual({ accepted: true });
    expect(filterImportFile({ path: "data/usage.xlsx", byteSize: 12 })).toEqual({ accepted: true });
    expect(filterImportFile({ path: "node_modules/react/index.js", byteSize: 12 }))
      .toEqual({ accepted: false, reason: "excluded_directory" });
    expect(filterImportFile({ path: ".env", byteSize: 12 }))
      .toEqual({ accepted: false, reason: "sensitive_file" });
    expect(filterImportFile({ path: "assets/logo.png", byteSize: 12 }))
      .toEqual({ accepted: false, reason: "unsupported_extension" });
    expect(filterImportFile({ path: "data/usage.xlsx", byteSize: 2, content: new Uint8Array([0x50, 0x4b]) }))
      .toEqual({ accepted: true });
  });

  test("rejects generated, binary and oversized source files when content is available", () => {
    expect(filterImportFile({ path: "src/generated.ts", byteSize: 20, content: new TextEncoder().encode("// @generated") }))
      .toEqual({ accepted: false, reason: "generated" });
    expect(filterImportFile({ path: "src/data.ts", byteSize: 2, content: new Uint8Array([0xff, 0xfe]) }))
      .toEqual({ accepted: false, reason: "binary" });
    expect(filterImportFile({ path: "src/large.ts", byteSize: 1024 * 1024 + 1 }))
      .toEqual({ accepted: false, reason: "file_too_large" });
    expect(filterImportFile({ path: "data/large.xlsx", byteSize: 1024 * 1024 + 1 }))
      .toEqual({ accepted: true });
    expect(filterImportFile({ path: "data/too-large.xlsx", byteSize: 50 * 1024 * 1024 + 1 }))
      .toEqual({ accepted: false, reason: "file_too_large" });
  });

  test("recognizes common dependency and generated-output directories before file scanning", () => {
    expect(isExcludedImportDirectory("node_modules")).toBe(true);
    expect(isExcludedImportDirectory(".pnpm-store")).toBe(true);
    expect(isExcludedImportDirectory(".venv")).toBe(true);
    expect(isExcludedImportDirectory(".next")).toBe(true);
    expect(isExcludedImportDirectory("vendor")).toBe(false);
  });

  test("accepts verified frontend text formats while keeping binary assets out of FK06", () => {
    const frontendSources = [
      "src/App.vue",
      "src/index.html",
      "src/app.css",
      "src/app.module.css",
      "src/theme.scss",
      "src/theme.sass",
      "src/theme.less",
      "src/widget.svelte",
      "src/page.astro",
      "src/types.d.ts",
      "public/icons.svg",
      "vite.config.mts",
      "worker.config.cts",
      "scripts/build.mjs",
      "scripts/setup.cjs",
      "bun.lock"
    ];

    for (const path of frontendSources) {
      expect(filterImportFile({ path, byteSize: 12, content: new TextEncoder().encode("verified text") }), path)
        .toEqual({ accepted: true });
    }
    for (const path of ["assets/logo.png", "assets/inter.woff2", "assets/demo.mp4"]) {
      expect(filterImportFile({ path, byteSize: 12 }), path)
        .toEqual({ accepted: false, reason: "unsupported_extension" });
    }
  });

  test("classifies frontend source languages consistently for every ingestion path", () => {
    expect(importLanguageForPath("src/App.vue")).toBe("vue");
    expect(importLanguageForPath("src/index.html")).toBe("html");
    expect(importLanguageForPath("src/app.module.css")).toBe("css");
    expect(importLanguageForPath("src/theme.scss")).toBe("scss");
    expect(importLanguageForPath("src/theme.sass")).toBe("sass");
    expect(importLanguageForPath("src/theme.less")).toBe("less");
    expect(importLanguageForPath("src/widget.svelte")).toBe("svelte");
    expect(importLanguageForPath("src/page.astro")).toBe("astro");
    expect(importLanguageForPath("public/icons.svg")).toBe("svg");
    expect(importLanguageForPath("vite.config.mts")).toBe("typescript");
    expect(importLanguageForPath("assets/logo.png")).toBeNull();
  });
});
