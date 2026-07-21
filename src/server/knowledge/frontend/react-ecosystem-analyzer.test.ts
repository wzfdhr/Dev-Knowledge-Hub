import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { frontendEdgeSchema, frontendEntitySchema } from "../../../shared/frontend-ir.js";
import {
  parseFrontendEvaluationDatasets,
  validateFrontendFixtureReferences
} from "../../../../scripts/evaluate-frontend-knowledge.mjs";
import { analyzeStateDataSource } from "./state-data-analyzer.js";
import { analyzeStyleSource } from "./style-analyzer.js";
import { analyzeToolingTestSource } from "./tooling-test-analyzer.js";

const root = process.cwd();
const trialCapabilities = [
  "redux-toolkit",
  "tanstack-query",
  "openapi-graphql",
  "complex-form-validation",
  "permission-guards",
  "storybook",
  "design-system"
] as const;

function input(pathname: string, content: string, resolutions: Array<{ specifier: string; resolvedPath: string }> = []) {
  return {
    snapshotId: "snapshot-react-trial",
    path: pathname,
    content,
    blobHash: createHash("sha256").update(content).digest("hex"),
    packageKey: "@demo/react-trial",
    resolutions
  };
}

async function analyzeEcosystem(pathname: string, content: string, resolutions: Array<{ specifier: string; resolvedPath: string }> = []) {
  const { analyzeReactEcosystemSource } = await import("./react-ecosystem-analyzer.js");
  return analyzeReactEcosystemSource(input(pathname, content, resolutions));
}

describe("FK18 React trial analyzer coverage", () => {
  test("models Redux Toolkit slices, fields, actions, selectors, and store wiring", () => {
    const content = [
      "import { configureStore, createSlice } from '@reduxjs/toolkit';",
      "import { useDispatch, useSelector } from 'react-redux';",
      "const dashboardSlice = createSlice({ name: 'dashboard', initialState: { title: '', loading: false }, reducers: { setTitle(state, action) { state.title = action.payload; } } });",
      "export const { setTitle } = dashboardSlice.actions;",
      "export const selectTitle = (state) => state.dashboard.title;",
      "export const store = configureStore({ reducer: { dashboard: dashboardSlice.reducer } });",
      "export function Dashboard() { const title = useSelector(selectTitle); const dispatch = useDispatch(); dispatch(setTitle('Ready')); return <h1>{title}</h1>; }"
    ].join("\n");
    const output = analyzeStateDataSource(input("src/dashboard.tsx", content));

    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "state_store", name: "dashboardSlice", attributes: { library: { state: "known", value: "redux-toolkit" } } }),
      expect.objectContaining({ kind: "state_store", name: "store", attributes: { library: { state: "known", value: "redux-toolkit" } } }),
      expect.objectContaining({ kind: "state_field", name: "title" }),
      expect.objectContaining({ kind: "state_field", name: "setTitle", facets: { "state-data-core": expect.objectContaining({ role: "action" }) } }),
      expect.objectContaining({ kind: "state_field", name: "selectTitle", facets: { "state-data-core": expect.objectContaining({ role: "selector" }) } })
    ]));
    expect(output.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "contains" }),
      expect.objectContaining({ kind: "configures" }),
      expect.objectContaining({ kind: "selects" }),
      expect.objectContaining({ kind: "dispatches" })
    ]));
  });

  test("models TanStack query and mutation keys, fetchers, consumers, and invalidation", () => {
    const content = [
      "import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';",
      "import { loadDashboard, saveDashboard } from './api';",
      "export function useDashboard(teamId) {",
      "  const client = useQueryClient();",
      "  const dashboard = useQuery({ queryKey: ['dashboard', teamId], queryFn: () => loadDashboard(teamId) });",
      "  const update = useMutation({ mutationKey: ['dashboard', 'update'], mutationFn: saveDashboard, onSuccess: () => client.invalidateQueries({ queryKey: ['dashboard'] }) });",
      "  return { dashboard, update };",
      "}"
    ].join("\n");
    const output = analyzeStateDataSource(input("src/use-dashboard.ts", content, [
      { specifier: "./api", resolvedPath: "src/api.ts" }
    ]));

    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "api_operation", name: "dashboard", facets: { "state-data-core": expect.objectContaining({ queryKind: "query" }) } }),
      expect.objectContaining({ kind: "api_operation", name: "update", facets: { "state-data-core": expect.objectContaining({ queryKind: "mutation" }) } })
    ]));
    expect(output.entities.find((entity) => entity.kind === "api_operation" && entity.name === "dashboard")?.facets["state-data-core"])
      .toMatchObject({ queryKey: ["dashboard", ":teamId"], fetcher: "loadDashboard" });
    expect(output.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "requests" }),
      expect.objectContaining({ kind: "invalidates" })
    ]));
  });

  test("extracts Storybook config deeply while keeping V1.1 build and monorepo tools basic", () => {
    const storybook = analyzeToolingTestSource(input(".storybook/main.ts", [
      "export default {",
      "  stories: ['../src/**/*.stories.tsx'],",
      "  addons: ['@storybook/addon-a11y', '@storybook/addon-essentials'],",
      "  framework: { name: '@storybook/react-vite', options: {} }",
      "};"
    ].join("\n")));
    expect(storybook.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "tooling_config",
        name: "storybook",
        completeness: "complete",
        facets: { "tooling-test-core": expect.objectContaining({
          supportLevel: "deep",
          stories: ["../src/**/*.stories.tsx"],
          addons: ["@storybook/addon-a11y", "@storybook/addon-essentials"],
          framework: "@storybook/react-vite"
        }) }
      })
    ]));

    for (const [pathname, tool] of [
      ["webpack.config.ts", "webpack-family"],
      ["rollup.config.ts", "rollup"],
      ["turbo.json", "turborepo"],
      ["nx.json", "nx"]
    ] as const) {
      const output = analyzeToolingTestSource(input(pathname, "export default {};"));
      expect(output.entities).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: tool,
          completeness: "partial",
          facets: { "tooling-test-core": expect.objectContaining({ supportLevel: "basic-recognition" }) }
        })
      ]));
    }
  });

  test("links design token consumers to their definitions", () => {
    const output = analyzeStyleSource(input("src/theme.css", [
      ":root { --color-brand: #1677ff; --space-card: 16px; }",
      ".card { color: var(--color-brand); padding: var(--space-card); }"
    ].join("\n")));

    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "style_token", name: "--color-brand" }),
      expect.objectContaining({ kind: "style_token", name: "--space-card" })
    ]));
    expect(output.edges.filter((edge) => edge.kind === "uses_token")).toHaveLength(2);
  });

  test("models GraphQL documents and generated OpenAPI client operations", async () => {
    const content = [
      "import gql from 'graphql-tag';",
      "import { dashboardApi } from './generated/openapi';",
      "export const DashboardOverview = gql`query DashboardOverview($teamId: ID!) { dashboard(teamId: $teamId) { ...DashboardTitle } } fragment DashboardTitle on Dashboard { title }`;",
      "export async function loadDashboard(teamId) { return dashboardApi.GET('/teams/{teamId}/dashboard', { params: { path: { teamId } } }); }"
    ].join("\n");
    const output = await analyzeEcosystem("src/dashboard-api.ts", content, [
      { specifier: "./generated/openapi", resolvedPath: "src/generated/openapi.ts" }
    ]);

    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "api_operation",
        name: "DashboardOverview",
        facets: { "react-ecosystem-core": expect.objectContaining({ protocol: "graphql", operationType: "query" }) }
      }),
      expect.objectContaining({ kind: "data_schema", name: "DashboardTitle" }),
      expect.objectContaining({
        kind: "api_operation",
        attributes: { method: { state: "known", value: "GET" }, path: { state: "known", value: "/teams/{teamId}/dashboard" } },
        facets: { "react-ecosystem-core": expect.objectContaining({ protocol: "openapi", generatedClient: true }) }
      })
    ]));
    expect(output.edges).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "requests" })]));
    for (const entity of output.entities) expect(() => frontendEntitySchema.parse(entity)).not.toThrow();
    for (const edge of output.edges) expect(() => frontendEdgeSchema.parse(edge)).not.toThrow();
  });

  test("links React Hook Form fields to Zod validation and permission guards", async () => {
    const content = [
      "import { zodResolver } from '@hookform/resolvers/zod';",
      "import { useForm } from 'react-hook-form';",
      "import { z } from 'zod';",
      "const dashboardSchema = z.object({ title: z.string().min(3), teamId: z.string().uuid() });",
      "export function PermissionGuard({ permission, children }) { return can(permission) ? children : null; }",
      "export function DashboardForm() {",
      "  const { register, handleSubmit } = useForm({ resolver: zodResolver(dashboardSchema) });",
      "  return <PermissionGuard permission='dashboard:write'><form onSubmit={handleSubmit(saveDashboard)}><input {...register('title')} /><input {...register('teamId')} /></form></PermissionGuard>;",
      "}"
    ].join("\n");
    const output = await analyzeEcosystem("src/dashboard-form.tsx", content);

    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "data_schema", name: "dashboardSchema", attributes: { schemaKind: { state: "known", value: "zod" } } }),
      expect.objectContaining({ kind: "form", name: "DashboardForm" }),
      expect.objectContaining({ kind: "state_field", name: "title", facets: { "react-ecosystem-core": expect.objectContaining({ role: "form-field" }) } }),
      expect.objectContaining({ kind: "state_field", name: "teamId", facets: { "react-ecosystem-core": expect.objectContaining({ role: "form-field" }) } }),
      expect.objectContaining({
        kind: "component",
        name: "PermissionGuard",
        facets: { "react-ecosystem-core": expect.objectContaining({ role: "permission-guard", permissionKeys: ["dashboard:write"] }) }
      })
    ]));
    expect(output.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "contains" }),
      expect.objectContaining({ kind: "validates" }),
      expect.objectContaining({ kind: "guards" })
    ]));
  });

  test("models CSF stories and component-library wrapper boundaries", async () => {
    const content = [
      "import { forwardRef } from 'react';",
      "import { Card as CardPrimitive } from '@acme/ui';",
      "export const DashboardCard = forwardRef((props, ref) => <CardPrimitive ref={ref} {...props} />);",
      "const meta = { component: DashboardCard, decorators: [withTheme] };",
      "export default meta;",
      "export const Default = { args: { title: 'Dashboard' } };"
    ].join("\n");
    const output = await analyzeEcosystem("src/dashboard-card.stories.tsx", content, [
      { specifier: "@acme/ui", resolvedPath: "packages/ui/src/card.tsx" }
    ]);

    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "component",
        name: "DashboardCard",
        facets: { "react-ecosystem-core": expect.objectContaining({ encapsulation: "component-library-wrapper", primitive: "CardPrimitive" }) }
      }),
      expect.objectContaining({
        kind: "test_fixture",
        name: "Default",
        facets: { "react-ecosystem-core": expect.objectContaining({ role: "component-story", args: ["title"], decorators: 1 }) }
      })
    ]));
    expect(output.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "wraps" }),
      expect.objectContaining({ kind: "documents" })
    ]));
  });

  test("keeps deferred ecosystem packages at parser-backed basic recognition", async () => {
    const content = [
      "import i18next from 'i18next';",
      "import axe from '@axe-core/react';",
      "import * as Sentry from '@sentry/react';",
      "import { onCLS } from 'web-vitals';",
      "void [i18next, axe, Sentry, onCLS];"
    ].join("\n");
    const output = await analyzeEcosystem("src/observability.ts", content);

    for (const name of ["i18n", "accessibility", "error-monitoring", "web-vitals"]) {
      expect(output.entities).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "tooling_config",
          name,
          completeness: "partial",
          facets: { "react-ecosystem-core": expect.objectContaining({ supportLevel: "basic-recognition", target: "V1.1" }) }
        })
      ]));
    }
  });

  test("ships separated train and held-out evidence for every approved trial capability", async () => {
    const files = [
      { name: "evaluation/frontend/train/react-trial.jsonl", split: "train" as const },
      { name: "evaluation/frontend/held-out/react-trial.jsonl", split: "held-out" as const }
    ];
    const inputs = await Promise.all(files.map(async (file) => ({
      ...file,
      content: await readFile(path.join(root, file.name), "utf8")
    })));
    const rawCases = inputs.flatMap((item) => item.content.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as {
      split: string;
      trialCapability: string;
    }));

    expect(new Set(rawCases.map((item) => item.trialCapability))).toEqual(new Set(trialCapabilities));
    for (const capability of trialCapabilities) {
      expect(rawCases.some((item) => item.split === "train" && item.trialCapability === capability)).toBe(true);
      expect(rawCases.some((item) => item.split === "held-out" && item.trialCapability === capability)).toBe(true);
    }
    const cases = parseFrontendEvaluationDatasets(inputs);
    await expect(validateFrontendFixtureReferences(cases, path.join(root, "fixtures/frontend"))).resolves.toBeUndefined();
  });

  test("keeps local capability claims gated and pins representative fixture dependencies", async () => {
    const versions = JSON.parse(await readFile(path.join(root, "evaluation/frontend/versions.json"), "utf8")) as {
      trialCapabilities?: Record<string, { status: string; target: string }>;
      secondaryCapabilities?: Record<string, { status: string; target: string }>;
    };
    const fixture = JSON.parse(await readFile(path.join(root, "fixtures/frontend/react-vite/package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const app = await readFile(path.join(root, "fixtures/frontend/react-vite/src/app.tsx"), "utf8");
    const matrix = await readFile(path.join(root, "docs/product/frontend-capability-matrix.md"), "utf8");

    for (const capability of trialCapabilities) {
      expect(versions.trialCapabilities?.[capability]).toEqual({ status: "implemented-gated", target: "V1 Trial" });
    }
    for (const capability of ["webpack-rspack-rollup", "nx-turbo", "i18n", "accessibility", "error-monitoring", "web-vitals"]) {
      expect(versions.secondaryCapabilities?.[capability]).toEqual({ status: "basic-recognition", target: "V1.1" });
    }
    expect(fixture.dependencies).toMatchObject({
      "@reduxjs/toolkit": expect.any(String),
      "@hookform/resolvers": expect.any(String),
      "graphql-tag": expect.any(String),
      "react-hook-form": expect.any(String),
      "react-redux": expect.any(String),
      zod: expect.any(String)
    });
    expect(fixture.devDependencies).toMatchObject({ "@storybook/react-vite": expect.any(String) });
    expect(app).toContain("createSlice");
    expect(app).toContain("useQuery");
    expect(app).toContain("useForm");
    expect(app).toContain("PermissionGuard");
    expect(app).toContain("gql`");
    expect(matrix).toContain("implemented-gated");
    expect(matrix).toContain("V1.1 仍仅基础识别");
  });
});
