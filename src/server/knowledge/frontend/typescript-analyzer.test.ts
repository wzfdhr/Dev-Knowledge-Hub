import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { analyzeTypeScriptSource } from "./typescript-analyzer.js";

const content = [
  "import { Button } from './button';",
  "export { chartOptions } from './chart-options';",
  "export function select<T>(value: T): T;",
  "export function select<T>(value: T) { return value; }",
  "export function App<T extends object>(props: T) {",
  "  const LazyPanel = import('./lazy-panel');",
  "  return <main className=\"grid gap-2\"><Button /></main>;",
  "}",
  "export const Card = styled.section`color: var(--brand);`;"
].join("\n");

describe("analyzeTypeScriptSource", () => {
  test("models overloads, generics, re-exports, dynamic imports, JSX, and static CSS-in-JS", () => {
    const output = analyzeTypeScriptSource({
      snapshotId: "snapshot-1",
      path: "apps/site/src/app.tsx",
      content,
      blobHash: createHash("sha256").update(content).digest("hex"),
      packageKey: "@demo/site",
      resolutions: [
        { specifier: "./button", resolvedPath: "packages/ui/src/button.tsx" },
        { specifier: "./chart-options", resolvedPath: "apps/site/src/chart-options.ts" },
        { specifier: "./lazy-panel", resolvedPath: "apps/site/src/lazy-panel.tsx" }
      ]
    });

    expect(output.analyzerId).toBe("typescript-core");
    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "symbol", name: "select", facets: {
        "typescript-core": expect.objectContaining({ overloadCount: 2, genericParameters: ["T"] })
      } }),
      expect.objectContaining({ kind: "component", name: "App", facets: {
        "typescript-core": expect.objectContaining({ genericParameters: ["T"], utilityClasses: ["gap-2", "grid"] })
      } }),
      expect.objectContaining({ kind: "style_scope", name: "Card", facets: {
        "typescript-core": expect.objectContaining({ cssInJs: true, staticTemplate: true })
      } })
    ]));
    expect(output.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "exports", evidenceClass: "fact" }),
      expect.objectContaining({ kind: "lazy_loads", evidenceClass: "fact" }),
      expect.objectContaining({ kind: "renders", evidenceClass: "fact" })
    ]));
    expect(output.entities.flatMap((entity) => entity.sourceRefs)).not.toHaveLength(0);
    expect(output.entities.every((entity) => entity.sourceRefs.every((ref) => ref.path === "apps/site/src/app.tsx"))).toBe(true);
  });

  test("marks unresolved imports and dynamic expressions as partial instead of inventing facts", () => {
    const source = "export const load = (name: string) => import(`./${name}`);";
    const output = analyzeTypeScriptSource({
      snapshotId: "snapshot-2",
      path: "src/load.ts",
      content: source,
      blobHash: createHash("sha256").update(source).digest("hex"),
      packageKey: "app",
      resolutions: []
    });

    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "load", completeness: "partial" })
    ]));
    expect(output.edges.some((edge) => edge.kind === "lazy_loads")).toBe(false);
  });

  test("does not claim definition facets for imported component placeholders", () => {
    const source = "import { Button } from './button'; export function App() { return <Button />; }";
    const output = analyzeTypeScriptSource({
      snapshotId: "snapshot-3",
      path: "src/app.tsx",
      content: source,
      blobHash: createHash("sha256").update(source).digest("hex"),
      packageKey: "app",
      resolutions: [{ specifier: "./button", resolvedPath: "src/button.tsx" }]
    });

    expect(output.entities.find((entity) => entity.kind === "component" && entity.name === "Button")?.facets).toEqual({});
  });
});
