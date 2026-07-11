// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";

import { KnowledgePage } from "./pages/knowledge-page";
import { FeedbackPage } from "./pages/feedback-page";
import { SettingsPage } from "./pages/settings-page";
import { derivePrimaryAction } from "./pages/overview-page";
import type { ApiClient } from "./api/client";

afterEach(cleanup);

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
});

describe("knowledge citations", () => {
  test("opens the exact cited source range and identifiers", async () => {
    const user = userEvent.setup();
    const api = {
      listReleases: vi.fn().mockResolvedValue({ releases: [{ id: "release-1", buildId: "build-1", snapshotId: "snapshot-1", version: "1.0.0", createdAt: "2026-07-11", publishedAt: "2026-07-11" }] }),
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
});

describe("feedback workflow", () => {
  test("exposes only valid transitions and refreshes after acknowledgement", async () => {
    const user = userEvent.setup();
    const listFeedback = vi.fn()
      .mockResolvedValueOnce({ feedback: [{
        id: "f1", releaseId: "r1", query: "How do I deploy?", reason: "Missing runbook",
        expected: "Commands", status: "open", rebuildBuildId: null,
        createdAt: "2026-07-11T00:00:00Z", updatedAt: "2026-07-11T00:00:00Z"
      }] })
      .mockResolvedValue({ feedback: [{
        id: "f1", releaseId: "r1", query: "How do I deploy?", reason: "Missing runbook",
        expected: "Commands", status: "acknowledged", rebuildBuildId: null,
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
