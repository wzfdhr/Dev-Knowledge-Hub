// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ApiClient } from "../api/client";
import { ProjectKnowledgeQualityPage } from "./project-knowledge-quality-page";

afterEach(() => cleanup());

const qualityResponse = {
  repository: { id: "repo-1", projectId: "project-1", kind: "upload", name: "源码", defaultBranch: "main" },
  latestSnapshot: null,
  currentRelease: null,
  latestBuild: null,
  pendingFeedbackCount: 0,
  indexedTextBytes: 1024,
  knowledge: { pageCount: 12, chunkCount: 24, citationCount: 36 },
  remediation: { open: 1, accepted: 0, rebuilding: 0, resolved: 0, dismissed: 0 },
  qualityPipeline: null,
  assessment: null,
  change: null,
  diagnostics: [{ code: "PUBLISHED" as const }]
};

function renderQuality(api: ApiClient, entry = "/projects/project-1/knowledge/quality") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(<QueryClientProvider client={queryClient}>
    <MemoryRouter initialEntries={[entry]}><Routes>
      <Route path="/projects/:projectId/knowledge/quality" element={<ProjectKnowledgeQualityPage api={api} />} />
    </Routes></MemoryRouter>
  </QueryClientProvider>);
}

function governanceApi() {
  return {
    session: vi.fn().mockResolvedValue({
      authenticated: true,
      admin: { id: "reader-1", email: "reader@example.com", role: "reader" }
    }),
    listProjectMembers: vi.fn().mockResolvedValue({
      members: [{ id: "reader-1", email: "reader@example.com", role: "reader" }]
    }),
    listProjectRemediations: vi.fn().mockResolvedValue({ remediations: [] })
  };
}

describe("project knowledge quality page", () => {
  test("loads releases through the explicit project API and switches metadata versions", async () => {
    const user = userEvent.setup();
    const listReleases = vi.fn();
    const listProjectReleases = vi.fn().mockResolvedValue({
      releases: [
        { id: "release-2", buildId: "build-2", snapshotId: "snapshot-2", version: "2.0.0", createdAt: "2026-07-22", publishedAt: "2026-07-22" },
        { id: "release-1", buildId: "build-1", snapshotId: "snapshot-1", version: "1.0.0", createdAt: "2026-07-21", publishedAt: null }
      ],
      total: 2,
      nextOffset: null
    });
    const getKnowledgeMetadata = vi.fn().mockImplementation(async (releaseId: string) => ({
      symbols: releaseId === "release-2"
        ? [{ name: "createOrder", kind: "function", path: "src/orders.ts", startLine: 8, endLine: 20, exported: true }]
        : [],
      dependencies: releaseId === "release-1"
        ? [{ source: "orders", target: "db", kind: "imports", path: "src/orders.ts", targetPath: "src/db.ts", startLine: 1, endLine: 1 }]
        : []
    }));
    const api = {
      ...governanceApi(),
      getProjectKnowledgeQuality: vi.fn().mockResolvedValue(qualityResponse),
      listProjectReleases,
      listReleases,
      getKnowledgeMetadata
    } as unknown as ApiClient;

    renderQuality(api);

    expect(await screen.findByRole("heading", { name: "知识质量" })).toBeVisible();
    await waitFor(() => expect(listProjectReleases).toHaveBeenCalledWith(
      "project-1", { limit: 100, offset: 0 }
    ));
    expect(listReleases).not.toHaveBeenCalled();
    expect(await screen.findByText("createOrder")).toBeVisible();
    expect(screen.getByText("12 / 36")).toBeVisible();

    await user.selectOptions(screen.getByLabelText("质量分析版本"), "release-1");
    await waitFor(() => expect(getKnowledgeMetadata).toHaveBeenLastCalledWith("release-1"));
    expect(await screen.findByText("orders → db")).toBeVisible();
  });

  test("shows a typed empty state without requesting metadata when the project has no release", async () => {
    const getKnowledgeMetadata = vi.fn();
    const api = {
      ...governanceApi(),
      getProjectKnowledgeQuality: vi.fn().mockResolvedValue({
        ...qualityResponse,
        repository: null,
        knowledge: { pageCount: 0, chunkCount: 0, citationCount: 0 },
        remediation: { open: 0, accepted: 0, rebuilding: 0, resolved: 0, dismissed: 0 },
        indexedTextBytes: 0,
        diagnostics: [{ code: "SOURCE_MISSING" as const }]
      }),
      listProjectReleases: vi.fn().mockResolvedValue({ releases: [], total: 0, nextOffset: null }),
      getKnowledgeMetadata
    } as unknown as ApiClient;

    renderQuality(api);

    expect(await screen.findByText("创建知识草稿后会显示符号和依赖关系。")).toBeVisible();
    expect(screen.getByText("尚未接入资料来源")).toBeVisible();
    expect(getKnowledgeMetadata).not.toHaveBeenCalled();
  });

  test("does not load a release ID that is absent from the project catalog", async () => {
    const getKnowledgeMetadata = vi.fn();
    const api = {
      ...governanceApi(),
      getProjectKnowledgeQuality: vi.fn().mockResolvedValue(qualityResponse),
      listProjectReleases: vi.fn().mockResolvedValue({
        releases: [{ id: "release-visible", buildId: "build", snapshotId: "snapshot", version: "visible", createdAt: "2026-07-22", publishedAt: "2026-07-22" }],
        total: 1,
        nextOffset: null
      }),
      getKnowledgeMetadata
    } as unknown as ApiClient;

    renderQuality(api, "/projects/project-1/knowledge/quality?releaseId=release-secret");

    expect(await screen.findByText("创建知识草稿后会显示符号和依赖关系。")).toBeVisible();
    expect(getKnowledgeMetadata).not.toHaveBeenCalled();
    expect(screen.queryByText("release-secret")).not.toBeInTheDocument();
  });
});
