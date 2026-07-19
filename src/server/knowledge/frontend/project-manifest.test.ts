import { describe, expect, it } from "vitest";

import { analyzeFrontendProjectManifest } from "./project-manifest.js";

function source(path: string, content: string) {
  return { path, content };
}

describe("analyzeFrontendProjectManifest", () => {
  it("discovers npm, yarn, and bun workspaces from package.json", () => {
    const manifest = analyzeFrontendProjectManifest([
      source("package.json", JSON.stringify({
        name: "web-monorepo",
        packageManager: "bun@1.2.0",
        workspaces: ["apps/*", "packages/*"],
        scripts: { build: "vite build" },
        dependencies: { react: "^19.0.0" },
        devDependencies: { vite: "^7.0.0" },
        imports: { "#shared/*": "./packages/shared/src/*" }
      })),
      source("apps/site/package.json", JSON.stringify({
        name: "@demo/site",
        exports: { ".": "./src/main.tsx", "./routes": "./src/routes.tsx" }
      })),
      source("packages/shared/package.json", JSON.stringify({ name: "@demo/shared" })),
      source("examples/ignored/package.json", JSON.stringify({ name: "ignored" }))
    ]);

    expect(manifest.workspace?.kind).toBe("package-json");
    expect(manifest.workspace?.packageManager).toBe("bun");
    expect(manifest.workspace?.patterns).toEqual(["apps/*", "packages/*"]);
    expect(manifest.packages.map((entry) => entry.name)).toEqual([
      "web-monorepo",
      "@demo/site",
      "@demo/shared"
    ]);
    expect(manifest.packages[0]).toMatchObject({
      scripts: { build: "vite build" },
      dependencies: { react: "^19.0.0", vite: "^7.0.0" },
      imports: { "#shared/*": "./packages/shared/src/*" }
    });
    expect(manifest.packages[1]?.exports).toEqual({
      ".": "./src/main.tsx",
      "./routes": "./src/routes.tsx"
    });
  });

  it("discovers pnpm workspaces without reading excluded package trees", () => {
    const manifest = analyzeFrontendProjectManifest([
      source("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n  - packages/**\n  - '!packages/legacy'\n"),
      source("package.json", JSON.stringify({ name: "root", packageManager: "pnpm@10.0.0" })),
      source("apps/admin/package.json", JSON.stringify({ name: "admin" })),
      source("packages/ui/package.json", JSON.stringify({ name: "ui" })),
      source("packages/legacy/package.json", JSON.stringify({ name: "legacy" })),
      source("node_modules/bad/package.json", JSON.stringify({ name: "must-not-appear" }))
    ]);

    expect(manifest.workspace).toMatchObject({
      kind: "pnpm",
      packageManager: "pnpm",
      patterns: ["apps/*", "packages/**", "!packages/legacy"]
    });
    expect(manifest.packages.map((entry) => entry.name)).toEqual(["root", "admin", "ui"]);
    expect(manifest.ignoredPaths).toContain("node_modules/bad/package.json");
  });

  it("resolves local tsconfig extends, references, and path aliases in memory", () => {
    const manifest = analyzeFrontendProjectManifest([
      source("tsconfig.base.json", `{
        // JSON comments are valid in tsconfig files.
        "compilerOptions": {
          "baseUrl": ".",
          "paths": { "@shared/*": ["packages/shared/src/*"] }
        }
      }`),
      source("tsconfig.json", JSON.stringify({
        extends: "./tsconfig.base.json",
        references: [{ path: "./apps/site" }, { path: "./packages/shared/tsconfig.lib.json" }]
      })),
      source("apps/site/tsconfig.json", JSON.stringify({
        extends: "../../tsconfig.base",
        compilerOptions: { paths: { "@site/*": ["src/*"] } }
      })),
      source("packages/shared/tsconfig.lib.json", JSON.stringify({ compilerOptions: { composite: true } }))
    ]);

    expect(manifest.tsconfigs.map((config) => config.path)).toEqual([
      "apps/site/tsconfig.json",
      "packages/shared/tsconfig.lib.json",
      "tsconfig.base.json",
      "tsconfig.json"
    ]);
    expect(manifest.tsconfigs.find((config) => config.path === "tsconfig.json")).toMatchObject({
      extendsPath: "tsconfig.base.json",
      references: ["apps/site/tsconfig.json", "packages/shared/tsconfig.lib.json"],
      paths: { "@shared/*": ["packages/shared/src/*"] }
    });
    expect(manifest.tsconfigs.find((config) => config.path === "apps/site/tsconfig.json")).toMatchObject({
      extendsPath: "tsconfig.base.json",
      paths: {
        "@shared/*": ["packages/shared/src/*"],
        "@site/*": ["apps/site/src/*"]
      }
    });
  });

  it("records unsupported package-based extends without resolving node_modules", () => {
    const manifest = analyzeFrontendProjectManifest([
      source("tsconfig.json", JSON.stringify({ extends: "@tsconfig/node22/tsconfig.json" }))
    ]);

    expect(manifest.tsconfigs[0]).toMatchObject({
      path: "tsconfig.json",
      unresolvedExtends: "@tsconfig/node22/tsconfig.json"
    });
  });

  it("rejects duplicate paths and project-relative paths that escape the snapshot", () => {
    expect(() => analyzeFrontendProjectManifest([
      source("package.json", "{}"),
      source("package.json", "{}")
    ])).toThrow("duplicate source path");
    expect(() => analyzeFrontendProjectManifest([
      source("../package.json", "{}")
    ])).toThrow("invalid project source path");
  });
});
