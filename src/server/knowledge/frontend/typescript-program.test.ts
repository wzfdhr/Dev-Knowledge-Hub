import { describe, expect, it } from "vitest";
import ts from "typescript";

import { createRestrictedTypeScriptProgram } from "./typescript-program.js";

function source(path: string, content: string) {
  return { path, content };
}

function aliasedSymbolName(result: ReturnType<typeof createRestrictedTypeScriptProgram>, filePath: string, name: string) {
  const sourceFile = result.program.getSourceFiles().find((file) => file.fileName.endsWith(`/${filePath}`));
  if (!sourceFile) throw new Error(`missing ${filePath}`);
  let resolved: string | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) {
      const symbol = result.checker.getSymbolAtLocation(node);
      if (symbol) {
        const target = symbol.flags & ts.SymbolFlags.Alias ? result.checker.getAliasedSymbol(symbol) : symbol;
        resolved = target.name;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return resolved;
}

describe("createRestrictedTypeScriptProgram", () => {
  it("resolves relative modules, tsconfig paths, and workspace package exports", () => {
    const result = createRestrictedTypeScriptProgram([
      source("package.json", JSON.stringify({ workspaces: ["apps/*", "packages/*"] })),
      source("tsconfig.json", JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@shared/*": ["packages/shared/src/*"] } },
        references: [{ path: "./apps/site" }]
      })),
      source("apps/site/package.json", JSON.stringify({ name: "@demo/site" })),
      source("apps/site/tsconfig.json", JSON.stringify({ extends: "../../tsconfig.json" })),
      source("apps/site/src/local.ts", "export const localValue = 1;"),
      source("apps/site/src/main.ts", [
        "import { localValue } from './local';",
        "import { sharedValue } from '@shared/value';",
        "import { button } from '@demo/ui/button';",
        "export const total = localValue + sharedValue + button;"
      ].join("\n")),
      source("packages/shared/package.json", JSON.stringify({ name: "@demo/shared" })),
      source("packages/shared/src/value.ts", "export const sharedValue = 2;"),
      source("packages/ui/package.json", JSON.stringify({
        name: "@demo/ui",
        exports: { "./button": "./src/button.ts" }
      })),
      source("packages/ui/src/button.ts", "export const button = 3;")
    ]);

    expect(result.rootNames).toEqual([
      "apps/site/src/local.ts",
      "apps/site/src/main.ts",
      "packages/shared/src/value.ts",
      "packages/ui/src/button.ts"
    ]);
    expect(result.projectReferences).toContainEqual({ from: "tsconfig.json", to: "apps/site/tsconfig.json" });
    expect(aliasedSymbolName(result, "apps/site/src/main.ts", "localValue")).toBe("localValue");
    expect(aliasedSymbolName(result, "apps/site/src/main.ts", "sharedValue")).toBe("sharedValue");
    expect(aliasedSymbolName(result, "apps/site/src/main.ts", "button")).toBe("button");
  });

  it("does not resolve installed dependencies, node_modules sources, or host files", () => {
    const result = createRestrictedTypeScriptProgram([
      source("src/main.ts", "import ts from 'typescript'; import secret from '/etc/passwd'; export { ts, secret };"),
      source("node_modules/typescript/index.d.ts", "declare const compromised: string; export default compromised;")
    ]);

    expect(result.rootNames).toEqual(["src/main.ts"]);
    expect(result.resolutions).toEqual([
      { containingFile: "src/main.ts", specifier: "/etc/passwd", resolvedPath: null },
      { containingFile: "src/main.ts", specifier: "typescript", resolvedPath: null }
    ]);
    expect(result.program.getSourceFiles().some((file) => file.fileName.includes("node_modules"))).toBe(false);
  });

  it("keeps unresolved imports explicit and deterministic", () => {
    const first = createRestrictedTypeScriptProgram([
      source("src/main.ts", "import { missing } from './missing'; export const value = missing;")
    ]);
    const second = createRestrictedTypeScriptProgram([
      source("src/main.ts", "import { missing } from './missing'; export const value = missing;")
    ]);

    expect(first.resolutions).toEqual([
      { containingFile: "src/main.ts", specifier: "./missing", resolvedPath: null }
    ]);
    expect(second.resolutions).toEqual(first.resolutions);
  });

  it("enforces source count and source size limits before creating a Program", () => {
    expect(() => createRestrictedTypeScriptProgram([
      source("src/large.ts", "x".repeat(2 * 1024 * 1024 + 1))
    ])).toThrow("source size limit");
    expect(() => createRestrictedTypeScriptProgram(
      Array.from({ length: 10_001 }, (_, index) => source(`src/${index}.ts`, "export {};"))
    )).toThrow("source count limit");
  });
});
