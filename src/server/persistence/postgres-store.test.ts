import { describe, expect, test, vi } from "vitest";

import { PostgresAppStore } from "./postgres-store";

describe("PostgresAppStore repository reads", () => {
  test("maps database rows to sanitized metadata and isolates credential reads", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: "repo-1",
          workspace_id: "workspace-1",
          kind: "git",
          name: "Private",
          local_path: null,
          clone_url: "https://example.com/private.git",
          default_branch: "main",
          has_credential: true
        }]
      })
      .mockResolvedValueOnce({ rows: [{ ciphertext: "encrypted-only" }] });
    const store = new PostgresAppStore({ query } as never);

    const repository = await store.currentRepository("workspace-1");
    expect(repository).toEqual({
      id: "repo-1",
      workspaceId: "workspace-1",
      kind: "git",
      name: "Private",
      localPath: null,
      cloneUrl: "https://example.com/private.git",
      defaultBranch: "main",
      hasCredential: true
    });
    expect(JSON.stringify(repository)).not.toContain("encrypted-only");

    await expect(store.repositoryCredential("workspace-1", "repo-1")).resolves.toBe("encrypted-only");
    expect(query).toHaveBeenCalledTimes(2);
  });

  test("returns the winning snapshot on commit conflict without inserting loser files", async () => {
    const winner = {
      id: "snapshot-winner",
      workspace_id: "workspace-1",
      repository_id: "repo-1",
      commit_sha: "a".repeat(40),
      ref: "main",
      remote_url: null,
      commit_timestamp: new Date("2026-07-11T00:00:00.000Z"),
      storage_path: "/data/snapshots/snapshot-winner"
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO source_snapshots")) return { rows: [] };
      if (sql.includes("FROM source_snapshots")) return { rows: [winner] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({
      connect: vi.fn(async () => client)
    } as never);

    const persisted = await store.createSnapshot({
      snapshot: {
        id: "snapshot-loser",
        workspaceId: "workspace-1",
        repositoryId: "repo-1",
        commitSha: "a".repeat(40),
        ref: "main",
        remoteUrl: null,
        commitTimestamp: new Date("2026-07-11T00:00:00.000Z"),
        storagePath: "/data/snapshots/snapshot-loser"
      },
      files: [{
        id: "file-loser",
        workspaceId: "workspace-1",
        snapshotId: "snapshot-loser",
        path: "src/index.ts",
        byteSize: 1,
        contentHash: "b".repeat(64),
        language: "typescript"
      }]
    });

    expect(persisted.id).toBe("snapshot-winner");
    expect(query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO source_snapshots"))?.[0])
      .toContain("ON CONFLICT (repository_id, commit_sha) DO NOTHING");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO source_files")))
      .toBe(false);
  });
});

describe("PostgresAppStore knowledge releases", () => {
  test("replays build events in monotonic sequence order", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: [], sql }));
    const store = new PostgresAppStore({ query } as never);

    await store.listBuildEvents("workspace-1", "build-1");

    expect(String(query.mock.calls[0][0])).toContain("ORDER BY e.sequence");
  });
  test("claims only queued jobs and guards every transition by expected status", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const store = new PostgresAppStore({ query } as never);

    await expect(store.claimBuild("build-1")).resolves.toBeNull();
    await expect(store.transitionBuild("build-1", "parsing", "synthesizing"))
      .resolves.toBeNull();

    expect(String(query.mock.calls[0][0])).toContain("status = 'queued'");
    expect(String(query.mock.calls[0][0])).toContain("RETURNING");
    expect(String(query.mock.calls[1][0])).toContain("status = $2");
    expect(query.mock.calls[1][1]).toEqual([
      "build-1", "parsing", "synthesizing", null, null, "{}"
    ]);
  });
  test("publishes a ready release and channel pointer in one transaction", async () => {
    const releaseRow = {
      id: "release-1",
      workspace_id: "workspace-1",
      repository_id: "repo-1",
      build_job_id: "build-1",
      snapshot_id: "snapshot-1",
      version: "1.0.0",
      created_at: new Date("2026-07-11T00:00:00Z"),
      published_at: new Date("2026-07-11T00:01:00Z"),
      status: "ready"
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FOR UPDATE")) return { rows: [releaseRow] };
      if (sql.includes("UPDATE releases")) return { rows: [releaseRow] };
      if (sql.includes("UPDATE build_jobs")) return { rows: [{
        id: "build-1", workspace_id: "workspace-1", status: "published"
      }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({ connect: vi.fn(async () => client) } as never);

    await store.publishRelease("workspace-1", "release-1");

    expect(query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/)[0])).toEqual([
      "BEGIN", "SELECT", "INSERT", "UPDATE", "UPDATE", "INSERT", "COMMIT"
    ]);
    expect(query.mock.calls[2][0]).toContain("ON CONFLICT (repository_id, name)");
    expect(query.mock.calls[2][0]).toContain("release_id = EXCLUDED.release_id");
    expect(query.mock.calls[4][0]).toContain("status = 'ready'");
    expect(query.mock.calls[4][0]).toContain("RETURNING");
    expect(query.mock.calls[5][0]).toContain("INSERT INTO build_events");
  });

  test("rolls back publication when the channel update fails", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FOR UPDATE")) return { rows: [{
        id: "release-1",
        workspace_id: "workspace-1",
        repository_id: "repo-1",
        build_job_id: "build-1",
        snapshot_id: "snapshot-1",
        version: "1.0.0",
        created_at: new Date(),
        published_at: null,
        status: "ready"
      }] };
      if (sql.includes("INSERT INTO release_channels")) throw new Error("database unavailable");
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({ connect: vi.fn(async () => client) } as never);

    await expect(store.publishRelease("workspace-1", "release-1"))
      .rejects.toThrow("database unavailable");
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE releases"))).toBe(false);
  });

  test("uses explicit symbol, path, neighbor, full-text, and trigram ranking tiers", async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("WITH selected_release");
      return { rows: [] };
    });
    const store = new PostgresAppStore({ query } as never);

    await store.searchKnowledge("workspace-1", "repo-1", "add", "release-1");

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("WHEN lower(cs.name) = lower($3) THEN 100");
    expect(sql).toContain("WHEN lower(sf.path) = lower($3) THEN 90");
    expect(sql).toContain("dependency-neighbor");
    expect(sql).toContain("neighbor_candidates");
    expect(sql).toContain("p.slug = 'modules/'");
    expect(sql).toContain("ROW_NUMBER() OVER");
    expect(sql).toContain("symbol_rank <= 15");
    expect(sql).toContain("neighbor_rank <= 15");
    expect(sql).toContain("text_rank <= 20");
    expect(sql).toContain("ts_rank_cd");
    expect(sql).toContain("similarity");
    expect(sql).toContain("ORDER BY score DESC, title ASC");
  });
});

describe("PostgresAppStore audited mutations", () => {
  const tokenRow = {
    id: "token-1",
    workspace_id: "workspace-1",
    name: "CI",
    token_hash: "a".repeat(64),
    token_prefix: "dkh_example",
    created_at: new Date(),
    last_used_at: null,
    revoked_at: null
  };
  const feedbackRow = {
    id: "feedback-1",
    workspace_id: "workspace-1",
    release_id: "release-1",
    query: "deploy",
    reason: "missing",
    expected: null,
    status: "acknowledged",
    rebuild_build_id: null,
    created_at: new Date(),
    updated_at: new Date()
  };
  const buildRow = {
    id: "build-1",
    workspace_id: "workspace-1",
    repository_id: "repo-1",
    snapshot_id: "snapshot-1",
    snapshot_path: "/snapshot",
    commit_sha: "b".repeat(40),
    status: "queued",
    warnings: [],
    cancel_requested: false,
    error_message: null
  };

  test.each([
    ["token create", (store: PostgresAppStore) => store.createMcpTokenWithAudit({
      workspaceId: "workspace-1",
      name: "CI",
      tokenHash: "a".repeat(64),
      tokenPrefix: "dkh_example"
    }, "admin-1")],
    ["token revoke", (store: PostgresAppStore) =>
      store.revokeMcpTokenWithAudit("workspace-1", "token-1", "admin-1")],
    ["feedback report", (store: PostgresAppStore) => store.reportFeedbackWithAudit({
      workspaceId: "workspace-1", releaseId: "release-1", query: "deploy", reason: "missing"
    })],
    ["feedback transition", (store: PostgresAppStore) =>
      store.transitionFeedbackWithAudit("workspace-1", "feedback-1", "fixed", "admin-1")],
    ["feedback rebuild", (store: PostgresAppStore) => store.requestFeedbackRebuildWithAudit({
      workspaceId: "workspace-1",
      feedbackId: "feedback-1",
      releaseId: "release-1",
      actorId: "admin-1",
      build: {
        workspaceId: "workspace-1",
        repositoryId: "repo-1",
        snapshotId: "snapshot-1",
        snapshotPath: "/snapshot",
        commitSha: "b".repeat(40)
      }
    })]
  ])("rolls back %s when the required audit insert fails", async (_name, invoke) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO audit_events")) throw new Error("audit unavailable");
      if (sql.includes("INSERT INTO mcp_tokens") || sql.includes("UPDATE mcp_tokens")) {
        return { rows: [tokenRow] };
      }
      if (sql.includes("FROM agent_feedback") && sql.includes("FOR UPDATE")) {
        return { rows: [feedbackRow] };
      }
      if (sql.includes("INSERT INTO agent_feedback") || sql.includes("UPDATE agent_feedback")) {
        return { rows: [feedbackRow] };
      }
      if (sql.includes("FROM build_jobs")) return { rows: [buildRow] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({ connect: vi.fn(async () => client) } as never);

    await expect(invoke(store)).rejects.toThrow("audit unavailable");

    expect(query.mock.calls[0][0]).toBe("BEGIN");
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
  });
});
