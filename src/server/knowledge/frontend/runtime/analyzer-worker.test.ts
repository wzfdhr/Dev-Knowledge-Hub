import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  assertAnalyzerOutputStructure,
  MAX_ANALYZER_OUTPUT_BYTES,
  MAX_ANALYZER_OUTPUT_DEPTH,
  MAX_ANALYZER_OUTPUT_NODES,
  analyzeWorkerRequest
} from "./analyzer-worker";
import { typeScriptSyntaxParserConfigDigest } from "../typescript-program";

function parserSource(path: string, content: string) {
  return {
    path,
    contentBase64: Buffer.from(content, "utf8").toString("base64"),
    blobHash: createHash("sha256").update(content, "utf8").digest("hex")
  };
}

describe("analyzer worker structural limits", () => {
  test("analyzes project context and emits path-free file syntax facts", () => {
    const result = analyzeWorkerRequest({
      type: "analyze",
      requestId: randomUUID(),
      snapshotId: "snapshot-1",
      analyzerIds: ["frontend-project", "typescript-core", "html-core", "style-core"],
      cachedAnalyses: [],
      sources: [
        parserSource("package.json", JSON.stringify({ workspaces: ["apps/*"] })),
        parserSource("tsconfig.json", JSON.stringify({
          compilerOptions: { baseUrl: ".", paths: { "@app/*": ["apps/site/src/*"] } }
        })),
        parserSource("apps/site/package.json", JSON.stringify({ name: "site" })),
        parserSource("apps/site/src/value.ts", "export const value = 1;"),
        parserSource("apps/site/src/main.ts", "import { value } from '@app/value'; export const total = value;")
      ]
    });

    expect(result.outputs).toHaveLength(1);
    const output = result.outputs[0]!;
    expect(output).toMatchObject({
      analyzerId: "typescript-project",
      analyzerVersion: "1.0.0",
      projectManifest: { packages: [{ name: null }, { name: "site" }] },
      resolutions: [{
        containingFile: "apps/site/src/main.ts",
        specifier: "@app/value",
        resolvedPath: "apps/site/src/value.ts"
      }]
    });
    expect(output.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        blobHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        facts: expect.objectContaining({
          schemaVersion: 1,
          declarations: expect.arrayContaining([expect.objectContaining({ name: "total" })])
        })
      })
    ]));
    expect(JSON.stringify(output.files)).not.toContain("snapshot-1");
    expect(output.files.every((file) => Object.hasOwn(file, "path"))).toBe(true);
    expect(output.files.some((file) => Object.hasOwn(file.facts, "path"))).toBe(false);
    expect(output.frontendIr).toMatchObject({
      schemaVersion: 2,
      snapshotId: "snapshot-1",
      entities: expect.arrayContaining([
        expect.objectContaining({ kind: "application_entry", canonicalPath: "apps/site/src/main.ts" }),
        expect.objectContaining({ kind: "symbol", name: "total" })
      ])
    });
    expect(output.frontendIr.analyzerManifest).toEqual(expect.arrayContaining([
      expect.objectContaining({ analyzerId: "typescript-core", analyzerVersion: "1.0.0" })
    ]));
  });

  test("merges HTML and style analyzer facts into one validated frontend IR", () => {
    const result = analyzeWorkerRequest({
      type: "analyze",
      requestId: randomUUID(),
      snapshotId: "snapshot-web",
      analyzerIds: ["frontend-project", "html-core", "style-core"],
      cachedAnalyses: [],
      sources: [
        parserSource("public/index.html", "<main><form action='/search'><input name='q'></form></main>"),
        parserSource("src/theme.css", ":root { --brand: #1677ff; } .card { color: var(--brand); }")
      ]
    });
    const ir = result.outputs[0]?.frontendIr;

    expect(ir?.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "dom_landmark", name: "main" }),
      expect.objectContaining({ kind: "form" }),
      expect.objectContaining({ kind: "style_token", name: "--brand" })
    ]));
    expect(ir?.analyzerManifest.map((entry) => entry.analyzerId)).toEqual(["html-core", "style-core"]);
  });

  test("merges React application, router, state, and request facts without canonical conflicts", () => {
    const result = analyzeWorkerRequest({
      type: "analyze",
      requestId: randomUUID(),
      snapshotId: "snapshot-react-app",
      analyzerIds: [
        "frontend-project",
        "typescript-core",
        "react-core",
        "react-router-core",
        "state-data-core"
      ],
      cachedAnalyses: [],
      sources: [
        parserSource("package.json", JSON.stringify({ name: "react-app", dependencies: { react: "19.2.0", "react-router-dom": "7.18.1", zustand: "5.0.0" } })),
        parserSource("src/store.ts", "import { create } from 'zustand'; export const useStore = create(() => ({ count: 0 }));"),
        parserSource("src/api.ts", "import axios from 'axios'; export function loadTeam(id: string) { return axios.get(`/api/teams/${id}`); }"),
        parserSource("src/app.tsx", [
          "import { useEffect } from 'react';",
          "import { useStore } from './store';",
          "import { loadTeam } from './api';",
          "export function App() {",
          "  const count = useStore((state) => state.count);",
          "  useEffect(() => { void loadTeam('one'); }, []);",
          "  return <main>{count}</main>;",
          "}"
        ].join("\n")),
        parserSource("src/router.tsx", [
          "import { createBrowserRouter } from 'react-router-dom';",
          "import { App } from './app';",
          "export const router = createBrowserRouter([{ path: '/', Component: App }]);"
        ].join("\n"))
      ]
    });
    const ir = result.outputs[0]?.frontendIr;

    expect([...new Set(ir?.analyzerManifest.map((entry) => entry.analyzerId))]).toEqual([
      "react-core",
      "react-router-core",
      "state-data-core",
      "typescript-core"
    ]);
    expect(ir?.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "component", name: "App" }),
      expect.objectContaining({ kind: "route", name: "/" }),
      expect.objectContaining({ kind: "state_store", name: "useStore" }),
      expect.objectContaining({ kind: "api_operation", name: "GET /api/teams/:id" })
    ]));
    expect(ir?.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "routes_to" }),
      expect.objectContaining({ kind: "reads_state" }),
      expect.objectContaining({ kind: "requests" })
    ]));
  });

  test("analyzes the approved React 18 fixture as an application flow", () => {
    const fixtureRoot = "fixtures/frontend/react-vite";
    const paths = [
      "package.json",
      "tsconfig.json",
      "vite.config.ts",
      "src/api.ts",
      "src/app.tsx",
      "src/app.test.tsx",
      "src/chart.tsx",
      "src/main.tsx",
      "src/router.tsx",
      "src/store.ts",
      "e2e/app.spec.ts"
    ];
    const result = analyzeWorkerRequest({
      type: "analyze",
      requestId: randomUUID(),
      snapshotId: "snapshot-react-18-fixture",
      analyzerIds: [
        "frontend-project",
        "typescript-core",
        "react-core",
        "react-router-core",
        "state-data-core",
        "visualization-core",
        "tooling-test-core"
      ],
      cachedAnalyses: [],
      sources: paths.map((sourcePath) => parserSource(sourcePath, readFileSync(`${fixtureRoot}/${sourcePath}`, "utf8")))
    });
    const ir = result.outputs[0]?.frontendIr;
    const dashboard = ir?.entities.find((entity) => entity.kind === "component" && entity.name === "DashboardPage");

    expect(dashboard?.facets["react-core"]).toMatchObject({
      props: [expect.objectContaining({ name: "teamId", defaultValue: "\"core\"" })],
      loadingConsumers: ["loading"],
      errorConsumers: ["error"]
    });
    expect(ir?.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "component", name: "DashboardShell" }),
      expect.objectContaining({ kind: "route", name: "/" }),
      expect.objectContaining({ kind: "state_store", name: "SessionContext" }),
      expect.objectContaining({ kind: "state_store", name: "useDashboardStore" }),
      expect.objectContaining({ kind: "api_operation", name: "GET /api/teams/:teamId/dashboard" }),
      expect.objectContaining({ kind: "visualization", name: "chart" }),
      expect.objectContaining({ kind: "test_case", name: "renders the dashboard heading" }),
      expect.objectContaining({ kind: "tooling_config", name: "vite" })
    ]));
    expect(ir?.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "injects" }),
      expect.objectContaining({ kind: "reads_state" }),
      expect.objectContaining({ kind: "requests" }),
      expect.objectContaining({ kind: "routes_to" }),
      expect.objectContaining({ kind: "visualizes" }),
      expect.objectContaining({ kind: "tests" })
    ]));
  });

  test("reuses validated path-free cached syntax facts", () => {
    const input = parserSource("src/value.ts", "export const value = 1;");
    const cachedFacts = { schemaVersion: 1, declarations: [], imports: [] };
    const result = analyzeWorkerRequest({
      type: "analyze",
      requestId: randomUUID(),
      snapshotId: "snapshot-2",
      analyzerIds: ["frontend-project"],
      sources: [input],
      cachedAnalyses: [{
        path: input.path,
        blobHash: input.blobHash,
        analyzerId: "typescript-syntax",
        analyzerVersion: "1.0.0",
        parserConfigDigest: typeScriptSyntaxParserConfigDigest(input.path),
        facts: cachedFacts
      }]
    });

    expect(result.outputs[0]?.files[0]?.facts).toEqual(cachedFacts);
  });

  test("uses a stable non-empty package key for unnamed root packages", () => {
    const result = analyzeWorkerRequest({
      type: "analyze",
      requestId: randomUUID(),
      snapshotId: "snapshot-root",
      analyzerIds: ["frontend-project", "typescript-core"],
      cachedAnalyses: [],
      sources: [
        parserSource("package.json", "{}"),
        parserSource("src/main.ts", "export const main = true;")
      ]
    });

    expect(result.outputs[0]?.frontendIr.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonicalPath: "src/main.ts", packageKey: "workspace" })
    ]));
  });

  test("accepts bounded analyzer output", () => {
    expect(() => assertAnalyzerOutputStructure({ outputs: [{ id: "node-1" }] }, {
      maxNodes: 10,
      maxDepth: 4
    })).not.toThrow();
  });

  test("rejects output with too many structural values", () => {
    expect(() => assertAnalyzerOutputStructure({ outputs: Array.from({ length: 10 }, () => ({})) }, {
      maxNodes: 5,
      maxDepth: 10
    })).toThrow("node limit");
  });

  test("rejects deeply nested or cyclic output without recursive traversal", () => {
    expect(() => assertAnalyzerOutputStructure({ child: { child: { child: true } } }, {
      maxNodes: 100,
      maxDepth: 2
    })).toThrow("depth limit");
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => assertAnalyzerOutputStructure(cyclic, { maxNodes: 100, maxDepth: 10 }))
      .toThrow("cycle");
  });

  test("locks the production output limits and their exact structural boundaries", () => {
    expect(MAX_ANALYZER_OUTPUT_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_ANALYZER_OUTPUT_NODES).toBe(250_000);
    expect(MAX_ANALYZER_OUTPUT_DEPTH).toBe(256);

    expect(() => assertAnalyzerOutputStructure(
      Array.from({ length: MAX_ANALYZER_OUTPUT_NODES - 1 }, () => null),
      { maxNodes: MAX_ANALYZER_OUTPUT_NODES, maxDepth: MAX_ANALYZER_OUTPUT_DEPTH }
    )).not.toThrow();
    expect(() => assertAnalyzerOutputStructure(
      Array.from({ length: MAX_ANALYZER_OUTPUT_NODES }, () => null),
      { maxNodes: MAX_ANALYZER_OUTPUT_NODES, maxDepth: MAX_ANALYZER_OUTPUT_DEPTH }
    )).toThrow("node limit");

    let withinDepth: Record<string, unknown> = {};
    for (let depth = 0; depth < MAX_ANALYZER_OUTPUT_DEPTH; depth += 1) withinDepth = { child: withinDepth };
    expect(() => assertAnalyzerOutputStructure(withinDepth, {
      maxNodes: MAX_ANALYZER_OUTPUT_NODES, maxDepth: MAX_ANALYZER_OUTPUT_DEPTH
    })).not.toThrow();
    expect(() => assertAnalyzerOutputStructure({ child: withinDepth }, {
      maxNodes: MAX_ANALYZER_OUTPUT_NODES, maxDepth: MAX_ANALYZER_OUTPUT_DEPTH
    })).toThrow("depth limit");
  });
});
