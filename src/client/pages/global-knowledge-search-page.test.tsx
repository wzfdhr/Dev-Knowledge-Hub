// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ACTIVE_PROJECT_STORAGE_KEY, type ApiClient } from "../api/client";
import { GlobalKnowledgeSearchPage } from "./global-knowledge-search-page";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderSearch(api: ApiClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><MemoryRouter>
    <GlobalKnowledgeSearchPage api={api} />
  </MemoryRouter></QueryClientProvider>);
}

describe("global knowledge search", () => {
  test("searches across projects without loading a current repository or release catalog", async () => {
    const user = userEvent.setup();
    const searchWorkspaceKnowledge = vi.fn().mockResolvedValue({ results: [{
      projectId: "project-2",
      projectName: "支付服务",
      projectSlug: "payments",
      kind: "page",
      title: "退款流程",
      excerpt: "退款请求会先进入风控审核。",
      matchReason: "标题与正文匹配",
      score: 0.94,
      pageId: "page-2",
      releaseId: "release-2",
      citations: [],
      trust: { score: 0.93 }
    }] });
    const api = {
      searchWorkspaceKnowledge,
      getRepositoryStatus: vi.fn(),
      listReleases: vi.fn()
    } as unknown as ApiClient;

    renderSearch(api);

    expect(screen.getByRole("heading", { name: "知识搜索" })).toBeVisible();
    await user.type(screen.getByRole("searchbox", { name: "跨项目搜索" }), "退款");

    await waitFor(() => expect(searchWorkspaceKnowledge).toHaveBeenCalledWith("退款"));
    const result = await screen.findByRole("link", { name: /退款流程/ });
    expect(result).toHaveAttribute(
      "href",
      "/projects/project-2/knowledge/pages?releaseId=release-2&pageId=page-2"
    );
    expect(screen.getByText("支付服务")).toBeVisible();
    expect(api.getRepositoryStatus).not.toHaveBeenCalled();
    expect(api.listReleases).not.toHaveBeenCalled();

    await user.click(result);
    expect(localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY)).toBe("project-2");
    expect(JSON.parse(localStorage.getItem("devkh:recent-knowledge") ?? "[]")).toHaveLength(1);
  });

  test("focuses with the workspace shortcut and bounds recent knowledge to eight unique items", async () => {
    const existing = Array.from({ length: 8 }, (_, index) => ({
      projectId: `project-${index}`,
      projectName: `项目 ${index}`,
      releaseId: `release-${index}`,
      pageId: `page-${index}`,
      title: `页面 ${index}`
    }));
    localStorage.setItem("devkh:recent-knowledge", JSON.stringify(existing));
    const api = {
      searchWorkspaceKnowledge: vi.fn().mockResolvedValue({ results: [{
        projectId: "project-new",
        projectName: "新项目",
        projectSlug: "new-project",
        kind: "page",
        title: "新页面",
        excerpt: "新内容",
        matchReason: "标题匹配",
        score: 1,
        pageId: "page-new",
        releaseId: "release-new",
        citations: [],
        trust: { score: 1 }
      }] })
    } as unknown as ApiClient;
    const user = userEvent.setup();

    renderSearch(api);

    const input = screen.getByRole("searchbox", { name: "跨项目搜索" });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(input).toHaveFocus();

    await user.type(input, "新页面");
    await user.click(await screen.findByRole("link", { name: /新页面/ }));

    const recent = JSON.parse(localStorage.getItem("devkh:recent-knowledge") ?? "[]") as Array<{ pageId: string }>;
    expect(recent).toHaveLength(8);
    expect(recent[0]?.pageId).toBe("page-new");
    expect(recent.some((item) => item.pageId === "page-7")).toBe(false);
  });
});
