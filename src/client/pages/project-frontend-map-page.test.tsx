// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ApiError, type ApiClient } from "../api/client";
import { ProjectFrontendMapPage } from "./project-frontend-map-page";

afterEach(cleanup);

describe("ProjectFrontendMapPage", () => {
  test("shows invalid candidate evidence instead of a network diagnosis for preview 409", async () => {
    const api = {
      getProjectFrontendPreview: vi.fn(async () => {
        throw new ApiError(409, "FRONTEND_PREVIEW_INVALID", "Frontend candidate package is incomplete or invalid");
      })
    } as unknown as ApiClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/projects/project/frontend-map"]}><Routes>
      <Route path="/projects/:projectId/frontend-map" element={<ProjectFrontendMapPage api={api} />} />
    </Routes></MemoryRouter></QueryClientProvider>);

    expect(await screen.findByRole("heading", { name: "候选引用校验未通过" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "暂时无法读取预览" })).not.toBeInTheDocument();
  });

  test("navigates the frontend map and opens an exact candidate citation", async () => {
    const user = userEvent.setup();
    const ref = { snapshotId: "snapshot", path: "src/app.tsx", startLine: 1, endLine: 3, blobHash: "1".repeat(64) };
    const api = {
      getProjectFrontendPreview: vi.fn(async () => ({
        status: "ready",
        stale: false,
        comparison: {
          legacy: { entities: 1, factRelations: 0, pages: 1, searchDocuments: 1, impactPaths: 0, issues: 0 },
          candidate: { entities: 3, factRelations: 2, candidateRelations: 0, pages: 1, searchDocuments: 1, impactPaths: 1, issues: 0 },
          candidateEntityKeys: [], candidateFactKeys: [], impact: { legacyPaths: [], candidatePaths: ["src/app.tsx"], legacySuggestedTests: [], candidateSuggestedTests: ["src/app.test.tsx"] }, citations: { valid: true, checked: 2, invalid: [] }
        },
        preview: {
          build: { id: "build", snapshotId: "snapshot", commitSha: "a".repeat(40), status: "ready" },
          graph: {
            schemaVersion: 2, snapshotId: "snapshot", analyzerManifestDigest: "2".repeat(64),
            nodes: [
              { id: "route", kind: "route", name: "/", qualifiedName: "src/router.tsx#/", canonicalPath: "src/router.tsx", packageKey: "app", sourceRefs: [ref], facets: {}, attributes: {} },
              { id: "page", kind: "page", name: "DashboardPage", qualifiedName: "src/app.tsx#DashboardPage", canonicalPath: "src/app.tsx", packageKey: "app", sourceRefs: [ref], facets: {}, attributes: {} },
              { id: "component", kind: "component", name: "DashboardPage", qualifiedName: "src/app.tsx#DashboardPage", canonicalPath: "src/app.tsx", packageKey: "app", sourceRefs: [ref], facets: {}, attributes: {} }
            ],
            edges: [
              { id: "route-page", kind: "routes_to", fromEntityId: "route", toEntityId: "page", evidenceClass: "fact", confidence: 1, sourceRefs: [ref] },
              { id: "page-component", kind: "renders", fromEntityId: "page", toEntityId: "component", evidenceClass: "fact", confidence: 1, sourceRefs: [ref] }
            ]
          },
          pages: [],
          search: [],
          quality: { summary: { entities: 3, factEdges: 2, candidateEdges: 0, citedEntities: 3, components: 1, testedComponents: 0, routes: 1, visualizations: 0 }, issues: [] },
          visualization: { routeIds: ["route"], componentIds: ["component"], visualizationIds: [], factEdgeIds: ["route-page", "page-component"] },
          validation: { valid: true, pageCount: 1, issueCount: 0 }
        }
      })),
      getProjectFrontendPreviewSource: vi.fn(async () => ({ ...ref, commitSha: "a".repeat(40), content: "export function DashboardPage() {}" }))
    } as unknown as ApiClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/projects/project/frontend-map"]}><Routes>
      <Route path="/projects/:projectId/frontend-map" element={<ProjectFrontendMapPage api={api} />} />
    </Routes></MemoryRouter></QueryClientProvider>);

    expect(await screen.findByRole("heading", { name: "React 前端地图" })).toBeVisible();
    expect(screen.getByText("3")).toBeVisible();
    expect(screen.getByRole("heading", { name: "候选包可供验收" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "新旧内核比较" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "变更影响与建议测试" })).toBeVisible();
    expect(screen.getByText("src/app.test.tsx")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "路由与页面" }));
    expect(screen.getByText("DashboardPage")).toBeVisible();
    await user.click(screen.getAllByRole("button", { name: /src\/app.tsx 第 1 至 3 行/ })[0]!);

    expect(await screen.findByText("export function DashboardPage() {}" )).toBeVisible();
    expect(api.getProjectFrontendPreviewSource).toHaveBeenCalledWith("project", "build", ref);
  });
});
