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
import { derivePrimaryAction, ProjectVersionsPage as OverviewPage } from "./pages/project-versions-page";
import { ApiError, type ApiClient } from "./api/client";
import { App } from "./app";
import { ErrorState } from "./components/ui";

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
  test("uses direct flex containers for collaboration members instead of a table widget", async () => {
    const source = await readFile(resolve(process.cwd(), "src/client/pages/project-collaboration-page.tsx"), "utf8");
    const workspaceSource = await readFile(resolve(process.cwd(), "src/client/pages/members-page.tsx"), "utf8");

    expect(source).toContain('className="member-list"');
    expect(source).not.toContain("<Table");
    expect(workspaceSource).toContain('className="member-list workspace-member-list"');
    expect(workspaceSource).not.toContain("<Table");
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
    expect(await screen.findByRole("heading", { name: "AHeart Admin" }, { timeout: 5_000 })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "项目导航" })).toBeVisible();
    expect(screen.getByRole("link", { name: "项目概览" })).toHaveAttribute("href", "/projects/project-1/overview");
    expect(screen.getByRole("link", { name: "资料上传" })).toHaveAttribute("href", "/projects/project-1/imports");
    expect(screen.getByRole("link", { name: "知识图谱" })).toHaveAttribute("href", "/projects/project-1/graph");
    expect(screen.getByRole("link", { name: "知识版本" })).toHaveAttribute("href", "/projects/project-1/versions");
    expect(screen.getByRole("link", { name: "团队协作" })).toHaveAttribute("href", "/projects/project-1/collaboration");
    expect(screen.getByRole("link", { name: "Codex 接入" })).toHaveAttribute("href", "/projects/project-1/codex");
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

    renderAppAt(api, "/projects/project-1/imports");

    expect(await screen.findByRole("heading", { name: "资料上传" })).toBeVisible();
    expect(screen.getByRole("button", { name: "选择项目文件夹" })).toBeVisible();
    expect(["读取文件", "安全过滤", "文件夹直传", "服务端校验", "创建内容版本"].map((label) => screen.getByText(label).textContent)).toEqual([
      "读取文件", "安全过滤", "文件夹直传", "服务端校验", "创建内容版本"
    ]);
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
    expect(screen.getByRole("link", { name: "上传新资料" })).toHaveAttribute("href", "/projects/project-1/imports");
    expect(screen.getByRole("link", { name: "管理知识版本" })).toHaveAttribute("href", "/projects/project-1/versions");
    expect(screen.queryByRole("heading", { name: "最近构建" })).not.toBeInTheDocument();
    cleanup();

    renderAppAt(api, "/projects/project-1/versions");
    expect(await screen.findByRole("heading", { name: "知识版本" })).toBeVisible();
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
    expect(screen.getByRole("link", { name: "知识库" })).toBeVisible();
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
    expect(await screen.findByRole("heading", { name: "知识版本" })).toBeVisible();
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
    expect(await screen.findByRole("heading", { name: "知识库" })).toBeVisible();
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
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/"]}>
      <Location />
      <Routes>
        <Route path="/" element={<OverviewPage api={api} />} />
        <Route path="/knowledge" element={<p>Knowledge route</p>} />
      </Routes>
    </MemoryRouter></QueryClientProvider>);

    await user.click(await screen.findByRole("button", { name: "审核就绪构建" }));
    await user.click(screen.getByRole("button", { name: "查看知识" }));

    await waitFor(() => expect(createRelease).toHaveBeenCalledWith("build", "1.0.0"));
    expect(await screen.findByText("Knowledge route")).toBeVisible();
    expect(screen.getByTestId("location")).toHaveTextContent("/knowledge?releaseId=release-1");
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
    expect(screen.getByRole("link", { name: "前往资料上传" })).toBeVisible();
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

  test("displays backend symbol and dependency metadata", async () => {
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
      })
    } as unknown as ApiClient;

    renderPage(<KnowledgePage api={api} />);

    expect(await screen.findByText("add")).toBeVisible();
    expect(screen.getByText("function · src/math.ts:16-18")).toBeVisible();
    expect(screen.getAllByText("math → util")).toHaveLength(2);
    expect(screen.getByText("imports · src/math.ts:1")).toBeVisible();
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
    const listProjectRemediations = vi.fn().mockResolvedValue({ remediations: [remediation] });
    const transitionProjectRemediation = vi.fn().mockImplementation(async (_projectId: string, _remediationId: string, input: { state: string }) => {
      if (input.state === "accepted") listProjectRemediations.mockResolvedValue({ remediations: [acceptedRemediation] });
      return { remediation: { id: "remediation-1", state: input.state } };
    });
    const requestProjectRemediationRebuild = vi.fn().mockResolvedValue({ build: { id: "remediation-build" }, created: true });
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

    renderPage(<KnowledgePage api={api} />);

    const governance = await screen.findByRole("region", { name: "质量治理" });
    expect(within(governance).getByText("模块文档覆盖不足")).toBeVisible();
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
    await user.click(await within(governance).findByRole("button", { name: "请求范围重建" }));
    await waitFor(() => expect(api.requestProjectRemediationRebuild).toHaveBeenCalledWith("project-1", "remediation-1"));
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
  test("offers a connected administrator a deliberate repository replacement", async () => {
    const user = userEvent.setup();
    const replaceRepository = vi.fn().mockResolvedValue({ repository: {
      id: "replacement", projectId: "project", kind: "upload", name: "Uploaded project", defaultBranch: "upload"
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
      replaceRepository
    } as unknown as ApiClient;

    renderPage(<ProjectImportsPage api={api} projectId="project" />);

    await user.click(await screen.findByRole("button", { name: "更换资料来源" }));
    expect(screen.getByRole("dialog", { name: "更换资料来源" })).toHaveTextContent("旧来源和已发布知识会保留为只读历史");
    expect(within(screen.getByRole("dialog", { name: "更换资料来源" })).getByRole("button", { name: "选择项目文件夹" })).toBeInTheDocument();
  });

  test("records an uploaded snapshot so Overview can start a build", async () => {
    const user = userEvent.setup();
    const api = {
      getRepository: vi.fn().mockRejectedValue(new ApiError(404, "REPOSITORY_NOT_FOUND", "missing")),
      connectRepository: vi.fn().mockResolvedValue({ repository: {
        id: "upload", projectId: "project", kind: "upload", name: "Uploaded project", defaultBranch: "upload"
      } }),
      uploadFolder: vi.fn().mockResolvedValue({
        snapshotId: "snapshot", sourceVersion: "a".repeat(40), fileCount: 2, unchanged: false,
        ignored: { total: 2, reasons: { binary: 1, generated: 1 } }
      }),
      getModelConfig: vi.fn().mockResolvedValue({ config: null }),
      getMcpConnection: vi.fn().mockResolvedValue({ endpoint: "/mcp", transport: "streamable-http", authorization: "bearer", tools: [] }),
      listMcpTokens: vi.fn().mockResolvedValue({ tokens: [] })
    } as unknown as ApiClient;

    renderPage(<ProjectImportsPage api={api} projectId="project" />);
    const projectFile = new File(["export {};"], "main.ts", { type: "text/typescript" });
    const uploadInput = await screen.findByLabelText("项目文件夹") as HTMLInputElement;
    await user.upload(uploadInput, projectFile);
    await user.click(await screen.findByRole("button", { name: "确认并开始上传" }));

    await waitFor(() => expect(api.uploadFolder).toHaveBeenCalledWith(
      "project", [expect.objectContaining({ path: "main.ts" })]
    ));
    await waitFor(() => expect(sessionStorage.getItem("devkh:last-snapshot")).toContain("snapshot"));
    expect(await screen.findByText("已忽略 2 个文件")).toBeVisible();
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
});
