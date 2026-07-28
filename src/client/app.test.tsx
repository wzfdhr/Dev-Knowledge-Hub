// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { KnowledgePage } from "./pages/knowledge-page";
import { FeedbackPage } from "./pages/feedback-page";
import { SystemSettingsPage as SettingsPage } from "./pages/system-settings-page";
import { ProjectCodexPage } from "./pages/project-codex-page";
import { ProjectImportsPage } from "./pages/project-imports-page";
import { ProjectGraphPage } from "./pages/project-graph-page";
import { ProjectKnowledgeQualityPage } from "./pages/project-knowledge-quality-page";
import { MembersPage } from "./pages/members-page";
import { governanceErrorMessage } from "./components/quality-governance-panel";
import { derivePrimaryAction, ProjectVersionsPage as OverviewPage } from "./pages/project-versions-page";
import { ApiError, type ApiClient } from "./api/client";
import { App } from "./app";
import { projectLegacyRedirects } from "./features/project-routes";
import { ErrorState } from "./components/ui";
import { AppShell } from "./components/app-shell";
import { ImportProgress } from "./components/import-progress";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });

function renderPage(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  );
}

function renderPageAt(node: React.ReactNode, path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
    </QueryClientProvider>
  );
}

function renderAppAt(api: ApiClient, path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}><App api={api} /></MemoryRouter>
    </QueryClientProvider>
  );
}

describe("shared console copy", () => {
  test("keeps every legacy project URL mapped to its new task area", () => {
    expect(projectLegacyRedirects).toEqual({
      imports: "../sources",
      versions: "../production",
      knowledge: "../knowledge/pages",
      graph: "../knowledge/graph",
      "frontend-map": "../knowledge/frontend",
      collaboration: "../settings/team",
      codex: "../settings/codex"
    });
  });

  test("hides workspace administration from non-admin navigation and labels the real role", () => {
    renderPage(<Routes><Route element={<AppShell email="member@example.com" role="member" onLogout={() => {}} />}>
      <Route index element={<p>Workspace</p>} />
    </Route></Routes>);

    expect(screen.getByRole("link", { name: "项目中心" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "成员" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "设置" })).not.toBeInTheDocument();
    expect(screen.getByText("成员", { selector: "footer strong" })).toBeVisible();
  });

  test("marks only completed import stages before upload confirmation", () => {
    const { container } = renderPage(<ImportProgress progress={{
      phase: "filtering", status: "completed", percent: 100,
      processedFiles: 3, totalFiles: 3, detail: "已完成过滤"
    }} />);

    const stages = Array.from(container.querySelectorAll(".import-stage"));
    expect(stages.map((stage) => stage.classList.contains("complete"))).toEqual([
      true, true, false, false, false
    ]);
  });

  test("shows verified file and byte totals during folder transfer", () => {
    renderPage(<ImportProgress progress={{
      phase: "uploading", status: "running", percent: 40,
      processedFiles: 1, totalFiles: 2, processedBytes: 4, totalBytes: 10,
      detail: "已验证 1/2 个源码文件"
    }} />);

    expect(screen.getByText("1/2 个文件 · 4 B/10 B")).toBeVisible();
  });

  test("explains when a remediation candidate is not ready for resolution", () => {
    expect(governanceErrorMessage(new ApiError(
      409,
      "REMEDIATION_REBUILD_NOT_READY",
      "Remediation rebuild must be ready before resolution"
    ))).toBe("范围重建候选仍在处理中；当前版本未改变。请在候选构建就绪并审核后再标记已解决。");
  });

  test("uses direct flex containers for collaboration members instead of a table widget", async () => {
    const source = await readFile(resolve(process.cwd(), "src/client/pages/project-collaboration-page.tsx"), "utf8");
    const workspaceSource = await readFile(resolve(process.cwd(), "src/client/pages/members-page.tsx"), "utf8");

    expect(source).toContain('className="member-list"');
    expect(source).not.toContain("<Table");
    expect(workspaceSource).toContain('className="member-list workspace-member-list"');
    expect(workspaceSource).not.toContain("<Table");
  });

  test("does not let member creation fields reuse the administrator login autofill", async () => {
    const user = userEvent.setup();
    const api = {
      listMembers: vi.fn().mockResolvedValue({ members: [] })
    } as unknown as ApiClient;

    renderPage(<MembersPage api={api} />);

    await user.click(await screen.findByRole("button", { name: "添加成员" }));

    expect(screen.getByLabelText("邮箱")).toHaveAttribute("autocomplete", "off");
    expect(screen.getByLabelText("初始密码")).toHaveAttribute("autocomplete", "new-password");
  });

  test("keeps project navigation scoped to the project URL", async () => {
    const api = {
      setupStatus: vi.fn().mockResolvedValue({ setupRequired: false }),
      session: vi.fn().mockResolvedValue({ admin: { email: "admin@example.com", role: "admin" } }),
      logout: vi.fn().mockResolvedValue(undefined),
      listProjects: vi.fn().mockResolvedValue({ projects: [{
        id: "project-1", name: "AHeart Admin", slug: "aheart-admin",
        archivedAt: null, createdAt: "2026-07-13T00:00:00Z"
      }] }),
      listProjectActivity: vi.fn().mockResolvedValue({
        activity: [], members: [], total: 0, nextOffset: null
      })
    } as unknown as ApiClient;

    renderAppAt(api, "/projects/project-1/collaboration");

    await waitFor(() => expect(api.listProjects).toHaveBeenCalledOnce(), { timeout: 5_000 });
    expect(await screen.findByText("AHeart Admin", { selector: ".project-name" }, { timeout: 5_000 })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "项目导航" })).toBeVisible();
    expect(screen.getByRole("link", { name: "项目概览" })).toHaveAttribute("href", "/projects/project-1/overview");
    expect(screen.getByRole("link", { name: "资料接入" })).toHaveAttribute("href", "/projects/project-1/sources");
    expect(screen.getByRole("link", { name: "知识生产" })).toHaveAttribute("href", "/projects/project-1/production");
    expect(screen.getByRole("link", { name: "知识资料" })).toHaveAttribute("href", "/projects/project-1/knowledge/pages");
    expect(screen.getByRole("link", { name: "项目设置" })).toHaveAttribute("href", "/projects/project-1/settings/team");
    expect(within(screen.getByRole("navigation", { name: "项目导航" })).getAllByRole("link")).toHaveLength(5);
    expect(await screen.findByRole("heading", { name: "团队协作" })).toBeVisible();
  });

  test("renders folder import as a dedicated project workflow", async () => {
    const api = {
      setupStatus: vi.fn().mockResolvedValue({ setupRequired: false }),
      session: vi.fn().mockResolvedValue({ admin: { email: "admin@example.com", role: "admin" } }),
      logout: vi.fn().mockResolvedValue(undefined),
      listProjects: vi.fn().mockResolvedValue({ projects: [{
        id: "project-1", name: "AHeart Admin", slug: "aheart-admin",
        archivedAt: null, createdAt: "2026-07-13T00:00:00Z"
      }] }),
      getRepository: vi.fn().mockRejectedValue(new ApiError(404, "REPOSITORY_NOT_FOUND", "No repository"))
    } as unknown as ApiClient;

    renderAppAt(api, "/projects/project-1/sources");

    expect(await screen.findByRole("heading", { name: "资料接入" })).toBeVisible();
    expect(screen.getByRole("button", { name: "选择项目文件夹" })).toBeVisible();
    expect(screen.getByText("选择资料来源后开始导入")).toBeVisible();
    expect(screen.queryByText("读取文件")).not.toBeInTheDocument();
  });

  test("separates project overview from knowledge version operations", async () => {
    const api = {
      setupStatus: vi.fn().mockResolvedValue({ setupRequired: false }),
      session: vi.fn().mockResolvedValue({ admin: { email: "admin@example.com", role: "admin" } }),
      logout: vi.fn().mockResolvedValue(undefined),
      listProjects: vi.fn().mockResolvedValue({ projects: [{
        id: "project-1", name: "AHeart Admin", slug: "aheart-admin",
        archivedAt: null, createdAt: "2026-07-13T00:00:00Z"
      }] }),
      getRepository: vi.fn().mockResolvedValue({ repository: {
        id: "repo", projectId: "project-1", kind: "upload", name: "AHeart Admin", defaultBranch: "upload"
      } }),
      getRepositoryStatus: vi.fn().mockResolvedValue({
        repository: { id: "repo", projectId: "project-1", kind: "upload", name: "AHeart Admin", defaultBranch: "upload" },
        latestSnapshot: { id: "snapshot", commitSha: "a".repeat(40), ref: "upload", commitTimestamp: "2026-07-13", fileCount: 10 }
      }),
      listBuilds: vi.fn().mockResolvedValue({ builds: [], total: 0, nextOffset: null }),
      listReleases: vi.fn().mockResolvedValue({ releases: [], total: 0, nextOffset: null }),
      listFeedback: vi.fn().mockResolvedValue({ feedback: [], total: 0, nextOffset: null }),
      getProjectSummary: vi.fn().mockResolvedValue({
        project: { id: "project-1", name: "AHeart Admin", slug: "aheart-admin", archivedAt: null, createdAt: "2026-07-13T00:00:00Z" },
        repository: { id: "repo", projectId: "project-1", kind: "upload", name: "AHeart Admin", defaultBranch: "upload" },
        latestSnapshot: { id: "snapshot", commitSha: "a".repeat(40), ref: "upload", commitTimestamp: "2026-07-13", fileCount: 10 },
        currentRelease: null,
        latestBuild: null,
        memberCount: 1
      })
    } as unknown as ApiClient;

    renderAppAt(api, "/projects/project-1/overview");
    expect(await screen.findByRole("heading", { name: "项目概览" })).toBeVisible();
    expect(screen.getByRole("link", { name: "开始构建" })).toHaveAttribute("href", "/projects/project-1/production");
    expect(screen.getAllByRole("link", { name: "开始构建" })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "最近构建" })).not.toBeInTheDocument();
    cleanup();

    renderAppAt(api, "/projects/project-1/production");
    expect(await screen.findByRole("heading", { name: "知识生产" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "最近构建" })).toBeVisible();
  });

  test("moves project Codex access out of system settings", async () => {
    const api = {
      setupStatus: vi.fn().mockResolvedValue({ setupRequired: false }),
      session: vi.fn().mockResolvedValue({ admin: { email: "admin@example.com", role: "admin" } }),
      logout: vi.fn().mockResolvedValue(undefined),
      listProjects: vi.fn().mockResolvedValue({ projects: [{
        id: "project-1", name: "AHeart Admin", slug: "aheart-admin",
        archivedAt: null, createdAt: "2026-07-13T00:00:00Z"
      }] }),
      getProjectCodexConnection: vi.fn().mockResolvedValue({
        projectId: "project-1", endpoint: "https://knowledge.example.com/mcp",
        environmentVariable: "DEVKH_AHEART_ADMIN_TOKEN",
        configToml: "[mcp_servers.devkh_project-1]",
        agentsMarkdown: "# AHeart Admin 知识库规则",
        checkCommand: "test -n \"$DEVKH_AHEART_ADMIN_TOKEN\""
      }),
      listMcpTokens: vi.fn().mockResolvedValue({ tokens: [], total: 0, nextOffset: null })
    } as unknown as ApiClient;

    renderAppAt(api, "/projects/project-1/codex");
    expect(await screen.findByRole("heading", { name: "Codex 接入" })).toBeVisible();
    expect(screen.getByRole("heading", { name: ".codex/config.toml" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "AGENTS.md" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "项目 Token" })).toBeVisible();
    cleanup();

    const settingsApi = {
      setupStatus: vi.fn().mockResolvedValue({ setupRequired: false }),
      session: vi.fn().mockResolvedValue({ admin: { email: "admin@example.com", role: "admin" } }),
      logout: vi.fn().mockResolvedValue(undefined),
      getModelConfig: vi.fn().mockResolvedValue({ config: null })
    } as unknown as ApiClient;
    renderAppAt(settingsApi, "/settings");
    expect(await screen.findByRole("heading", { name: "设置" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "MCP 连接" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "访问 Token" })).not.toBeInTheDocument();
  });

  test("shows real members and persisted activity in project collaboration", async () => {
    const api = {
      setupStatus: vi.fn().mockResolvedValue({ setupRequired: false }),
      session: vi.fn().mockResolvedValue({ admin: { email: "admin@example.com", role: "admin" } }),
      logout: vi.fn().mockResolvedValue(undefined),
      listProjects: vi.fn().mockResolvedValue({ projects: [{ id: "project-1", name: "AHeart Admin", slug: "aheart-admin", archivedAt: null, createdAt: "2026-07-13" }] }),
      listProjectActivity: vi.fn().mockResolvedValue({
        activity: [{ id: "event-1", projectId: "project-1", actorEmail: "admin@example.com", action: "repository.sync_succeeded", resourceType: "repository", resourceId: "repo", metadata: {}, createdAt: "2026-07-13T08:00:00Z" }],
        members: [{ id: "member-1", email: "admin@example.com", role: "admin", createdAt: "2026-07-11T08:00:00Z" }],
        total: 1,
        nextOffset: null
      })
    } as unknown as ApiClient;

    renderAppAt(api, "/projects/project-1/collaboration");

    expect(await screen.findByRole("heading", { name: "团队协作" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "项目成员" })).toBeVisible();
    expect(screen.getByRole("button", { name: "添加成员" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "项目角色" })).toBeVisible();
    expect(screen.getByText("资料同步成功")).toBeVisible();
    expect(screen.getAllByText("admin@example.com")).not.toHaveLength(0);
  });

  test("shows project delivery state in the fusion project center", async () => {
    const api = {
      setupStatus: vi.fn().mockResolvedValue({ setupRequired: false }),
      session: vi.fn().mockResolvedValue({ admin: { email: "admin@example.com", role: "admin" } }),
      logout: vi.fn().mockResolvedValue(undefined),
      listProjects: vi.fn().mockResolvedValue({ projects: [{
        id: "project-1", name: "AHeart Admin", slug: "aheart-admin",
        archivedAt: null, createdAt: "2026-07-13T00:00:00Z"
      }] }),
      getProjectSummary: vi.fn().mockResolvedValue({
        project: { id: "project-1", name: "AHeart Admin", slug: "aheart-admin", archivedAt: null, createdAt: "2026-07-13T00:00:00Z" },
        repository: { id: "repo-1", projectId: "project-1", kind: "upload", name: "管理后台源码", defaultBranch: "main" },
        latestSnapshot: { id: "snapshot-1", commitSha: "a".repeat(40), ref: "upload", commitTimestamp: "2026-07-13T08:00:00Z", fileCount: 128 },
        currentRelease: { id: "release-1", buildId: "build-1", snapshotId: "snapshot-1", version: "v1.4.0", createdAt: "2026-07-13T08:10:00Z", publishedAt: "2026-07-13T08:20:00Z" },
        latestBuild: { id: "build-1", snapshotId: "snapshot-1", commitSha: "a".repeat(40), status: "published", warnings: [], cancelRequested: false },
        memberCount: 3
      })
    } as unknown as ApiClient;

    renderAppAt(api, "/projects");

    expect(await screen.findByRole("heading", { name: "项目中心" })).toBeVisible();
    expect(await screen.findByText("v1.4.0")).toBeVisible();
    expect(screen.getAllByText("当前发布")).not.toHaveLength(0);
    expect(screen.getAllByText("最近导入")).not.toHaveLength(0);
    expect(screen.getByText("3 人")).toBeVisible();
    expect(screen.getByText("128 个文件")).toBeVisible();
  });

  test("renders Chinese console navigation", async () => {
    const user = userEvent.setup();
    const api = {
      setupStatus: vi.fn().mockResolvedValue({ setupRequired: false }),
      session: vi.fn().mockResolvedValue({ admin: { email: "admin@example.com" } }),
      logout: vi.fn().mockResolvedValue(undefined),
      getRepository: vi.fn().mockRejectedValue(new Error("Repository unavailable")),
      listBuilds: vi.fn().mockResolvedValue({ builds: [], total: 0, nextOffset: null }),
      listReleases: vi.fn().mockResolvedValue({ releases: [], total: 0, nextOffset: null }),
      listFeedback: vi.fn().mockResolvedValue({ feedback: [], total: 0, nextOffset: null })
    } as unknown as ApiClient;

    renderPage(<><App api={api} /><ErrorState message="Retry fixture" retry={() => {}} /></>);

    expect(await screen.findByRole("link", { name: "项目中心" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeVisible();
    expect(screen.getByRole("link", { name: "项目中心" })).toBeVisible();
    expect(screen.getByRole("link", { name: "知识搜索" })).toBeVisible();
    expect(screen.getByRole("link", { name: "反馈" })).toBeVisible();
    expect(screen.getByRole("link", { name: "成员" })).toBeVisible();
    expect(screen.getByRole("link", { name: "设置" })).toBeVisible();
    expect(screen.getByRole("button", { name: "重试" })).toBeVisible();

    await user.click(screen.getByRole("link", { name: "成员" }));
    expect(await screen.findByRole("heading", { name: "成员" })).toBeVisible();
  });
});

describe("operations page copy", () => {
  test("renders Chinese operations copy", async () => {
    const user = userEvent.setup();
    const commit = "a".repeat(40);
    const overviewApi = {
      getRepository: vi.fn().mockResolvedValue({ repository: {
        id: "repo", projectId: "project", kind: "local", name: "Fixture", path: "/fixture", defaultBranch: "main"
      } }),
      listBuilds: vi.fn().mockResolvedValue({ builds: [{
        id: "build", status: "published", snapshotId: "snap", commitSha: commit,
        warnings: [], cancelRequested: false
      }] }),
      listReleases: vi.fn().mockResolvedValue({ releases: [{
        id: "release", buildId: "build", snapshotId: "snap", version: "1.0.0",
        createdAt: "2026-07-11", publishedAt: "2026-07-11"
      }] }),
      listFeedback: vi.fn().mockResolvedValue({ feedback: [] })
    } as unknown as ApiClient;

    renderPage(<OverviewPage api={overviewApi} />);
    expect(await screen.findByRole("heading", { name: "知识生产" })).toBeVisible();
    expect(screen.getByRole("button", { name: "同步仓库" })).toBeVisible();
    cleanup();

    const knowledgeApi = {
      getRepositoryStatus: vi.fn().mockResolvedValue({
        repository: { id: "repo" },
        latestSnapshot: { id: "snap", commitSha: commit, ref: "main", commitTimestamp: "2026-07-11" }
      }),
      listReleases: vi.fn().mockResolvedValue({ releases: [{
        id: "release", buildId: "build", snapshotId: "snap", version: "1.0.0",
        createdAt: "2026-07-11", publishedAt: "2026-07-11"
      }] }),
      getKnowledgeMetadata: vi.fn().mockResolvedValue({ symbols: [], dependencies: [] }),
      listKnowledgePages: vi.fn().mockResolvedValue({ pages: [{
        id: "page", slug: "module-math", title: "模块：math", body: "数学模块。", chunks: [{
          id: "chunk", heading: "add", content: "Adds numbers.", citations: [{
            path: "src/math.ts", startLine: 16, endLine: 18, commitSha: commit, blobHash: "b".repeat(64)
          }]
        }]
      }] }),
      getKnowledgePage: vi.fn().mockResolvedValue({ page: {
        id: "page", slug: "module-math", title: "模块：math", body: "数学模块。", chunks: [{
          id: "chunk", heading: "add", content: "Adds numbers.", citations: [{
            path: "src/math.ts", startLine: 16, endLine: 18, commitSha: commit, blobHash: "b".repeat(64)
          }]
        }]
      } }),
      getSource: vi.fn().mockResolvedValue({
        path: "src/math.ts", startLine: 16, endLine: 18, commitSha: commit,
        blobHash: "b".repeat(64), content: "export function add() {}"
      })
    } as unknown as ApiClient;

    renderPage(<KnowledgePage api={knowledgeApi} />);
    expect(await screen.findByRole("heading", { name: "知识资料" })).toBeVisible();
    expect(screen.getByLabelText("知识页面").querySelector(".page-tree-list")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "模块：math" }));
    await user.click(screen.getByRole("button", { name: /src\/math.ts 第 16 至 18 行/i }));
    expect(await screen.findByText(`Commit ${"a".repeat(12)}`)).toBeVisible();
    cleanup();

    const feedbackApi = {
      listFeedback: vi.fn().mockResolvedValue({ feedback: [{
        id: "feedback", releaseId: "release", query: "How do I deploy?", reason: "Missing runbook",
        expected: null, status: "open", rebuildBuildId: null, citations: [],
        createdAt: "2026-07-11T00:00:00Z", updatedAt: "2026-07-11T00:00:00Z"
      }] })
    } as unknown as ApiClient;

    renderPage(<FeedbackPage api={feedbackApi} />);
    expect(await screen.findByRole("heading", { name: "反馈" })).toBeVisible();
    await user.click(await screen.findByRole("button", { name: "How do I deploy?" }));
    expect(screen.getByRole("button", { name: "确认处理" })).toBeVisible();
    cleanup();

    const settingsApi = {
      getRepository: vi.fn().mockResolvedValue({ repository: {
        id: "repo", kind: "local", name: "Fixture", path: "/fixture", defaultBranch: "main"
      } }),
      getModelConfig: vi.fn().mockResolvedValue({ config: null }),
      getMcpConnection: vi.fn().mockResolvedValue({
        endpoint: "/mcp", transport: "streamable-http", authorization: "bearer", tools: []
      }),
      listMcpTokens: vi.fn().mockResolvedValue({ tokens: [] })
    } as unknown as ApiClient;

    renderPage(<SettingsPage api={settingsApi} />);
    expect(await screen.findByRole("heading", { name: "设置" })).toBeVisible();
    expect(await screen.findByText("模型服务商")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "仓库" })).not.toBeInTheDocument();
  });
});

describe("overview primary command", () => {
  test("chooses the single next operation from repository and build state", () => {
    expect(derivePrimaryAction({ repository: null, builds: [], releases: [] }).kind)
      .toBe("connect");
    expect(derivePrimaryAction({
      repository: { id: "repo", projectId: "project", kind: "local", name: "Fixture", path: "/fixture", defaultBranch: "main" },
      builds: [], releases: [], snapshotId: "snap"
    }).kind).toBe("start-build");
    expect(derivePrimaryAction({
      repository: { id: "repo", projectId: "project", kind: "local", name: "Fixture", path: "/fixture", defaultBranch: "main" },
      builds: [{ id: "build", status: "ready", snapshotId: "snap", commitSha: "abc", warnings: [], cancelRequested: false }],
      releases: []
    }).kind).toBe("review");
    expect(derivePrimaryAction({
      repository: { id: "repo", projectId: "project", kind: "local", name: "Fixture", path: "/fixture", defaultBranch: "main" },
      builds: [{ id: "build", status: "ready", snapshotId: "snap", commitSha: "abc", warnings: [], cancelRequested: false }],
      releases: [{ id: "release", buildId: "build", snapshotId: "snap", version: "1.0.0", createdAt: "2026-07-11", publishedAt: null }]
    }).kind).toBe("publish");
    expect(derivePrimaryAction({
      repository: { id: "repo", projectId: "project", kind: "local", name: "Fixture", path: "/fixture", defaultBranch: "main" },
      builds: [{ id: "build", status: "published", snapshotId: "snap", commitSha: "abc", warnings: [], cancelRequested: false }],
      releases: [{ id: "release", buildId: "build", snapshotId: "snap", version: "1.0.0", createdAt: "2026-07-11", publishedAt: "2026-07-11" }],
      snapshotId: "snap"
    }).kind).toBe("sync");
  });

  test("restores an uploaded content version after refresh so it can be built", async () => {
    const contentVersion = "c".repeat(40);
    const api = {
      getRepository: vi.fn().mockResolvedValue({ repository: {
        id: "upload", kind: "upload", name: "Uploaded project", defaultBranch: "upload"
      } }),
      getRepositoryStatus: vi.fn().mockResolvedValue({
        repository: { id: "upload", kind: "upload", name: "Uploaded project", defaultBranch: "upload" },
        latestSnapshot: { id: "snapshot", commitSha: contentVersion, ref: "upload", commitTimestamp: "2026-07-12" }
      }),
      listBuilds: vi.fn().mockResolvedValue({ builds: [], total: 0, nextOffset: null }),
      listReleases: vi.fn().mockResolvedValue({ releases: [], total: 0, nextOffset: null }),
      listFeedback: vi.fn().mockResolvedValue({ feedback: [], total: 0, nextOffset: null })
    } as unknown as ApiClient;

    renderPage(<OverviewPage api={api} />);

    expect(await screen.findByRole("button", { name: "开始构建知识" })).toBeVisible();
    expect(screen.getByText("内容版本")).toBeVisible();
    expect(screen.getByText(contentVersion.slice(0, 12))).toBeVisible();
  });

  test("blocks state-derived commands when build state fails to load", async () => {
    const api = {
      getRepository: vi.fn().mockResolvedValue({ repository: {
        id: "repo", kind: "local", name: "Fixture", path: "/fixture", defaultBranch: "main"
      } }),
      listBuilds: vi.fn().mockRejectedValue(new Error("Build state unavailable")),
      listReleases: vi.fn().mockResolvedValue({ releases: [] }),
      listFeedback: vi.fn().mockResolvedValue({ feedback: [] })
    } as unknown as ApiClient;

    renderPage(<OverviewPage api={api} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Build state unavailable");
    expect(screen.queryByRole("button", { name: /sync repository|start knowledge build|review ready build|publish release/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试总览数据" })).toBeVisible();
  });

  test("keeps knowledge versions read-only for a project reader", async () => {
    const api = {
      getRepository: vi.fn().mockResolvedValue({ repository: {
        id: "repo", projectId: "project-1", kind: "upload", name: "Fixture", defaultBranch: "upload"
      } }),
      getRepositoryStatus: vi.fn().mockResolvedValue({
        repository: { id: "repo" },
        latestSnapshot: { id: "snap", commitSha: "a".repeat(40), ref: "upload", commitTimestamp: "2026-07-20" }
      }),
      listBuilds: vi.fn().mockResolvedValue({ builds: [{
        id: "build", status: "ready", snapshotId: "snap", commitSha: "a".repeat(40),
        warnings: [], cancelRequested: false
      }], total: 1, nextOffset: null }),
      listReleases: vi.fn().mockResolvedValue({ releases: [], total: 0, nextOffset: null }),
      listFeedback: vi.fn().mockResolvedValue({ feedback: [], total: 0, nextOffset: null }),
      session: vi.fn().mockResolvedValue({ admin: { id: "reader-1", email: "reader@example.com", role: "reader" } }),
      listProjectMembers: vi.fn().mockResolvedValue({ members: [{
        id: "reader-1", email: "reader@example.com", role: "reader"
      }] }),
      getBuildStages: vi.fn().mockResolvedValue({ stages: [], pipelineStatus: "ready" })
    } as unknown as ApiClient;

    renderPageAt(<Routes><Route path="/projects/:projectId/versions" element={<OverviewPage api={api} />} /></Routes>, "/projects/project-1/versions");

    expect(await screen.findByRole("heading", { name: "最近构建" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "审核就绪构建" })).not.toBeInTheDocument();
  });

  test("review mode keeps exactly one blue primary command", async () => {
    const user = userEvent.setup();
    const api = {
      getRepository: vi.fn().mockResolvedValue({ repository: {
        id: "repo", kind: "local", name: "Fixture", path: "/fixture", defaultBranch: "main"
      } }),
      listBuilds: vi.fn().mockResolvedValue({ builds: [{
        id: "build", status: "ready", snapshotId: "snap", commitSha: "a".repeat(40),
        warnings: [], cancelRequested: false
      }] }),
      listReleases: vi.fn().mockResolvedValue({ releases: [] }),
      listFeedback: vi.fn().mockResolvedValue({ feedback: [] }),
      createRelease: vi.fn().mockResolvedValue({ release: { id: "release" } })
    } as unknown as ApiClient;

    const { container } = renderPage(<OverviewPage api={api} />);
    await user.click(await screen.findByRole("button", { name: "审核就绪构建" }));

    expect(screen.getByRole("button", { name: "创建版本草稿" })).toBeVisible();
    expect(container.querySelectorAll("button.button.primary")).toHaveLength(1);
  });

  test("creates and selects a draft before navigating from ready-build review to Knowledge", async () => {
    const user = userEvent.setup();
    const createRelease = vi.fn().mockResolvedValue({ release: {
      id: "release-1",
      buildId: "build",
      snapshotId: "snap",
      version: "1.0.0",
      createdAt: "2026-07-11",
      publishedAt: null
    } });
    const api = {
      getRepository: vi.fn().mockResolvedValue({ repository: {
        id: "repo", kind: "local", name: "Fixture", path: "/fixture", defaultBranch: "main"
      } }),
      listBuilds: vi.fn().mockResolvedValue({ builds: [{
        id: "build", status: "ready", snapshotId: "snap", commitSha: "a".repeat(40),
        warnings: [], cancelRequested: false
      }] }),
      listReleases: vi.fn().mockResolvedValue({ releases: [] }),
      listFeedback: vi.fn().mockResolvedValue({ feedback: [] }),
      createRelease
    } as unknown as ApiClient;
    function Location() {
      const location = useLocation();
      return <p data-testid="location">{location.pathname}{location.search}</p>;
    }
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    });
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/projects/project-1/production"]}>
      <Location />
      <Routes>
        <Route path="/projects/:projectId/production" element={<OverviewPage api={api} />} />
        <Route path="/projects/:projectId/knowledge/pages" element={<p>Knowledge route</p>} />
      </Routes>
    </MemoryRouter></QueryClientProvider>);

    await user.click(await screen.findByRole("button", { name: "审核就绪构建" }));
    await user.click(screen.getByRole("button", { name: "创建版本草稿" }));

    await waitFor(() => expect(createRelease).toHaveBeenCalledWith("build", "1.0.0"));
    expect(await screen.findByText("Knowledge route")).toBeVisible();
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/project-1/knowledge/pages?releaseId=release-1");
  });

  test("keeps EventSource alive for native reconnect and reports connection state", async () => {
    class FakeEventSource {
      static instance: FakeEventSource;
      onerror: (() => void) | null = null;
      onopen: (() => void) | null = null;
      close = vi.fn();
      constructor(readonly url: string) { FakeEventSource.instance = this; }
      addEventListener() {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const api = {
      getRepository: vi.fn().mockResolvedValue({ repository: {
        id: "repo", kind: "local", name: "Fixture", path: "/fixture", defaultBranch: "main"
      } }),
      listBuilds: vi.fn().mockResolvedValue({ builds: [{
        id: "build", status: "synthesizing", snapshotId: "snap", commitSha: "a".repeat(40),
        warnings: [], cancelRequested: false
      }] }),
      listReleases: vi.fn().mockResolvedValue({ releases: [] }),
      listFeedback: vi.fn().mockResolvedValue({ feedback: [] })
    } as unknown as ApiClient;

    const { container } = renderPage(<OverviewPage api={api} />);
    await screen.findByText("生成中", { selector: "h2" });
    expect(container.querySelector("progress")).toHaveAttribute("value", "66");
    expect(container.querySelector(".progress [style]")).toBeNull();
    FakeEventSource.instance.onerror?.();

    await waitFor(() => expect(screen.getByText("生成中", { selector: "h2" }).closest("section"))
      .toHaveTextContent("正在重新连接构建更新"));
    expect(FakeEventSource.instance.close).not.toHaveBeenCalled();
  });

  test("closes EventSource after it receives a terminal build event", async () => {
    class FakeEventSource {
      static instance: FakeEventSource;
      onerror: (() => void) | null = null;
      onopen: (() => void) | null = null;
      close = vi.fn();
      listeners = new Map<string, (event: MessageEvent) => void>();
      constructor(readonly url: string) { FakeEventSource.instance = this; }
      addEventListener(type: string, listener: (event: MessageEvent) => void) { this.listeners.set(type, listener); }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const api = {
      getRepository: vi.fn().mockResolvedValue({ repository: {
        id: "repo", kind: "local", name: "Fixture", path: "/fixture", defaultBranch: "main"
      } }),
      listBuilds: vi.fn().mockResolvedValue({ builds: [{
        id: "build", status: "synthesizing", snapshotId: "snap", commitSha: "a".repeat(40),
        warnings: [], cancelRequested: false
      }] }),
      listReleases: vi.fn().mockResolvedValue({ releases: [] }),
      listFeedback: vi.fn().mockResolvedValue({ feedback: [] })
    } as unknown as ApiClient;

    renderPage(<OverviewPage api={api} />);
    await screen.findByText("生成中", { selector: "h2" });
    FakeEventSource.instance.listeners.get("build")?.({ data: JSON.stringify({ status: "ready" }) } as MessageEvent);

    expect(FakeEventSource.instance.close).toHaveBeenCalledTimes(1);
  });

  test("shows failed build details with a targeted retry command", async () => {
    const api = {
      getRepository: vi.fn().mockResolvedValue({ repository: {
        id: "repo", kind: "local", name: "Fixture", path: "/fixture", defaultBranch: "main"
      } }),
      listBuilds: vi.fn().mockResolvedValue({ builds: [{
        id: "failed-build", status: "failed", snapshotId: "new-snap", commitSha: "b".repeat(40),
        warnings: [], cancelRequested: false, errorMessage: "Provider rejected the request"
      }, {
        id: "published-build", status: "published", snapshotId: "old-snap", commitSha: "a".repeat(40),
        warnings: [], cancelRequested: false
      }] }),
      listReleases: vi.fn().mockResolvedValue({ releases: [{
        id: "release", buildId: "published-build", snapshotId: "old-snap", version: "1.0.0",
        createdAt: "2026-07-11", publishedAt: "2026-07-11"
      }] }),
      listFeedback: vi.fn().mockResolvedValue({ feedback: [] })
    } as unknown as ApiClient;

    renderPage(<OverviewPage api={api} />);

    expect(await screen.findByText("Provider rejected the request")).toBeVisible();
    expect(screen.getByRole("button", { name: "重试知识构建" })).toBeVisible();
    expect(screen.getByText("当前已发布版本未受影响。重试会创建新的候选构建，不会覆盖现有版本。")).toBeVisible();
  });

  test("explains safe next steps for empty knowledge, graph, and expired sessions", async () => {
    const emptyKnowledgeApi = {
      getRepositoryStatus: vi.fn().mockResolvedValue({ repository: null, latestSnapshot: null }),
      listReleases: vi.fn().mockResolvedValue({ releases: [] })
    } as unknown as ApiClient;
    localStorage.setItem("devkh:active-project-id", "project-1");
    renderPage(<KnowledgePage api={emptyKnowledgeApi} />);
    expect(await screen.findByText("尚未接入资料不会影响其他项目或已发布版本。"))
      .toBeVisible();
    expect(screen.getByRole("link", { name: "接入资料" })).toHaveAttribute("href", "/projects/project-1/sources");
    cleanup();

    const graphApi = {
      getProjectGraph: vi.fn().mockResolvedValue({ release: null, format: "tree", data: null })
    } as unknown as ApiClient;
    renderPageAt(<Routes><Route path="/projects/:projectId/graph" element={<ProjectGraphPage api={graphApi} />} /></Routes>, "/projects/project-1/graph");
    expect(await screen.findByText("尚未发布图谱不会影响现有资料或知识版本。"))
      .toBeVisible();
    cleanup();

    const expiredApi = {
      setupStatus: vi.fn().mockResolvedValue({ setupRequired: false }),
      session: vi.fn().mockRejectedValue(new ApiError(401, "SESSION_EXPIRED", "expired"))
    } as unknown as ApiClient;
    renderAppAt(expiredApi, "/projects");
    expect(await screen.findByText("会话已失效。资料、构建和已发布版本均未被修改；请重新登录后继续。"))
      .toBeVisible();
  });

  test("explores a published graph and reads its release-bound source citation", async () => {
    const user = userEvent.setup();
    const clipboard = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: clipboard } });
    const getProjectGraph = vi.fn().mockImplementation((_projectId: string, format = "json") => {
      if (format === "mermaid") return Promise.resolve({ release: { id: "release-1", version: "1.0.0" }, format, data: "flowchart TD\n  api[API]" });
      return Promise.resolve({
        release: { id: "release-1", version: "1.0.0" },
        format: "json",
        data: {
          nodes: [{
            id: "module-api", projectId: "project-1", snapshotId: "snapshot-1", kind: "module", name: "API", qualifiedName: "src/api.ts", candidate: false,
            sourceRefs: [{ snapshotId: "snapshot-1", path: "src/api.ts", startLine: 1, endLine: 2, blobHash: "a".repeat(40) }], attributes: {}
          }, {
            id: "symbol-client", projectId: "project-1", snapshotId: "snapshot-1", kind: "symbol", name: "Client", qualifiedName: "src/api.ts.Client", candidate: false,
            sourceRefs: [{ snapshotId: "snapshot-1", path: "src/api.ts", startLine: 3, endLine: 5, blobHash: "a".repeat(40) }], attributes: {}
          }],
          edges: [{ id: "contains-client", fromNodeId: "module-api", toNodeId: "symbol-client", kind: "contains", candidate: false, confidence: 1, sourceRefs: [] }]
        }
      });
    });
    const graphApi = {
      getProjectGraph,
      getSource: vi.fn().mockResolvedValue({
        path: "src/api.ts", startLine: 1, endLine: 2, commitSha: "b".repeat(40), blobHash: "a".repeat(40), content: "export const api = {};"
      })
    } as unknown as ApiClient;

    renderPageAt(<Routes><Route path="/projects/:projectId/graph" element={<ProjectGraphPage api={graphApi} />} /></Routes>, "/projects/project-1/graph");

    expect(await screen.findByRole("heading", { name: "知识图谱" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("当前筛选显示 2/2 个节点，1/1 条关系。");
    expect(document.querySelector(".knowledge-graph-explorer.is-compact")).not.toBeInTheDocument();
    const graphSearch = screen.getByRole("textbox", { name: "搜索图谱" });
    await user.type(graphSearch, "no-match");
    expect(screen.getByText("当前筛选条件下没有匹配的图谱节点。调整筛选或搜索条件后继续查看。")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("当前筛选显示 0/2 个节点，0/1 条关系。");
    expect(screen.getByRole("textbox", { name: "搜索图谱" })).toBeVisible();
    await user.clear(graphSearch);
    const apiNode = screen.getAllByRole("button", { name: "API 模块" }).find((button) => button.closest(".knowledge-graph-node-list"))!;
    await user.click(apiNode);
    expect(screen.getByRole("complementary", { name: "图谱详情" })).toHaveTextContent("知识版本1.0.0");
    expect(screen.getByRole("complementary", { name: "图谱详情" })).toHaveTextContent("关联");
    await user.click(screen.getByRole("button", { name: "src/api.ts 第 1 至 2 行" }));
    await user.click(screen.getByRole("button", { name: "复制 Mermaid" }));

    expect(await screen.findByRole("complementary", { name: "来源代码" })).toHaveTextContent("export const api");
    expect(screen.getByText("Mermaid 已复制到剪贴板。")).toBeVisible();
    expect(getProjectGraph).toHaveBeenCalledWith("project-1", "json");
    expect(getProjectGraph).toHaveBeenCalledWith("project-1", "mermaid", { releaseId: "release-1" });
    expect(clipboard).toHaveBeenCalledWith("flowchart TD\n  api[API]");
    expect(graphApi.getSource).toHaveBeenCalledWith({ path: "src/api.ts", startLine: 1, endLine: 2, releaseId: "release-1" });

    await user.type(graphSearch, "no-match");
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "来源代码" })).not.toBeInTheDocument());
    expect(screen.getByRole("complementary", { name: "图谱详情" })).toHaveTextContent("选择图谱节点");
  });

  test("keeps graph controls available for an empty published graph", async () => {
    const graphApi = {
      getProjectGraph: vi.fn().mockResolvedValue({ release: { id: "release-1", version: "1.0.0" }, format: "json", data: { nodes: [], edges: [] } })
    } as unknown as ApiClient;

    renderPageAt(<Routes><Route path="/projects/:projectId/graph" element={<ProjectGraphPage api={graphApi} />} /></Routes>, "/projects/project-1/graph");

    expect(await screen.findByRole("textbox", { name: "搜索图谱" })).toBeVisible();
    expect(screen.getByText("当前发布版本没有可展示的图谱节点。")).toBeVisible();
  });

  test("uses a compact graph canvas for one published node without relationships", async () => {
    const graphApi = {
      getProjectGraph: vi.fn().mockResolvedValue({
        release: { id: "release-1", version: "1.0.0" }, format: "json",
        data: { nodes: [{ id: "module-readme", projectId: "project-1", snapshotId: "snapshot-1", kind: "module", name: "README.md", qualifiedName: "README.md", candidate: false, sourceRefs: [], attributes: {} }], edges: [] }
      })
    } as unknown as ApiClient;

    renderPageAt(<Routes><Route path="/projects/:projectId/graph" element={<ProjectGraphPage api={graphApi} />} /></Routes>, "/projects/project-1/graph");

    expect(await screen.findByRole("heading", { name: "知识图谱" })).toBeVisible();
    expect(document.querySelector(".knowledge-graph-explorer.is-compact")).toBeInTheDocument();
  });

  test("shows a real graph request failure instead of an empty state", async () => {
    const graphApi = {
      getProjectGraph: vi.fn().mockRejectedValue(new ApiError(500, "GRAPH_UNAVAILABLE", "Graph read failed"))
    } as unknown as ApiClient;

    renderPageAt(<Routes><Route path="/projects/:projectId/graph" element={<ProjectGraphPage api={graphApi} />} /></Routes>, "/projects/project-1/graph");

    const dialog = await screen.findByRole("dialog", { name: "服务暂未完成本次操作" });
    expect(screen.getByRole("alert", { name: "知识图谱错误详情" })).toBeVisible();
    expect(within(dialog).getByText("数据安全")).toBeInTheDocument();
    expect(within(dialog).getByText("GRAPH_UNAVAILABLE")).toBeInTheDocument();
    expect(screen.queryByText("Graph read failed")).not.toBeInTheDocument();
  });

  test("ignores an older failure after the latest build is published", async () => {
    sessionStorage.setItem("devkh:last-snapshot", JSON.stringify({
      snapshotId: "current-snap", commitSha: "b".repeat(40), ref: "main", fileCount: 4, unchanged: true
    }));
    const repository = {
      id: "repo", projectId: "project", kind: "local" as const, name: "Fixture", path: "/fixture", defaultBranch: "main"
    };
    const builds = [{
      id: "published-build", status: "published" as const, snapshotId: "current-snap",
      commitSha: "b".repeat(40), warnings: [], cancelRequested: false
    }, {
      id: "failed-build", status: "failed" as const, snapshotId: "old-snap",
      commitSha: "a".repeat(40), warnings: [], cancelRequested: false,
      errorMessage: "Obsolete provider failure"
    }];
    const releases = [{
      id: "release", buildId: "published-build", snapshotId: "current-snap", version: "1.0.0",
      createdAt: "2026-07-11", publishedAt: "2026-07-11"
    }];
    expect(derivePrimaryAction({ repository, builds, releases, snapshotId: "current-snap" })).toEqual({
      kind: "sync", label: "同步仓库"
    });
    const api = {
      getRepository: vi.fn().mockResolvedValue({ repository }),
      listBuilds: vi.fn().mockResolvedValue({ builds }),
      listReleases: vi.fn().mockResolvedValue({ releases }),
      listFeedback: vi.fn().mockResolvedValue({ feedback: [] })
    } as unknown as ApiClient;

    renderPage(<OverviewPage api={api} />);

    expect(await screen.findByRole("button", { name: "同步仓库" })).toBeVisible();
    expect(screen.queryByText("Obsolete provider failure")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试知识构建" })).not.toBeInTheDocument();
  });
});

describe("knowledge citations", () => {
  test("loads an exact requested release that is outside the current release page", async () => {
    const listKnowledgePages = vi.fn().mockResolvedValue({
      pages: [], total: 0, nextOffset: null
    });
    const getRelease = vi.fn().mockResolvedValue({ release: {
      id: "release-old", buildId: "build-old", snapshotId: "snapshot-old",
      commitSha: "a".repeat(40), version: "0.1.0", createdAt: "2026-01-01",
      publishedAt: "2026-01-01"
    } });
    const api = {
      getRepositoryStatus: vi.fn().mockResolvedValue({ repository: { id: "repo" }, latestSnapshot: null }),
      listReleases: vi.fn().mockResolvedValue({
        releases: [{
          id: "release-new", buildId: "build-new", snapshotId: "snapshot-new",
          commitSha: "b".repeat(40), version: "2.0.0", createdAt: "2026-07-11",
          publishedAt: "2026-07-11"
        }],
        total: 101,
        nextOffset: 100
      }),
      getRelease,
      listKnowledgePages,
      getKnowledgeMetadata: vi.fn().mockResolvedValue({ symbols: [], dependencies: [] })
    } as unknown as ApiClient;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    });

    render(<QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/knowledge?releaseId=release-old"]}>
        <KnowledgePage api={api} />
      </MemoryRouter>
    </QueryClientProvider>);

    expect(await screen.findByText("版本 0.1.0")).toBeVisible();
    expect(getRelease).toHaveBeenCalledWith("release-old");
    expect(listKnowledgePages).toHaveBeenCalledWith("release-old", { limit: 100, offset: 0 });
    expect(screen.queryByText("版本 2.0.0")).not.toBeInTheDocument();
  });

  test("retries a transient exact requested release error", async () => {
    const user = userEvent.setup();
    const getRelease = vi.fn()
      .mockRejectedValueOnce(new Error("Exact release temporarily unavailable"))
      .mockResolvedValueOnce({ release: {
        id: "release-old", buildId: "build-old", snapshotId: "snapshot-old",
        commitSha: "a".repeat(40), version: "0.1.0", createdAt: "2026-01-01",
        publishedAt: "2026-01-01"
      } });
    const listKnowledgePages = vi.fn().mockResolvedValue({
      pages: [], total: 0, nextOffset: null
    });
    const api = {
      getRepositoryStatus: vi.fn().mockResolvedValue({ repository: { id: "repo" }, latestSnapshot: null }),
      listReleases: vi.fn().mockResolvedValue({
        releases: [{
          id: "release-new", buildId: "build-new", snapshotId: "snapshot-new",
          commitSha: "b".repeat(40), version: "2.0.0", createdAt: "2026-07-11",
          publishedAt: "2026-07-11"
        }],
        total: 101,
        nextOffset: 100
      }),
      getRelease,
      listKnowledgePages,
      getKnowledgeMetadata: vi.fn().mockResolvedValue({ symbols: [], dependencies: [] })
    } as unknown as ApiClient;

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    });
    render(<QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/knowledge?releaseId=release-old"]}>
        <KnowledgePage api={api} />
      </MemoryRouter>
    </QueryClientProvider>);

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("Exact release temporarily unavailable");
    await user.click(within(error).getByRole("button", { name: "重试" }));

    expect(await screen.findByText("版本 0.1.0")).toBeVisible();
    expect(getRelease).toHaveBeenCalledTimes(2);
    expect(listKnowledgePages).toHaveBeenCalledWith("release-old", { limit: 100, offset: 0 });
  });

  test("opens the exact cited source range and identifiers", async () => {
    const user = userEvent.setup();
    const api = {
      getRepositoryStatus: vi.fn().mockResolvedValue({ repository: { id: "repo", kind: "local", name: "Fixture", path: "/fixture", defaultBranch: "main" }, latestSnapshot: { id: "snapshot-1", commitSha: "a".repeat(40), ref: "main", commitTimestamp: "2026-07-11" } }),
      listReleases: vi.fn().mockResolvedValue({ releases: [{ id: "release-1", buildId: "build-1", snapshotId: "snapshot-1", version: "1.0.0", createdAt: "2026-07-11", publishedAt: "2026-07-11" }] }),
      getKnowledgeMetadata: vi.fn().mockResolvedValue({ symbols: [], dependencies: [] }),
      listKnowledgePages: vi.fn().mockResolvedValue({ pages: [{
        id: "page-1", slug: "module-math", title: "模块：math", body: "数学模块。", chunks: [{
          id: "chunk-1", heading: "add", content: "Adds numbers.", citations: [{
            path: "src/math.ts", startLine: 16, endLine: 18,
            commitSha: "a".repeat(40), blobHash: "b".repeat(64)
          }]
        }]
      }] }),
      getKnowledgePage: vi.fn().mockResolvedValue({ page: {
        id: "page-1", slug: "module-math", title: "模块：math", body: "数学模块。", chunks: [{
          id: "chunk-1", heading: "add", content: "Adds numbers.", citations: [{
            path: "src/math.ts", startLine: 16, endLine: 18,
            commitSha: "a".repeat(40), blobHash: "b".repeat(64)
          }]
        }]
      } }),
      getSource: vi.fn().mockResolvedValue({
        path: "src/math.ts", startLine: 16, endLine: 18, commitSha: "a".repeat(40),
        blobHash: "b".repeat(64), content: "export function add(a: number, b: number) {\n  return a + b;\n}"
      })
    } as unknown as ApiClient;

    renderPage(<KnowledgePage api={api} />);
    await user.click(await screen.findByRole("button", { name: "模块：math" }));
    await user.click(await screen.findByRole("button", { name: /src\/math.ts 第 16 至 18 行/i }));

    expect(api.getSource).toHaveBeenCalledWith({ path: "src/math.ts", startLine: 16, endLine: 18, releaseId: "release-1" });
    expect(await screen.findByText(/export function add/)).toBeVisible();
    expect(api.getKnowledgeMetadata).not.toHaveBeenCalled();
    expect(screen.getByText(`Commit ${"a".repeat(12)}`)).toBeVisible();
    expect(screen.getByText(`Blob ${"b".repeat(12)}`)).toBeVisible();
  });

  test("renders release errors without falling through to unpublished or empty", async () => {
    const api = {
      getRepositoryStatus: vi.fn().mockResolvedValue({ repository: { id: "repo" }, latestSnapshot: null }),
      listReleases: vi.fn().mockRejectedValue(new Error("Release catalog unavailable"))
    } as unknown as ApiClient;

    renderPage(<KnowledgePage api={api} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Release catalog unavailable");
    expect(screen.queryByText(/publish a release to browse/i)).not.toBeInTheDocument();
  });

  test("distinguishes unpublished and stale release states", async () => {
    const api = {
      getRepositoryStatus: vi.fn().mockResolvedValue({
        repository: { id: "repo" },
        latestSnapshot: { id: "snapshot-new", commitSha: "b".repeat(40), ref: "main", commitTimestamp: "2026-07-11" }
      }),
      listReleases: vi.fn().mockResolvedValue({ releases: [{
        id: "release-1", buildId: "build-1", snapshotId: "snapshot-old", commitSha: "a".repeat(40),
        version: "1.0.0", createdAt: "2026-07-11", publishedAt: null
      }] }),
      listKnowledgePages: vi.fn().mockResolvedValue({ pages: [] }),
      getKnowledgeMetadata: vi.fn().mockResolvedValue({ symbols: [], dependencies: [] })
    } as unknown as ApiClient;

    renderPage(<KnowledgePage api={api} />);

    expect(await screen.findByText("未发布草稿")).toBeVisible();
    expect(screen.getByText("有更新的仓库快照可用。")).toBeVisible();
    expect(screen.getByText(`${"a".repeat(12)} → ${"b".repeat(12)}`)).toBeVisible();
  });

  test("keeps a persistent review bar on draft knowledge and publishes from project context", async () => {
    const user = userEvent.setup();
    const publishRelease = vi.fn().mockResolvedValue({ release: {
      id: "release-1", buildId: "build-1", snapshotId: "snapshot-old", version: "1.0.0",
      createdAt: "2026-07-11", publishedAt: "2026-07-22"
    } });
    const api = {
      getRepositoryStatus: vi.fn().mockResolvedValue({
        repository: { id: "repo" },
        latestSnapshot: { id: "snapshot-old", commitSha: "a".repeat(40), ref: "main", commitTimestamp: "2026-07-11" }
      }),
      listReleases: vi.fn().mockResolvedValue({ releases: [{
        id: "release-1", buildId: "build-1", snapshotId: "snapshot-old", commitSha: "a".repeat(40),
        version: "1.0.0", createdAt: "2026-07-11", publishedAt: null
      }] }),
      listKnowledgePages: vi.fn().mockResolvedValue({ pages: [] }),
      searchKnowledge: vi.fn().mockResolvedValue({ results: [] }),
      publishRelease
    } as unknown as ApiClient;

    renderPageAt(<Routes>
      <Route path="/projects/:projectId/knowledge/pages" element={<KnowledgePage api={api} />} />
    </Routes>, "/projects/project-1/knowledge/pages?releaseId=release-1");

    const reviewBar = await screen.findByRole("region", { name: "草稿审核" });
    expect(within(reviewBar).getByText("版本 1.0.0 · 未发布")).toBeVisible();
    expect(within(reviewBar).getByRole("link", { name: "返回知识生产" })).toHaveAttribute("href", "/projects/project-1/production");
    await user.click(within(reviewBar).getByRole("button", { name: "发布版本" }));
    await waitFor(() => expect(publishRelease).toHaveBeenCalledWith("release-1"));
    const publishedStatus = await screen.findByRole("status");
    expect(publishedStatus).toHaveTextContent("版本已发布");
    expect(publishedStatus).toHaveFocus();
    expect(screen.queryByRole("region", { name: "草稿审核" })).not.toBeInTheDocument();
  });

  test("does not offer draft publication to read-only project members", async () => {
    const api = {
      getRepositoryStatus: vi.fn().mockResolvedValue({
        repository: { id: "repo" },
        latestSnapshot: { id: "snapshot-old", commitSha: "a".repeat(40), ref: "main", commitTimestamp: "2026-07-11" }
      }),
      listReleases: vi.fn().mockResolvedValue({ releases: [{
        id: "release-1", buildId: "build-1", snapshotId: "snapshot-old", commitSha: "a".repeat(40),
        version: "1.0.0", createdAt: "2026-07-11", publishedAt: null
      }] }),
      listKnowledgePages: vi.fn().mockResolvedValue({ pages: [] }),
      session: vi.fn().mockResolvedValue({ admin: { id: "reader-1", role: "reader" } }),
      listProjectMembers: vi.fn().mockResolvedValue({ members: [{ id: "reader-1", role: "reader" }] })
    } as unknown as ApiClient;

    renderPageAt(<Routes>
      <Route path="/projects/:projectId/knowledge/pages" element={<KnowledgePage api={api} />} />
    </Routes>, "/projects/project-1/knowledge/pages?releaseId=release-1");

    expect(await screen.findByRole("region", { name: "草稿审核" })).toBeVisible();
    await waitFor(() => expect(api.listProjectMembers).toHaveBeenCalledWith("project-1"));
    expect(screen.queryByRole("button", { name: "发布版本" })).not.toBeInTheDocument();
  });

  test("displays backend symbol and dependency metadata only on the quality page", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const api = {
      getRepositoryStatus: vi.fn().mockResolvedValue({ repository: { id: "repo" }, latestSnapshot: { id: "snap", commitSha: "a".repeat(40), ref: "main", commitTimestamp: "2026-07-11" } }),
      listReleases: vi.fn().mockResolvedValue({ releases: [{ id: "release-1", buildId: "build-1", snapshotId: "snap", commitSha: "a".repeat(40), version: "1.0.0", createdAt: "2026-07-11", publishedAt: "2026-07-11" }] }),
      listKnowledgePages: vi.fn().mockResolvedValue({ pages: [] }),
      getKnowledgeMetadata: vi.fn().mockResolvedValue({
        symbols: [{ name: "add", kind: "function", path: "src/math.ts", startLine: 16, endLine: 18, exported: true }],
        dependencies: [
          { source: "math", target: "util", kind: "imports", path: "src/math.ts", startLine: 1, endLine: 1 },
          { source: "math", target: "util", kind: "module-dependency", path: "src/math.ts", startLine: 1, endLine: 1 }
        ]
      }),
      getProjectKnowledgeQuality: vi.fn().mockResolvedValue({
        repository: { id: "repo" }, latestSnapshot: null, currentRelease: null, latestBuild: null,
        pendingFeedbackCount: 0, indexedTextBytes: 1024,
        knowledge: { pageCount: 12, chunkCount: 24, citationCount: 36 },
        remediation: { open: 0, accepted: 0, rebuilding: 0, resolved: 0, dismissed: 0 },
        qualityPipeline: null, assessment: null, change: null, diagnostics: [{ code: "PUBLISHED" }]
      }),
      listProjectRemediations: vi.fn().mockResolvedValue({ remediations: [] })
    } as unknown as ApiClient;

    renderPage(<ProjectKnowledgeQualityPage api={api} projectId="project-1" />);

    expect(await screen.findByText("add")).toBeVisible();
    expect(screen.getByText("function")).toBeVisible();
    expect(screen.getByTitle("src/math.ts:16-18")).toBeVisible();
    expect(screen.getAllByText("math → util")).toHaveLength(2);
    expect(screen.getByText("imports")).toBeVisible();
    expect(screen.getAllByTitle("src/math.ts:1")).toHaveLength(2);
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key");
    consoleError.mockRestore();
  });

  test("filters quality governance issues and shows the selected source context", async () => {
    const user = userEvent.setup();
    const remediation = {
      id: "remediation-1", projectId: "project-1", repositoryId: "repo", sourceBuildId: "build-1",
      issue: {
        id: "issue-1", buildId: "build-1", rule: "KNOWLEDGE_LOW_COVERAGE", severity: "warning",
        targetKind: "knowledge", targetId: "module:payments", message: "模块文档覆盖不足",
        sourceRefs: [{ snapshotId: "snapshot-1", path: "src/payments.ts", startLine: 12, endLine: 24, blobHash: "b".repeat(64) }],
        remediationState: "open"
      },
      state: "open", rebuildBuildId: null,
      createdAt: "2026-07-16T00:00:00Z", updatedAt: "2026-07-16T00:00:00Z"
    };
    const acceptedRemediation = { ...remediation, state: "accepted" as const };
    const rebuildingRemediation = { ...remediation, state: "rebuilding" as const, rebuildBuildId: "remediation-build" };
    const listProjectRemediations = vi.fn().mockResolvedValue({ remediations: [remediation] });
    const transitionProjectRemediation = vi.fn().mockImplementation(async (_projectId: string, _remediationId: string, input: { state: string }) => {
      if (input.state === "accepted") listProjectRemediations.mockResolvedValue({ remediations: [acceptedRemediation] });
      return { remediation: { id: "remediation-1", state: input.state } };
    });
    const requestProjectRemediationRebuild = vi.fn().mockImplementation(async () => {
      listProjectRemediations.mockResolvedValue({ remediations: [rebuildingRemediation] });
      return { build: { id: "remediation-build" }, created: true };
    });
    const api = {
      getRepositoryStatus: vi.fn().mockResolvedValue({
        repository: { id: "repo" },
        latestSnapshot: { id: "snapshot-1", commitSha: "a".repeat(40), ref: "main", commitTimestamp: "2026-07-16" }
      }),
      listReleases: vi.fn().mockResolvedValue({ releases: [{
        id: "release-1", buildId: "build-1", snapshotId: "snapshot-1", version: "1.0.0",
        createdAt: "2026-07-16", publishedAt: "2026-07-16"
      }] }),
      getKnowledgeMetadata: vi.fn().mockResolvedValue({ symbols: [], dependencies: [] }),
      listKnowledgePages: vi.fn().mockResolvedValue({ pages: [] }),
      session: vi.fn().mockResolvedValue({ admin: { id: "admin-1", email: "admin@example.com", role: "admin" } }),
      listProjectMembers: vi.fn().mockResolvedValue({ members: [{ id: "admin-1", email: "admin@example.com", role: "admin" }] }),
      getProjectKnowledgeQuality: vi.fn().mockResolvedValue({
        repository: { id: "repo" }, latestSnapshot: null, currentRelease: null, latestBuild: null,
        pendingFeedbackCount: 0, indexedTextBytes: 0,
        knowledge: { pageCount: 0, chunkCount: 0, citationCount: 0 },
        remediation: { open: 1, accepted: 0, rebuilding: 0, resolved: 0, dismissed: 0 },
        qualityPipeline: null,
        assessment: { trust: { targetKind: "knowledge", targetId: "module:payments", score: 0.8, citationScore: 1, parserScore: 1, freshnessScore: 1, lintPenalty: 0, reasons: ["引用完整"] }, issueTotal: 1, issues: [] },
        change: null, diagnostics: [{ code: "PUBLISHED" }]
      }),
      listProjectRemediations,
      transitionProjectRemediation,
      requestProjectRemediationRebuild
    } as unknown as ApiClient;
    localStorage.setItem("devkh:active-project-id", "project-1");

    renderPage(<ProjectKnowledgeQualityPage api={api} projectId="project-1" />);

    const governance = await screen.findByRole("region", { name: "质量治理" });
    expect(await within(governance).findByText("模块文档覆盖不足")).toBeVisible();
    await user.selectOptions(within(governance).getByLabelText("严重度"), "warning");
    await waitFor(() => expect(listProjectRemediations).toHaveBeenLastCalledWith("project-1", {
      limit: 50, offset: 0, severity: "warning"
    }));
    await user.type(within(governance).getByLabelText("规则"), "KNOWLEDGE_LOW_COVERAGE");
    await waitFor(() => expect(listProjectRemediations).toHaveBeenLastCalledWith("project-1", {
      limit: 50, offset: 0, severity: "warning", rule: "KNOWLEDGE_LOW_COVERAGE"
    }));
    await user.click(within(governance).getByRole("button", { name: /模块文档覆盖不足/ }));
    expect(within(governance).getByText("src/payments.ts:12-24")).toBeVisible();
    expect(within(governance).getByText("build-1")).toBeVisible();
    expect(within(governance).getByText("引用完整")).toBeVisible();
    expect(within(governance).getByText("下一步：接受处理或说明忽略")).toBeVisible();
    const actions = await within(governance).findByRole("group", { name: "质量问题操作" });
    await user.click(within(actions).getByRole("button", { name: "忽略" }));
    const dismissalReason = within(actions).getByLabelText("忽略理由");
    expect(within(actions).getByRole("button", { name: "确认忽略" })).toBeDisabled();
    await user.type(dismissalReason, "该规则不适用于当前项目");
    await user.click(within(actions).getByRole("button", { name: "确认忽略" }));
    await waitFor(() => expect(api.transitionProjectRemediation).toHaveBeenCalledWith(
      "project-1", "remediation-1", { state: "dismissed", reason: "该规则不适用于当前项目" }
    ));
    await user.click(within(actions).getByRole("button", { name: "接受处理" }));
    await waitFor(() => expect(api.transitionProjectRemediation).toHaveBeenLastCalledWith(
      "project-1", "remediation-1", { state: "accepted" }
    ));
    expect(await within(governance).findByText("下一步：请求范围重建")).toBeVisible();
    await user.click(await within(governance).findByRole("button", { name: "请求范围重建" }));
    await waitFor(() => expect(api.requestProjectRemediationRebuild).toHaveBeenCalledWith("project-1", "remediation-1"));
    expect(await within(governance).findByLabelText("当前操作指引")).toHaveTextContent("候选仍在生成，当前已发布版本不会变化。");
    await user.click(await within(governance).findByRole("button", { name: "标记已解决" }));
    await waitFor(() => expect(api.transitionProjectRemediation).toHaveBeenLastCalledWith(
      "project-1", "remediation-1", { state: "resolved" }
    ));
  });
});

describe("feedback workflow", () => {
  test("reuses the paginated feedback cache when navigating from Overview", async () => {
    const user = userEvent.setup();
    const feedback = [{
      id: "f1", releaseId: "r1", query: "Cached gap", reason: "Missing context",
      expected: null, status: "open" as const, rebuildBuildId: null, citations: [],
      createdAt: "2026-07-11T00:00:00Z", updatedAt: "2026-07-11T00:00:00Z"
    }];
    const api = {
      getRepository: vi.fn().mockResolvedValue({ repository: {
        id: "repo", kind: "local", name: "Fixture", path: "/fixture", defaultBranch: "main"
      } }),
      listBuilds: vi.fn().mockResolvedValue({ builds: [], total: 0, nextOffset: null }),
      listReleases: vi.fn().mockResolvedValue({ releases: [], total: 0, nextOffset: null }),
      listFeedback: vi.fn().mockResolvedValue({ feedback, total: 1, nextOffset: null })
    } as unknown as ApiClient;
    function NavigateToFeedback() {
      const navigate = useNavigate();
      return <button onClick={() => navigate("/feedback")}>Open feedback route</button>;
    }
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    });
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/"]}>
      <NavigateToFeedback />
      <Routes>
        <Route path="/" element={<OverviewPage api={api} />} />
        <Route path="/feedback" element={<FeedbackPage api={api} />} />
      </Routes>
    </MemoryRouter></QueryClientProvider>);

    await screen.findByText("人工待处理项");
    await user.click(screen.getByRole("button", { name: "Open feedback route" }));

    expect(await screen.findByRole("button", { name: "Cached gap" })).toBeVisible();
  });

  test("exposes only valid transitions and refreshes after acknowledgement", async () => {
    const user = userEvent.setup();
    const listFeedback = vi.fn()
      .mockResolvedValueOnce({ feedback: [{
        id: "f1", releaseId: "r1", query: "How do I deploy?", reason: "Missing runbook",
        expected: "Commands", status: "open", rebuildBuildId: null, citations: [],
        createdAt: "2026-07-11T00:00:00Z", updatedAt: "2026-07-11T00:00:00Z"
      }] })
      .mockResolvedValue({ feedback: [{
        id: "f1", releaseId: "r1", query: "How do I deploy?", reason: "Missing runbook",
        expected: "Commands", status: "acknowledged", rebuildBuildId: null, citations: [],
        createdAt: "2026-07-11T00:00:00Z", updatedAt: "2026-07-11T00:01:00Z"
      }] });
    const transitionFeedback = vi.fn().mockResolvedValue({ feedback: { id: "f1" } });
    const api = { listFeedback, transitionFeedback } as unknown as ApiClient;

    renderPage(<FeedbackPage api={api} />);
    await user.click(await screen.findByRole("button", { name: /how do i deploy/i }));
    const actions = screen.getByRole("group", { name: "反馈操作" });
    expect(within(actions).getByRole("button", { name: "确认处理" })).toBeVisible();
    expect(within(actions).queryByRole("button", { name: "标记为已修复" })).not.toBeInTheDocument();
    await user.click(within(actions).getByRole("button", { name: "确认处理" }));

    await waitFor(() => expect(transitionFeedback).toHaveBeenCalledWith("f1", "acknowledged"));
    expect(await screen.findByRole("button", { name: "请求重新构建" })).toBeVisible();
    expect(screen.getByRole("button", { name: "标记为已修复" })).toBeVisible();
  });

  test("opens a persisted feedback citation as an exact source excerpt", async () => {
    const user = userEvent.setup();
    const citation = {
      path: "src/math.ts", startLine: 16, endLine: 18,
      commitSha: "a".repeat(40), blobHash: "b".repeat(64)
    };
    const getSource = vi.fn().mockResolvedValue({
      ...citation, content: "export function add() {}"
    });
    const api = {
      listFeedback: vi.fn().mockResolvedValue({ feedback: [{
        id: "f1", releaseId: "r1", query: "add", reason: "Needs examples",
        expected: "Example", status: "open", rebuildBuildId: null, citations: [citation],
        createdAt: "2026-07-11T00:00:00Z", updatedAt: "2026-07-11T00:00:00Z"
      }] }),
      getSource
    } as unknown as ApiClient;

    renderPage(<FeedbackPage api={api} />);
    await user.click(await screen.findByRole("button", { name: "add" }));
    await user.click(screen.getByRole("button", { name: /src\/math.ts 第 16 至 18 行/i }));

    expect(getSource).toHaveBeenCalledWith({
      path: "src/math.ts", startLine: 16, endLine: 18, releaseId: "r1"
    });
    expect(await screen.findByText("export function add() {}" )).toBeVisible();
  });

  test("closes citations across feedback and filter changes without mixing releases", async () => {
    const user = userEvent.setup();
    const firstCitation = {
      path: "src/first.ts", startLine: 2, endLine: 4,
      commitSha: "a".repeat(40), blobHash: "b".repeat(64)
    };
    const secondCitation = {
      path: "src/second.ts", startLine: 8, endLine: 9,
      commitSha: "c".repeat(40), blobHash: "d".repeat(64)
    };
    const feedback = [{
      id: "f1", releaseId: "r1", query: "First gap", reason: "First reason",
      expected: null, status: "open" as const, rebuildBuildId: null, citations: [firstCitation],
      createdAt: "2026-07-11T00:00:00Z", updatedAt: "2026-07-11T00:00:00Z"
    }, {
      id: "f2", releaseId: "r2", query: "Second gap", reason: "Second reason",
      expected: null, status: "acknowledged" as const, rebuildBuildId: null, citations: [secondCitation],
      createdAt: "2026-07-11T00:00:00Z", updatedAt: "2026-07-11T00:00:00Z"
    }];
    const getSource = vi.fn(async ({ releaseId, path }: { releaseId?: string; path: string }) => ({
      ...(path === firstCitation.path ? firstCitation : secondCitation),
      content: `${releaseId}:${path}`
    }));
    const api = {
      listFeedback: vi.fn(async (status?: string) => ({
        feedback: status ? feedback.filter((item) => item.status === status) : feedback
      })),
      getSource
    } as unknown as ApiClient;

    renderPage(<FeedbackPage api={api} />);
    await user.click(await screen.findByRole("button", { name: "First gap" }));
    await user.click(screen.getByRole("button", { name: /src\/first.ts 第 2 至 4 行/i }));
    expect(await screen.findByText("r1:src/first.ts")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Second gap" }));
    expect(screen.queryByRole("complementary", { name: "反馈来源代码" })).not.toBeInTheDocument();
    expect(getSource).not.toHaveBeenCalledWith(expect.objectContaining({
      releaseId: "r2", path: "src/first.ts"
    }));

    await user.click(screen.getByRole("button", { name: /src\/second.ts 第 8 至 9 行/i }));
    expect(await screen.findByText("r2:src/second.ts")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "关闭反馈来源代码" }));
    expect(screen.queryByRole("complementary", { name: "反馈来源代码" })).not.toBeInTheDocument();
    expect(getSource).not.toHaveBeenCalledWith(expect.objectContaining({
      releaseId: "r1", path: "src/second.ts"
    }));
  });
});

describe("repository replacement", () => {
  test("configures every source inline and only submits the selected source", async () => {
    const user = userEvent.setup();
    const connectRepository = vi.fn().mockResolvedValue({ repository: {
      id: "git", projectId: "project", kind: "git", name: "项目仓库", url: "https://github.com/acme/web.git", defaultBranch: "main"
    } });
    const api = {
      getRepository: vi.fn().mockResolvedValue({ repository: null }),
      listImportReports: vi.fn().mockResolvedValue({ reports: [], total: 0, limit: 20, offset: 0 }),
      connectRepository
    } as unknown as ApiClient;

    renderPage(<ProjectImportsPage api={api} projectId="project" />);

    await user.click((await screen.findByRole("radio", { name: "Git HTTPS" })).closest("label")!);
    expect(connectRepository).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("HTTPS URL"), "https://github.com/acme/web.git");
    await user.click(screen.getByRole("button", { name: "连接 Git 仓库" }));
    await waitFor(() => expect(connectRepository).toHaveBeenCalledWith({
      kind: "git", name: "项目仓库", url: "https://github.com/acme/web.git"
    }));
    expect(screen.queryByRole("dialog", { name: "更换资料来源" })).not.toBeInTheDocument();
  });

  test("replaces a connected source inline and preserves the read-only history contract", async () => {
    const user = userEvent.setup();
    const invalidateQueries = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const replaceRepository = vi.fn().mockResolvedValue({ repository: {
      id: "replacement", projectId: "project", kind: "local", name: "Current repository", path: "/srv/projects/current", defaultBranch: "local"
    } });
    const api = {
      getRepository: vi.fn().mockResolvedValue({ repository: {
        id: "repo", projectId: "project", kind: "git", name: "Current repository",
        url: "https://github.com/example/current.git", hasCredential: false, defaultBranch: "main"
      } }),
      getModelConfig: vi.fn().mockResolvedValue({ config: null }),
      getMcpConnection: vi.fn().mockResolvedValue({
        endpoint: "/mcp", transport: "streamable-http", authorization: "bearer", tools: []
      }),
      listMcpTokens: vi.fn().mockResolvedValue({ tokens: [] }),
      listArchivedRepositories: vi.fn().mockResolvedValue({ repositories: [] }),
      listImportReports: vi.fn().mockResolvedValue({ reports: [], total: 0, limit: 20, offset: 0 }),
      replaceRepository
    } as unknown as ApiClient;

    renderPage(<ProjectImportsPage api={api} projectId="project" />);

    expect(await screen.findByLabelText("Git HTTPS")).toBeChecked();
    await user.click((await screen.findByRole("radio", { name: "服务器路径" })).closest("label")!);
    await user.type(screen.getByLabelText("服务器绝对路径"), "/srv/projects/current");
    await user.click(screen.getByRole("button", { name: "连接服务器目录" }));
    await waitFor(() => expect(replaceRepository).toHaveBeenCalledWith({
      kind: "local", name: "Current repository", path: "/srv/projects/current"
    }));
    expect(api.getRepository).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["import-reports", "project"] });
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(screen.getByText("旧来源和已发布知识会保留为只读历史，新来源不会自动发布。")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "更换资料来源" })).not.toBeInTheDocument();
  });

  test("uses the replacement upload path after folder confirmation", async () => {
    const user = userEvent.setup();
    const replaceRepository = vi.fn().mockResolvedValue({ repository: {
      id: "replacement-upload", projectId: "project", kind: "upload", name: "Current repository", defaultBranch: "upload"
    }, pendingUpload: true });
    const uploadReplacementFolder = vi.fn().mockResolvedValue({
      snapshotId: "replacement-snapshot", sourceVersion: "c".repeat(40), fileCount: 1, textBytes: 10,
      unchanged: false, ignored: { total: 0, reasons: {} }, assetCount: 0
    });
    const api = {
      getRepository: vi.fn().mockResolvedValue({ repository: {
        id: "repo", projectId: "project", kind: "git", name: "Current repository",
        url: "https://github.com/example/current.git", hasCredential: false, defaultBranch: "main"
      } }),
      listImportReports: vi.fn().mockResolvedValue({ reports: [], total: 0, limit: 20, offset: 0 }),
      replaceRepository,
      uploadReplacementFolder
    } as unknown as ApiClient;

    renderPage(<ProjectImportsPage api={api} projectId="project" />);
    const uploadInput = await screen.findByLabelText("项目文件夹", { selector: 'input[type="file"]' }) as HTMLInputElement;
    await user.upload(uploadInput, new File(["export {};"], "main.ts", { type: "text/typescript" }));
    expect(replaceRepository).not.toHaveBeenCalled();
    expect(uploadReplacementFolder).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "确认并开始上传" }));

    await waitFor(() => expect(replaceRepository).toHaveBeenCalledWith({ kind: "upload", name: "Current repository" }));
    await waitFor(() => expect(uploadReplacementFolder).toHaveBeenCalledWith(
      "project", "replacement-upload", [expect.objectContaining({ path: "main.ts", kind: "source" })],
      { onProgress: expect.any(Function) }
    ));
  });

  test("records an uploaded snapshot so Overview can start a build", async () => {
    const user = userEvent.setup();
    const startBuild = vi.fn();
    const createRelease = vi.fn();
    const publishRelease = vi.fn();
    const api = {
      getRepository: vi.fn().mockRejectedValue(new ApiError(404, "REPOSITORY_NOT_FOUND", "missing")),
      connectRepository: vi.fn().mockResolvedValue({ repository: {
        id: "upload", projectId: "project", kind: "upload", name: "Uploaded project", defaultBranch: "upload"
      } }),
      uploadFolder: vi.fn().mockResolvedValue({
        snapshotId: "snapshot", sourceVersion: "a".repeat(40), fileCount: 1, textBytes: 10, unchanged: false,
        ignored: { total: 0, reasons: {} }, assetCount: 0
      }),
      getModelConfig: vi.fn().mockResolvedValue({ config: null }),
      getMcpConnection: vi.fn().mockResolvedValue({ endpoint: "/mcp", transport: "streamable-http", authorization: "bearer", tools: [] }),
      listMcpTokens: vi.fn().mockResolvedValue({ tokens: [] }),
      startBuild,
      createRelease,
      publishRelease
    } as unknown as ApiClient;

    renderPage(<ProjectImportsPage api={api} projectId="project" />);
    const projectFile = new File(["export {};"], "main.ts", { type: "text/typescript" });
    const secretFile = new File(["TOKEN=secret"], ".env", { type: "text/plain" });
    const uploadInput = await screen.findByLabelText("项目文件夹", { selector: 'input[type="file"]' }) as HTMLInputElement;
    await user.upload(uploadInput, [projectFile, secretFile]);
    await user.click(await screen.findByRole("button", { name: "确认并开始上传" }));

    await waitFor(() => expect(api.uploadFolder).toHaveBeenCalledWith(
      "project", "upload", [expect.objectContaining({ path: "main.ts", kind: "source" })],
      { onProgress: expect.any(Function) }
    ));
    await waitFor(() => expect(sessionStorage.getItem("devkh:last-snapshot")).toContain("snapshot"));
    expect(await screen.findByText("本地预过滤 1 个文件")).toBeVisible();
    expect(screen.getByText("服务端二次过滤 0 个文件")).toBeVisible();
    expect(startBuild).not.toHaveBeenCalled();
    expect(createRelease).not.toHaveBeenCalled();
    expect(publishRelease).not.toHaveBeenCalled();
  });

  test("reuses a newly connected upload repository when the first transfer is interrupted", async () => {
    const user = userEvent.setup();
    const connectRepository = vi.fn().mockResolvedValue({ repository: {
      id: "upload-resume", projectId: "project", kind: "upload", name: "Uploaded project", defaultBranch: "upload"
    } });
    const uploadFolder = vi.fn()
      .mockRejectedValueOnce(new ApiError(500, "TEMPORARY", "interrupted"))
      .mockRejectedValueOnce(new ApiError(409, "UPLOAD_SESSION_INVALIDATED", "invalidated"))
      .mockResolvedValue({
        snapshotId: "snapshot-resume", sourceVersion: "b".repeat(40), fileCount: 1, textBytes: 10,
        unchanged: false, ignored: { total: 0, reasons: {} }, assetCount: 0
      });
    const api = {
      getRepository: vi.fn().mockRejectedValue(new ApiError(404, "REPOSITORY_NOT_FOUND", "missing")),
      connectRepository,
      uploadFolder,
      listImportReports: vi.fn().mockResolvedValue({ reports: [], total: 0, limit: 20, offset: 0 })
    } as unknown as ApiClient;

    renderPage(<ProjectImportsPage api={api} projectId="project" />);
    const uploadInput = await screen.findByLabelText("项目文件夹", { selector: 'input[type="file"]' }) as HTMLInputElement;
    await user.upload(uploadInput, new File(["export {};"], "main.ts", { type: "text/typescript" }));
    const confirm = await screen.findByRole("button", { name: "确认并开始上传" });
    await user.click(confirm);
    await waitFor(() => expect(uploadFolder).toHaveBeenCalledTimes(1));
    const dialog = await screen.findByRole("dialog", { name: "上传提交暂未完成" });
    expect(screen.getByRole("alert", { name: "资料接入错误详情" })).toBeVisible();
    expect(within(dialog).getByText("数据安全")).toBeInTheDocument();
    expect(within(dialog).getByText("TEMPORARY")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "安全重试" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "安全重试" }));
    await waitFor(() => expect(uploadFolder).toHaveBeenCalledTimes(2));
    const terminalDialog = await screen.findByRole("dialog", { name: "上传会话已失效" });
    expect(within(terminalDialog).getByText("刷新导入历史确认结果，再重新选择同一文件夹开始新的上传。")).toBeInTheDocument();
    expect(within(terminalDialog).getByText("数据安全")).toBeInTheDocument();
    expect(screen.queryByText(/没有创建内容版本/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "安全重试" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认并开始上传" })).not.toBeInTheDocument();

    await user.upload(uploadInput, new File(["export {};"], "main.ts", { type: "text/typescript" }));
    expect(await screen.findByRole("button", { name: "确认并开始上传" })).toBeVisible();
    expect(uploadFolder).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "确认并开始上传" }));
    await waitFor(() => expect(uploadFolder).toHaveBeenCalledTimes(3));

    expect(connectRepository).toHaveBeenCalledTimes(1);
    const resultHeading = await screen.findByText("内容版本已就绪");
    expect(resultHeading).toBeVisible();
    await waitFor(() => expect(resultHeading.closest("[tabindex='-1']")).toHaveFocus());
    expect(screen.getByText("资料已接入，正式知识尚未变化")).toBeVisible();
    expect(screen.getByRole("link", { name: "进入知识生产" })).toHaveAttribute("href", "/projects/project/production");
  });

  test.each(["UPLOAD_SESSION_STATE", "IDEMPOTENCY_KEY_REUSED"])("requires a new folder selection for terminal %s upload errors", async (code) => {
    const user = userEvent.setup();
    const uploadFolder = vi.fn().mockRejectedValue(new ApiError(409, code, "terminal upload error"));
    const api = {
      getRepository: vi.fn().mockResolvedValue({ repository: {
        id: "upload", projectId: "project", kind: "upload", name: "Uploaded project", defaultBranch: "upload"
      } }),
      listImportReports: vi.fn().mockResolvedValue({ reports: [], total: 0, limit: 20, offset: 0 }),
      uploadFolder
    } as unknown as ApiClient;

    renderPage(<ProjectImportsPage api={api} projectId="project" />);
    const uploadInput = await screen.findByLabelText("项目文件夹", { selector: 'input[type="file"]' }) as HTMLInputElement;
    await user.upload(uploadInput, new File(["export {};"], "main.ts", { type: "text/typescript" }));
    await user.click(await screen.findByRole("button", { name: "确认并开始上传" }));

    const dialog = await screen.findByRole("dialog", { name: "上传会话已失效" });
    expect(within(dialog).getByText("数据安全")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "安全重试" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认并开始上传" })).not.toBeInTheDocument();

    await user.upload(uploadInput, new File(["export {};"], "main.ts", { type: "text/typescript" }));
    expect(await screen.findByRole("button", { name: "确认并开始上传" })).toBeVisible();
  });
});

describe("MCP token disclosure", () => {
  test("shows plaintext in a one-time dialog and never in the token list", async () => {
    const user = userEvent.setup();
    const plaintext = "dkh_secret-token-shown-once";
    const api = {
      getProjectCodexConnection: vi.fn().mockResolvedValue({ projectId: "project", endpoint: "/mcp", environmentVariable: "DEVKH_PROJECT_TOKEN", configToml: "[mcp]", agentsMarkdown: "# Rules", checkCommand: "test -n token" }),
      listProjectMcpTokens: vi.fn().mockResolvedValueOnce({ tokens: [] }).mockResolvedValue({ tokens: [{ id: "t1", projectId: "project", name: "Local agent", tokenPrefix: "dkh_secret-t", createdAt: "2026-07-11", lastUsedAt: null, revokedAt: null }] }),
      createMcpToken: vi.fn().mockResolvedValue({
        id: "t1", projectId: "project", name: "Local agent", tokenPrefix: "dkh_secret-t", createdAt: "2026-07-11", lastUsedAt: null, revokedAt: null, token: plaintext
      })
    } as unknown as ApiClient;

    renderPageAt(<Routes><Route path="/projects/:projectId/codex" element={<ProjectCodexPage api={api} />} /></Routes>, "/projects/project/codex");
    await user.type(await screen.findByLabelText("Token 名称"), "Local agent");
    await user.click(screen.getByRole("button", { name: "创建 Token" }));
    const dialog = await screen.findByRole("dialog", { name: "已创建项目 Token" });
    expect(within(dialog).getByText(plaintext)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "我已保存" }));
    await waitFor(() => expect(screen.queryByText(plaintext)).not.toBeInTheDocument());
    expect(screen.getByText("dkh_secret-t")).toBeVisible();
  });

  test("rotates a project token and shows only the replacement plaintext once", async () => {
    const user = userEvent.setup();
    const rotateMcpToken = vi.fn().mockResolvedValue({
      previous: { id: "old", projectId: "project", name: "Local agent", tokenPrefix: "dkh_old", createdAt: "2026-07-11", lastUsedAt: null, revokedAt: "2026-07-14" },
      replacement: { id: "new", projectId: "project", name: "Local agent", tokenPrefix: "dkh_new", createdAt: "2026-07-14", lastUsedAt: null, revokedAt: null },
      token: "dkh_replacement-shown-once"
    });
    const api = {
      getProjectCodexConnection: vi.fn().mockResolvedValue({ projectId: "project", endpoint: "/mcp", environmentVariable: "DEVKH_PROJECT_TOKEN", configToml: "[mcp]", agentsMarkdown: "# Rules", checkCommand: "test -n token" }),
      listProjectMcpTokens: vi.fn()
        .mockResolvedValueOnce({ tokens: [{ id: "old", projectId: "project", name: "Local agent", tokenPrefix: "dkh_old", createdAt: "2026-07-11", lastUsedAt: null, revokedAt: null }] })
        .mockResolvedValue({ tokens: [{ id: "old", projectId: "project", name: "Local agent", tokenPrefix: "dkh_old", createdAt: "2026-07-11", lastUsedAt: null, revokedAt: "2026-07-14" }, { id: "new", projectId: "project", name: "Local agent", tokenPrefix: "dkh_new", createdAt: "2026-07-14", lastUsedAt: null, revokedAt: null }] }),
      rotateMcpToken
    } as unknown as ApiClient;

    renderPageAt(<Routes><Route path="/projects/:projectId/codex" element={<ProjectCodexPage api={api} />} /></Routes>, "/projects/project/codex");
    await user.click(await screen.findByRole("button", { name: "轮换 Local agent" }));

    expect(rotateMcpToken).toHaveBeenCalledWith("old", expect.anything());
    const dialog = await screen.findByRole("dialog", { name: "已轮换项目 Token" });
    expect(within(dialog).getByText("dkh_replacement-shown-once")).toBeInTheDocument();
  });

  test("loads token records after the first one hundred", async () => {
    const user = userEvent.setup();
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `token-${index}`,
      name: `Agent ${index}`,
      tokenPrefix: `dkh_${String(index).padStart(8, "0")}`,
      createdAt: "2026-07-11",
      lastUsedAt: null,
      revokedAt: null
    }));
    const listProjectMcpTokens = vi.fn()
      .mockResolvedValueOnce({ tokens: firstPage, total: 101, nextOffset: 100 })
      .mockResolvedValueOnce({
        tokens: [{
          id: "token-100", name: "Agent after 100", tokenPrefix: "dkh_00000100",
          createdAt: "2026-07-11", lastUsedAt: null, revokedAt: null
        }],
        total: 101,
        nextOffset: null
      });
    const api = {
      getProjectCodexConnection: vi.fn().mockResolvedValue({ projectId: "project", endpoint: "/mcp", environmentVariable: "DEVKH_PROJECT_TOKEN", configToml: "[mcp]", agentsMarkdown: "# Rules", checkCommand: "test -n token" }),
      listProjectMcpTokens
    } as unknown as ApiClient;

    renderPageAt(<Routes><Route path="/projects/:projectId/codex" element={<ProjectCodexPage api={api} />} /></Routes>, "/projects/project/codex");
    await user.click(await screen.findByRole("button", { name: "加载更多 Token" }));

    expect(await screen.findByText("Agent after 100")).toBeVisible();
    expect(listProjectMcpTokens).toHaveBeenNthCalledWith(1, "project", { limit: 100, offset: 0 });
    expect(listProjectMcpTokens).toHaveBeenNthCalledWith(2, "project", { limit: 100, offset: 100 });
  });
});

describe("model settings", () => {
  test("marks the model API key as a new credential so browser password managers do not autofill it", async () => {
    const api = {
      getRepository: vi.fn().mockRejectedValue(Object.assign(new Error("none"), { status: 404 })),
      getModelConfig: vi.fn().mockResolvedValue({ config: null }),
      getMfaStatus: vi.fn().mockResolvedValue({ enabled: false, pending: false, lockedUntil: null }),
      getMcpConnection: vi.fn().mockResolvedValue({ endpoint: "/mcp", transport: "streamable-http", authorization: "bearer", stdioCommand: "npm run mcp:stdio", tools: [] }),
      listMcpTokens: vi.fn().mockResolvedValue({ tokens: [] })
    } as unknown as ApiClient;

    renderPage(<SettingsPage api={api} />);

    const apiKey = await screen.findByLabelText("API Key");
    expect(apiKey).toHaveAttribute("autocomplete", "new-password");
    expect(apiKey).toHaveAttribute("name", "model-api-key");
  });

  test("loads sanitized config and preserves the key when the API key field is blank", async () => {
    const user = userEvent.setup();
    const updateModelConfig = vi.fn().mockResolvedValue({
      config: { provider: "anthropic", model: "claude-sonnet-4-5", hasApiKey: true }
    });
    const api = {
      getRepository: vi.fn().mockRejectedValue(Object.assign(new Error("none"), { status: 404 })),
      getModelConfig: vi.fn().mockResolvedValue({
        config: { provider: "openai", model: "gpt-5-mini", hasApiKey: true }
      }),
      updateModelConfig,
      getMcpConnection: vi.fn().mockResolvedValue({ endpoint: "/mcp", transport: "streamable-http", authorization: "bearer", stdioCommand: "npm run mcp:stdio", tools: [] }),
      listMcpTokens: vi.fn().mockResolvedValue({ tokens: [] })
    } as unknown as ApiClient;

    renderPage(<SettingsPage api={api} />);
    expect(await screen.findByDisplayValue("gpt-5-mini")).toBeEnabled();
    await user.selectOptions(screen.getByLabelText("服务商"), "anthropic");
    await user.clear(screen.getByLabelText("模型"));
    await user.type(screen.getByLabelText("模型"), "claude-sonnet-4-5");
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "保存模型设置" }));

    expect(updateModelConfig).toHaveBeenCalledWith({
      provider: "anthropic", model: "claude-sonnet-4-5", apiKey: ""
    });
    expect(await screen.findByText("模型设置已保存。")).toBeVisible();
  });

  test("enables the internal DeepSeek mode with a fixed model and masked key", async () => {
    const user = userEvent.setup();
    const updateModelConfig = vi.fn().mockResolvedValue({
      config: { provider: "deepseek", model: "deepseek-chat", hasApiKey: true }
    });
    const api = {
      getRepository: vi.fn().mockRejectedValue(Object.assign(new Error("none"), { status: 404 })),
      getModelConfig: vi.fn().mockResolvedValue({ config: null }),
      updateModelConfig,
      getMfaStatus: vi.fn().mockResolvedValue({ enabled: false, pending: false, lockedUntil: null }),
      getMcpConnection: vi.fn().mockResolvedValue({ endpoint: "/mcp", transport: "streamable-http", authorization: "bearer", stdioCommand: "npm run mcp:stdio", tools: [] }),
      listMcpTokens: vi.fn().mockResolvedValue({ tokens: [] })
    } as unknown as ApiClient;

    renderPage(<SettingsPage api={api} />);
    await user.click(await screen.findByRole("checkbox", { name: "内部启用 DeepSeek" }));

    expect(screen.getByText("deepseek-chat")).toBeVisible();
    expect(screen.queryByLabelText("服务商")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("模型")).not.toBeInTheDocument();
    const apiKey = screen.getByLabelText("API Key");
    expect(apiKey).toHaveAttribute("autocomplete", "new-password");
    await user.type(apiKey, "deepseek-key");
    await user.click(screen.getByRole("button", { name: "保存模型设置" }));

    expect(updateModelConfig).toHaveBeenCalledWith({
      provider: "deepseek", model: "deepseek-chat", apiKey: "deepseek-key"
    });
  });

  test("allows switching away from DeepSeek without re-entering a separately stored generic key", async () => {
    const user = userEvent.setup();
    const updateModelConfig = vi.fn().mockResolvedValue({
      config: { provider: "openai", model: "gpt-5-mini", hasApiKey: true }
    });
    const api = {
      getRepository: vi.fn().mockRejectedValue(Object.assign(new Error("none"), { status: 404 })),
      getModelConfig: vi.fn().mockResolvedValue({
        config: { provider: "deepseek", model: "deepseek-chat", hasApiKey: true }
      }),
      updateModelConfig,
      getMfaStatus: vi.fn().mockResolvedValue({ enabled: false, pending: false, lockedUntil: null }),
      getMcpConnection: vi.fn().mockResolvedValue({ endpoint: "/mcp", transport: "streamable-http", authorization: "bearer", stdioCommand: "npm run mcp:stdio", tools: [] }),
      listMcpTokens: vi.fn().mockResolvedValue({ tokens: [] })
    } as unknown as ApiClient;

    renderPage(<SettingsPage api={api} />);
    await user.click(await screen.findByRole("checkbox", { name: "内部启用 DeepSeek" }));
    await user.click(screen.getByRole("button", { name: "保存模型设置" }));

    expect(updateModelConfig).toHaveBeenCalledWith({
      provider: "openai", model: "gpt-5-mini", apiKey: ""
    });
  });
});
