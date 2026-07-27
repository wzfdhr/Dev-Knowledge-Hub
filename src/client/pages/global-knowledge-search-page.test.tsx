// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ApiClient } from "../api/client";
import { GlobalKnowledgeSearchPage } from "./global-knowledge-search-page";

afterEach(cleanup);

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
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={queryClient}><MemoryRouter>
      <GlobalKnowledgeSearchPage api={api} />
    </MemoryRouter></QueryClientProvider>);

    expect(screen.getByRole("heading", { name: "知识搜索" })).toBeVisible();
    await user.type(screen.getByRole("searchbox", { name: "跨项目搜索" }), "退款");

    await waitFor(() => expect(searchWorkspaceKnowledge).toHaveBeenCalledWith("退款"));
    expect(await screen.findByRole("link", { name: /退款流程/ })).toHaveAttribute(
      "href",
      "/projects/project-2/knowledge/pages?releaseId=release-2&pageId=page-2"
    );
    expect(screen.getByText("支付服务")).toBeVisible();
    expect(api.getRepositoryStatus).not.toHaveBeenCalled();
    expect(api.listReleases).not.toHaveBeenCalled();
  });
});
