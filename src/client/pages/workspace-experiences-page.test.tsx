// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ApiClient } from "../api/client";
import { WorkspaceExperiencesPage } from "./workspace-experiences-page";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderPage(api: ApiClient, role: "admin" | "member" | "reader" = "member") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter>
    <WorkspaceExperiencesPage api={api} role={role} />
  </MemoryRouter></QueryClientProvider>);
}

describe("WorkspaceExperiencesPage", () => {
  test("renders a typed no-release state without a fake recommendation", async () => {
    const api = {
      listWorkspaceExperiences: vi.fn().mockResolvedValue({
        state: "no_release", currentProject: { projectId: "project-1", status: "no_release" },
        experiences: [], rejectedExperiences: []
      })
    } as unknown as ApiClient;
    localStorage.setItem("devkh:active-project-id", "project-1");

    renderPage(api);

    expect(await screen.findByRole("region", { name: "经验库状态" })).toHaveTextContent("当前项目尚无已发布版本");
    expect(screen.queryByText("团队推荐")).not.toBeInTheDocument();
  });

  test("keeps administrator review as a controlled view on the same page", async () => {
    const api = {
      listWorkspaceExperiences: vi.fn().mockResolvedValue({
        state: "ready", currentProject: { projectId: "project-1", status: "ready" },
        experiences: [{ id: "experience-1", title: "Cited pattern", capability: "forms", state: "recommended", observedFacts: ["fact"], evidenceCount: 2, trustScore: 0.9, citations: [] }],
        rejectedExperiences: []
      }),
      listExperienceReviewItems: vi.fn().mockResolvedValue({ reviewItems: [] })
    } as unknown as ApiClient;
    localStorage.setItem("devkh:active-project-id", "project-1");

    renderPage(api, "admin");

    expect(await screen.findByRole("heading", { name: "工程经验库" })).toBeVisible();
    expect(screen.getByRole("button", { name: "审核队列" })).toBeVisible();
  });
});
