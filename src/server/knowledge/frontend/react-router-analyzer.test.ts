import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { analyzeReactRouterSource } from "./react-router-analyzer.js";

function input(content: string) {
  return {
    snapshotId: "snapshot-router",
    path: "apps/web/src/router.tsx",
    content,
    blobHash: createHash("sha256").update(content).digest("hex"),
    packageKey: "@demo/web",
    resolutions: [
      { specifier: "./layout", resolvedPath: "apps/web/src/layout.tsx" },
      { specifier: "./dashboard", resolvedPath: "apps/web/src/dashboard.tsx" },
      { specifier: "./settings", resolvedPath: "apps/web/src/settings.tsx" }
    ]
  };
}

describe("analyzeReactRouterSource", () => {
  test("models nested data-router paths, layouts, loaders, actions, guards, and lazy pages", () => {
    const content = [
      "import { createBrowserRouter, Navigate } from 'react-router-dom';",
      "import { RootLayout } from './layout';",
      "import { DashboardPage } from './dashboard';",
      "const requireAdmin = () => true;",
      "export const router = createBrowserRouter([{",
      "  path: '/', element: <RootLayout />, loader: rootLoader, children: [",
      "    { path: 'dashboard/:teamId', Component: DashboardPage, action: saveDashboard },",
      "    { path: 'settings', element: requireAdmin() ? <SettingsPage /> : <Navigate to='/' />, lazy: () => import('./settings') }",
      "  ]",
      "}]);"
    ].join("\n");
    const output = analyzeReactRouterSource(input(content));

    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "route", name: "/", attributes: { path: { state: "known", value: "/" }, dynamic: { state: "known", value: false } } }),
      expect.objectContaining({ kind: "route", name: "/dashboard/:teamId", attributes: { path: { state: "known", value: "/dashboard/:teamId" }, dynamic: { state: "known", value: true } } }),
      expect.objectContaining({
        kind: "route",
        name: "/settings",
        facets: { "react-router-core": expect.objectContaining({ guard: "requireAdmin()", lazySpecifier: "./settings" }) }
      }),
      expect.objectContaining({ kind: "layout", name: "RootLayout", canonicalPath: "apps/web/src/layout.tsx" }),
      expect.objectContaining({ kind: "page", name: "DashboardPage", canonicalPath: "apps/web/src/dashboard.tsx" })
    ]));
    expect(output.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "contains" }),
      expect.objectContaining({ kind: "routes_to" }),
      expect.objectContaining({ kind: "lazy_loads" })
    ]));
  });

  test("models JSX Route declarations created with createRoutesFromElements", () => {
    const content = [
      "import { createRoutesFromElements, Route } from 'react-router-dom';",
      "export const routes = createRoutesFromElements(",
      "  <Route path='/' element={<Shell />}>",
      "    <Route index element={<HomePage />} />",
      "  </Route>",
      ");"
    ].join("\n");
    const output = analyzeReactRouterSource(input(content));

    expect(output.entities.filter((entity) => entity.kind === "route")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "/" }),
      expect.objectContaining({ name: "/#index" })
    ]));
  });
});
