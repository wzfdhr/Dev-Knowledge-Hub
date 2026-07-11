// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { KnowledgePage } from "./pages/knowledge-page";
import { FeedbackPage } from "./pages/feedback-page";
import { SettingsPage } from "./pages/settings-page";
import { derivePrimaryAction, OverviewPage } from "./pages/overview-page";
import type { ApiClient } from "./api/client";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => sessionStorage.clear());

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

describe("overview primary command", () => {
  test("chooses the single next operation from repository and build state", () => {
    expect(derivePrimaryAction({ repository: null, builds: [], releases: [] }).kind)
      .toBe("connect");
    expect(derivePrimaryAction({
      repository: { id: "repo", kind: "local", name: "Fixture", path: "/fixture", defaultBranch: "main" },
      builds: [], releases: [], snapshotId: "snap"
    }).kind).toBe("start-build");
    expect(derivePrimaryAction({
      repository: { id: "repo", kind: "local", name: "Fixture", path: "/fixture", defaultBranch: "main" },
      builds: [{ id: "build", status: "ready", snapshotId: "snap", commitSha: "abc", warnings: [], cancelRequested: false }],
      releases: []
    }).kind).toBe("review");
    expect(derivePrimaryAction({
      repository: { id: "repo", kind: "local", name: "Fixture", path: "/fixture", defaultBranch: "main" },
      builds: [{ id: "build", status: "ready", snapshotId: "snap", commitSha: "abc", warnings: [], cancelRequested: false }],
      releases: [{ id: "release", buildId: "build", snapshotId: "snap", version: "1.0.0", createdAt: "2026-07-11", publishedAt: null }]
    }).kind).toBe("publish");
    expect(derivePrimaryAction({
      repository: { id: "repo", kind: "local", name: "Fixture", path: "/fixture", defaultBranch: "main" },
      builds: [{ id: "build", status: "published", snapshotId: "snap", commitSha: "abc", warnings: [], cancelRequested: false }],
      releases: [{ id: "release", buildId: "build", snapshotId: "snap", version: "1.0.0", createdAt: "2026-07-11", publishedAt: "2026-07-11" }],
      snapshotId: "snap"
    }).kind).toBe("sync");
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
    expect(screen.getByRole("button", { name: "Retry overview data" })).toBeVisible();
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
    await user.click(await screen.findByRole("button", { name: "Review ready build" }));

    expect(screen.getByRole("button", { name: "Create release draft" })).toBeVisible();
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

    await user.click(await screen.findByRole("button", { name: "Review ready build" }));
    await user.click(screen.getByRole("button", { name: "Inspect knowledge" }));

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
    await screen.findByText("synthesizing", { selector: "h2" });
    expect(container.querySelector("progress")).toHaveAttribute("value", "66");
    expect(container.querySelector(".progress [style]")).toBeNull();
    FakeEventSource.instance.onerror?.();

    await waitFor(() => expect(screen.getByText("synthesizing", { selector: "h2" }).closest("section"))
      .toHaveTextContent("Reconnecting to build updates"));
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
    expect(screen.getByRole("button", { name: "Retry knowledge build" })).toBeVisible();
  });

  test("ignores an older failure after the latest build is published", async () => {
    sessionStorage.setItem("devkh:last-snapshot", JSON.stringify({
      snapshotId: "current-snap", commitSha: "b".repeat(40), ref: "main", fileCount: 4, unchanged: true
    }));
    const repository = {
      id: "repo", kind: "local" as const, name: "Fixture", path: "/fixture", defaultBranch: "main"
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
      kind: "sync", label: "Sync repository"
    });
    const api = {
      getRepository: vi.fn().mockResolvedValue({ repository }),
      listBuilds: vi.fn().mockResolvedValue({ builds }),
      listReleases: vi.fn().mockResolvedValue({ releases }),
      listFeedback: vi.fn().mockResolvedValue({ feedback: [] })
    } as unknown as ApiClient;

    renderPage(<OverviewPage api={api} />);

    expect(await screen.findByRole("button", { name: "Sync repository" })).toBeVisible();
    expect(screen.queryByText("Obsolete provider failure")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry knowledge build" })).not.toBeInTheDocument();
  });
});

describe("knowledge citations", () => {
  test("opens the exact cited source range and identifiers", async () => {
    const user = userEvent.setup();
    const api = {
      getRepositoryStatus: vi.fn().mockResolvedValue({ repository: { id: "repo", kind: "local", name: "Fixture", path: "/fixture", defaultBranch: "main" }, latestSnapshot: { id: "snapshot-1", commitSha: "a".repeat(40), ref: "main", commitTimestamp: "2026-07-11" } }),
      listReleases: vi.fn().mockResolvedValue({ releases: [{ id: "release-1", buildId: "build-1", snapshotId: "snapshot-1", version: "1.0.0", createdAt: "2026-07-11", publishedAt: "2026-07-11" }] }),
      getKnowledgeMetadata: vi.fn().mockResolvedValue({ symbols: [], dependencies: [] }),
      listKnowledgePages: vi.fn().mockResolvedValue({ pages: [{
        id: "page-1", slug: "module-math", title: "Module: math", body: "Math module.", chunks: [{
          id: "chunk-1", heading: "add", content: "Adds numbers.", citations: [{
            path: "src/math.ts", startLine: 16, endLine: 18,
            commitSha: "a".repeat(40), blobHash: "b".repeat(64)
          }]
        }]
      }] }),
      getKnowledgePage: vi.fn().mockResolvedValue({ page: {
        id: "page-1", slug: "module-math", title: "Module: math", body: "Math module.", chunks: [{
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
    await user.click(await screen.findByRole("button", { name: /module: math/i }));
    await user.click(await screen.findByRole("button", { name: /src\/math.ts lines 16 to 18/i }));

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

    expect(await screen.findByText("Unpublished draft")).toBeVisible();
    expect(screen.getByText(/newer repository snapshot/i)).toBeVisible();
    expect(screen.getByText(`${"a".repeat(12)} → ${"b".repeat(12)}`)).toBeVisible();
  });

  test("displays backend symbol and dependency metadata", async () => {
    const api = {
      getRepositoryStatus: vi.fn().mockResolvedValue({ repository: { id: "repo" }, latestSnapshot: { id: "snap", commitSha: "a".repeat(40), ref: "main", commitTimestamp: "2026-07-11" } }),
      listReleases: vi.fn().mockResolvedValue({ releases: [{ id: "release-1", buildId: "build-1", snapshotId: "snap", commitSha: "a".repeat(40), version: "1.0.0", createdAt: "2026-07-11", publishedAt: "2026-07-11" }] }),
      listKnowledgePages: vi.fn().mockResolvedValue({ pages: [] }),
      getKnowledgeMetadata: vi.fn().mockResolvedValue({
        symbols: [{ name: "add", kind: "function", path: "src/math.ts", startLine: 16, endLine: 18, exported: true }],
        dependencies: [{ source: "math", target: "util", kind: "imports", path: "src/math.ts", startLine: 1, endLine: 1 }]
      })
    } as unknown as ApiClient;

    renderPage(<KnowledgePage api={api} />);

    expect(await screen.findByText("add")).toBeVisible();
    expect(screen.getByText("function · src/math.ts:16-18")).toBeVisible();
    expect(screen.getByText("math → util")).toBeVisible();
    expect(screen.getByText("imports · src/math.ts:1")).toBeVisible();
  });
});

describe("feedback workflow", () => {
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
    const actions = screen.getByRole("group", { name: /feedback actions/i });
    expect(within(actions).getByRole("button", { name: "Acknowledge" })).toBeVisible();
    expect(within(actions).queryByRole("button", { name: "Mark fixed" })).not.toBeInTheDocument();
    await user.click(within(actions).getByRole("button", { name: "Acknowledge" }));

    await waitFor(() => expect(transitionFeedback).toHaveBeenCalledWith("f1", "acknowledged"));
    expect(await screen.findByRole("button", { name: "Request rebuild" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Mark fixed" })).toBeVisible();
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
    await user.click(screen.getByRole("button", { name: /src\/math.ts lines 16 to 18/i }));

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
    await user.click(screen.getByRole("button", { name: /src\/first.ts lines 2 to 4/i }));
    expect(await screen.findByText("r1:src/first.ts")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Second gap" }));
    expect(screen.queryByRole("complementary", { name: "Feedback source excerpt" })).not.toBeInTheDocument();
    expect(getSource).not.toHaveBeenCalledWith(expect.objectContaining({
      releaseId: "r2", path: "src/first.ts"
    }));

    await user.click(screen.getByRole("button", { name: /src\/second.ts lines 8 to 9/i }));
    expect(await screen.findByText("r2:src/second.ts")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.queryByRole("complementary", { name: "Feedback source excerpt" })).not.toBeInTheDocument();
    expect(getSource).not.toHaveBeenCalledWith(expect.objectContaining({
      releaseId: "r1", path: "src/second.ts"
    }));
  });
});

describe("MCP token disclosure", () => {
  test("shows plaintext in a one-time dialog and never in the token list", async () => {
    const user = userEvent.setup();
    const plaintext = "dkh_secret-token-shown-once";
    const api = {
      getRepository: vi.fn().mockRejectedValue(Object.assign(new Error("none"), { status: 404 })),
      getMcpConnection: vi.fn().mockResolvedValue({ endpoint: "/mcp", transport: "streamable-http", authorization: "bearer", stdioCommand: "npm run mcp:stdio", tools: [] }),
      listMcpTokens: vi.fn().mockResolvedValueOnce({ tokens: [] }).mockResolvedValue({ tokens: [{ id: "t1", name: "Local agent", tokenPrefix: "dkh_secret-t", createdAt: "2026-07-11", lastUsedAt: null, revokedAt: null }] }),
      createMcpToken: vi.fn().mockResolvedValue({
        id: "t1", name: "Local agent", tokenPrefix: "dkh_secret-t", createdAt: "2026-07-11", lastUsedAt: null, revokedAt: null, token: plaintext
      })
    } as unknown as ApiClient;

    renderPage(<SettingsPage api={api} />);
    await user.type(await screen.findByLabelText("Token name"), "Local agent");
    await user.click(screen.getByRole("button", { name: "Create token" }));
    const dialog = await screen.findByRole("dialog", { name: "MCP token created" });
    expect(within(dialog).getByText(plaintext)).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "I have copied it" }));
    expect(screen.queryByText(plaintext)).not.toBeInTheDocument();
    expect(screen.getByText("dkh_secret-t")).toBeVisible();
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
    await user.selectOptions(screen.getByLabelText("Provider"), "anthropic");
    await user.clear(screen.getByLabelText("Model"));
    await user.type(screen.getByLabelText("Model"), "claude-sonnet-4-5");
    expect(screen.getByLabelText("API key")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Save model settings" }));

    expect(updateModelConfig).toHaveBeenCalledWith({
      provider: "anthropic", model: "claude-sonnet-4-5", apiKey: ""
    });
    expect(await screen.findByText("Model settings saved.")).toBeVisible();
  });
});
