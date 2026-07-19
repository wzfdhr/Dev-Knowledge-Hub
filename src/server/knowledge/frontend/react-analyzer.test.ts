import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { analyzeReactSource } from "./react-analyzer.js";

function input(content: string) {
  return {
    snapshotId: "snapshot-react",
    path: "apps/web/src/panel.tsx",
    content,
    blobHash: createHash("sha256").update(content).digest("hex"),
    packageKey: "@demo/web",
    resolutions: [{ specifier: "./button", resolvedPath: "apps/web/src/button.tsx" }]
  };
}

describe("analyzeReactSource", () => {
  test("models component props, refs, hooks, effects, and JSX render relations", () => {
    const content = [
      "import { forwardRef, useEffect, useRef, useState } from 'react';",
      "import { Button } from './button';",
      "interface PanelProps { title?: string; ref?: React.Ref<HTMLDivElement> }",
      "export const Panel = forwardRef<HTMLDivElement, PanelProps>(function Panel({ title = 'Overview' }, ref) {",
      "  const localRef = useRef<HTMLDivElement>(null);",
      "  const [loading, setLoading] = useState(true);",
      "  useEffect(() => { setLoading(false); return () => window.clearTimeout(1); }, [title]);",
      "  if (loading) return <p>Loading</p>;",
      "  return <section ref={ref ?? localRef}><Button />{title}</section>;",
      "});",
      "export function Input({ ref }: PanelProps) { return <input ref={ref} />; }"
    ].join("\n");

    const output = analyzeReactSource(input(content));
    const panel = output.entities.find((entity) => entity.kind === "component" && entity.name === "Panel");
    const inputComponent = output.entities.find((entity) => entity.kind === "component" && entity.name === "Input");

    expect(panel).toMatchObject({
      completeness: "partial",
      facets: {
        "react-core": {
          componentKind: "function",
          analysisCompleteness: "complete",
          refMode: "forwardRef",
          props: [{ name: "title", optional: true, defaultValue: "'Overview'" }],
          hooks: expect.arrayContaining([
            expect.objectContaining({ name: "useEffect", dependencies: ["title"], hasCleanup: true }),
            expect.objectContaining({ name: "useRef" }),
            expect.objectContaining({ name: "useState" })
          ]),
          states: expect.arrayContaining([expect.objectContaining({ name: "loading", setter: "setLoading" })]),
          loadingConsumers: ["loading"]
        }
      }
    });
    expect(inputComponent).toMatchObject({
      facets: { "react-core": expect.objectContaining({ refMode: "ref-prop" }) }
    });
    expect(output.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "renders", evidenceClass: "fact" })
    ]));
    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "component", name: "Button", canonicalPath: "apps/web/src/button.tsx" })
    ]));
  });

  test("models custom hooks and explicit error consumers without executing source", () => {
    const content = [
      "export function useDashboard() { return { ready: true }; }",
      "export function Dashboard({ error }: { error?: Error }) {",
      "  useDashboard();",
      "  if (error) return <p>{error.message}</p>;",
      "  return <main>Ready</main>;",
      "}"
    ].join("\n");
    const output = analyzeReactSource(input(content));

    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "hook_or_composable", name: "useDashboard" }),
      expect.objectContaining({
        kind: "component",
        name: "Dashboard",
        facets: { "react-core": expect.objectContaining({ errorConsumers: ["error"] }) }
      })
    ]));
  });
});
