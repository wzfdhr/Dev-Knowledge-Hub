import { describe, expect, test, vi } from "vitest";

import { PostgresAppStore } from "./postgres-store";

describe("PostgresAppStore repository reads", () => {
  test("maps database rows to sanitized metadata and isolates credential reads", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: "repo-1",
          workspace_id: "workspace-1",
          project_id: "project-1",
          kind: "git",
          name: "Private",
          local_path: null,
          clone_url: "https://example.com/private.git",
          default_branch: "main",
          archived_at: null,
          has_credential: true
        }]
      })
      .mockResolvedValueOnce({ rows: [{ ciphertext: "encrypted-only" }] });
    const store = new PostgresAppStore({ query } as never);

    const repository = await store.currentRepository("workspace-1");
    expect(repository).toEqual({
      id: "repo-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
      kind: "git",
      name: "Private",
      localPath: null,
      cloneUrl: "https://example.com/private.git",
      defaultBranch: "main",
      archivedAt: null,
      hasCredential: true
    });
    expect(JSON.stringify(repository)).not.toContain("encrypted-only");

    await expect(store.repositoryCredential("workspace-1", "repo-1")).resolves.toBe("encrypted-only");
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0][0])).toContain("r.archived_at IS NULL");
  });

  test("creates a credentialed archived candidate before atomically switching current repositories", async () => {
    const original = {
      id: "repo-original",
      workspace_id: "workspace-1",
      project_id: "project-1",
      kind: "local",
      name: "Original",
      local_path: "/original",
      clone_url: null,
      default_branch: "main",
      archived_at: null,
      has_credential: false
    };
    const replacement = {
      id: "repo-replacement",
      workspace_id: "workspace-1",
      project_id: "project-1",
      kind: "git",
      name: "Replacement",
      local_path: null,
      clone_url: "https://example.com/replacement.git",
      default_branch: "main",
      archived_at: new Date("2026-07-12T00:00:00.000Z"),
      has_credential: false
    };
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      if (sql.includes("FROM projects")) return { rows: [{ id: "project-1" }] };
      if (sql.includes("FROM repositories r") && sql.includes("FOR UPDATE")) {
        return { rows: [original] };
      }
      if (sql.includes("INSERT INTO repositories")) return { rows: [replacement] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({ connect: vi.fn(async () => client) } as never);

    const switched = await store.switchRepositoryWithAudit("workspace-1", {
      kind: "git",
      name: "Replacement",
      url: "https://example.com/replacement.git",
      encryptedToken: "encrypted-token"
    }, "admin-1");

    expect(switched).toEqual({
      id: "repo-replacement",
      workspaceId: "workspace-1",
      projectId: "project-1",
      kind: "git",
      name: "Replacement",
      localPath: null,
      cloneUrl: "https://example.com/replacement.git",
      defaultBranch: "main",
      archivedAt: null,
      hasCredential: true
    });
    expect(query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/)[0])).toEqual([
      "BEGIN", "SELECT", "SELECT", "INSERT", "INSERT", "UPDATE", "UPDATE", "INSERT", "COMMIT"
    ]);
    expect(String(query.mock.calls[3][0])).toContain("archived_at");
    expect(String(query.mock.calls[5][0])).toContain("SET archived_at = now()");
    expect(String(query.mock.calls[6][0])).toContain("SET archived_at = NULL");
    expect(query.mock.calls[7][1]).toEqual(expect.arrayContaining([
      expect.stringContaining("oldRepositoryId"),
      expect.stringContaining("newRepositoryId")
    ]));
  });

  test("rolls back before archiving the current repository when credential creation fails", async () => {
    const original = {
      id: "repo-original",
      workspace_id: "workspace-1",
      kind: "local",
      name: "Original",
      local_path: "/original",
      clone_url: null,
      default_branch: "main",
      archived_at: null,
      has_credential: false
    };
    const replacement = {
      ...original,
      id: "repo-replacement",
      kind: "git" as const,
      name: "Replacement",
      local_path: null,
      clone_url: "https://example.com/replacement.git",
      archived_at: new Date("2026-07-12T00:00:00.000Z")
    };
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      if (sql.includes("FROM projects")) return { rows: [{ id: "project-1" }] };
      if (sql.includes("FROM repositories r") && sql.includes("FOR UPDATE")) {
        return { rows: [original] };
      }
      if (sql.includes("INSERT INTO repositories")) return { rows: [replacement] };
      if (sql.includes("INSERT INTO encrypted_credentials")) {
        throw new Error("credential unavailable");
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({ connect: vi.fn(async () => client) } as never);

    await expect(store.switchRepositoryWithAudit("workspace-1", {
      kind: "git",
      name: "Replacement",
      url: "https://example.com/replacement.git",
      encryptedToken: "encrypted-token"
    }, "admin-1")).rejects.toThrow("credential unavailable");

    expect(query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/)[0])).toEqual([
      "BEGIN", "SELECT", "SELECT", "INSERT", "INSERT", "ROLLBACK"
    ]);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE repositories"))).toBe(false);
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
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
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
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      if (sql.includes("FROM build_jobs") && sql.includes("FOR UPDATE")) {
        return { rows: [{ workspace_id: "workspace-1", repository_id: "repo-1" }] };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({
      connect: vi.fn(async () => client),
      query
    } as never);

    await expect(store.claimBuild("build-1")).resolves.toBeNull();
    await expect(store.transitionBuild("build-1", "parsing", "synthesizing"))
      .resolves.toBeNull();

    const claimSql = query.mock.calls.map(([sql]) => String(sql))
      .find((sql) => sql.includes("UPDATE build_jobs"))!;
    expect(claimSql).toContain("status = 'queued'");
    expect(claimSql).toContain("NOT EXISTS");
    expect(claimSql).toContain("'syncing', 'parsing', 'synthesizing', 'validating'");
    expect(claimSql).toContain("RETURNING");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("pg_advisory_xact_lock")))
      .toBe(true);

    const transitionCall = query.mock.calls.at(-1)!;
    expect(String(transitionCall[0])).toContain("status = $2");
    expect(String(transitionCall[0])).toContain("cancel_requested = false");
    expect(transitionCall[1]).toEqual([
      "build-1", "parsing", "synthesizing", null, null, "{}", false
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

  test("bounds dependency-neighbor and text-search citations inside SQL laterals", async () => {
    const query = vi.fn(async (_sql: string) => {
      void _sql;
      return { rows: [] };
    });
    const store = new PostgresAppStore({ query } as never);

    await store.searchKnowledge("workspace-1", "repo-1", "add", "release-1");

    const sql = String(query.mock.calls[0][0]);
    expect(sql.match(/jsonb_path_query_array\(selected_chunk\.citations, '\$\[0 to 7\]'\)/g))
      .toHaveLength(2);
    expect(sql).not.toContain("SELECT citations FROM knowledge_chunks");
    expect(sql.match(/ORDER BY selected_chunk\.position, selected_chunk\.id LIMIT 1/g))
      .toHaveLength(2);
  });

  test("bounds page payloads inside every SQL projection", async () => {
    const query = vi.fn(async (_sql: string) => {
      void _sql;
      return { rows: [] };
    });
    const store = new PostgresAppStore({ query } as never);

    await store.listKnowledgePages("workspace-1", "release-1");
    await store.getKnowledgePage("workspace-1", "page-1");
    await store.findKnowledgePageBySlug("workspace-1", "release-1", "architecture-overview");
    await store.findKnowledgePageByModule("workspace-1", "release-1", "src/index.ts");
    await store.findKnowledgePageBySymbol("workspace-1", "release-1", "run", "src/index.ts");

    for (const [sqlValue] of query.mock.calls) {
      const sql = String(sqlValue);
      expect(sql).toContain("left(p.body, 20000) AS body");
      expect(sql).toContain("'content', left(c.content, 8000)");
      expect(sql).toContain("jsonb_path_query_array(c.citations, '$[0 to 7]')");
      expect(sql).not.toContain("'content', c.content");
      expect(sql).not.toContain("'citations', c.citations");
      expect(sql).toContain("ORDER BY c.position, c.id");
      expect(sql).toContain("ORDER BY selected_chunk.position, selected_chunk.id LIMIT 50");
    }
  });

  test("combines English full-text search with case-insensitive page substring search", async () => {
    const query = vi.fn(async (_sql: string) => {
      void _sql;
      return { rows: [] };
    });
    const store = new PostgresAppStore({ query } as never);

    await store.searchKnowledge("workspace-1", "repo-1", "架构概览", "release-1");

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("to_tsvector('english', kp.title || ' ' || kp.body)");
    expect(sql).toContain("lower(kp.title || ' ' || kp.body) LIKE '%' || lower($3) || '%'");
    expect(sql).toContain("text_rank <= 20");
    expect(sql).toContain("LIMIT 50");
  });

  test("persists generator chunk indexes as database positions", async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      return sql.includes("INSERT INTO knowledge_pages")
        ? { rows: [{ id: "page-1" }] }
        : { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({ connect: vi.fn(async () => client) } as never);

    await store.saveKnowledge({
      build: { id: "build-1", workspaceId: "workspace-1", repositoryId: "repo-1" },
      index: { symbols: [], edges: [] },
      output: {
        pages: [{
          slug: "architecture-overview",
          title: "架构概览",
          body: "body",
          chunks: [
            { heading: "first", content: "one", citations: [] },
            { heading: "second", content: "two", citations: [] }
          ]
        }]
      }
    } as never);

    const chunkCalls = query.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO knowledge_chunks")
    );
    expect(chunkCalls).toHaveLength(2);
    expect(String(chunkCalls[0][0])).toContain(
      "(workspace_id, page_id, position, heading, content, citations)"
    );
    expect(chunkCalls.map(([, values]) => values?.[2])).toEqual([0, 1]);
  });

  test("uses bounded targeted SQL for release page, module, symbol, and list reads", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => {
      void _sql;
      void _values;
      return { rows: [] };
    });
    const store = new PostgresAppStore({ query } as never);

    await store.findKnowledgePageBySlug("workspace-1", "release-1", "architecture-overview");
    await store.findKnowledgePageByModule("workspace-1", "release-1", "src/math.ts");
    await store.findKnowledgePageBySymbol("workspace-1", "release-1", "add", "src/math.ts");
    await store.listKnowledgePages("workspace-1", "release-1", { limit: 25, offset: 50 });

    expect(query).toHaveBeenCalledTimes(4);
    for (const [sql] of query.mock.calls) expect(String(sql)).toContain("LIMIT");
    expect(String(query.mock.calls[0][0])).toContain("p.slug = $3");
    expect(String(query.mock.calls[1][0])).toContain("p.title IN ('模块：' || $3, 'Module: ' || $3)");
    expect(String(query.mock.calls[2][0])).toContain("p.title = $3");
    expect(query.mock.calls[3][1]).toEqual(["workspace-1", "release-1", 25, 50]);
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
  const workspaceRow = { id: "workspace-1", name: "Default Workspace", slug: "default" };
  const adminRow = {
    id: "admin-1",
    workspace_id: "workspace-1",
    email: "admin@example.com",
    password_hash: "hash"
  };
  const repositoryRow = {
    id: "repo-1",
    workspace_id: "workspace-1",
    kind: "local",
    name: "Fixture",
    local_path: "/fixture",
    clone_url: null,
    default_branch: "main",
    archived_at: null,
    has_credential: false
  };
  const snapshotRow = {
    id: "snapshot-1",
    workspace_id: "workspace-1",
    repository_id: "repo-1",
    commit_sha: "b".repeat(40),
    ref: "main",
    remote_url: null,
    commit_timestamp: new Date(),
    storage_path: "/snapshot"
  };

  test.each([
    ["initial setup", (store: PostgresAppStore) =>
      store.createInitialSetup("admin@example.com", "hash")],
    ["repository create", (store: PostgresAppStore) => store.createRepositoryWithAudit(
      "workspace-1",
      { kind: "local", name: "Fixture", path: "/fixture" },
      "admin-1"
    )],
    ["snapshot sync", (store: PostgresAppStore) => store.createSnapshotWithAudit({
      snapshot: {
        id: "snapshot-1",
        workspaceId: "workspace-1",
        repositoryId: "repo-1",
        commitSha: "b".repeat(40),
        ref: "main",
        remoteUrl: null,
        commitTimestamp: new Date(),
        storagePath: "/snapshot"
      },
      files: [{
        id: "file-1",
        workspaceId: "workspace-1",
        snapshotId: "snapshot-1",
        path: "src/index.ts",
        byteSize: 1,
        contentHash: "c".repeat(64),
        language: "typescript"
      }]
    }, "admin-1")],
    ["token create", (store: PostgresAppStore) => store.createMcpTokenWithAudit({
      workspaceId: "workspace-1",
      projectId: "project-1",
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
      if (sql.includes("INSERT INTO workspaces")) return { rows: [workspaceRow] };
      if (sql.includes("INSERT INTO admin_users")) return { rows: [adminRow] };
      if (sql.includes("INSERT INTO projects")) return { rows: [{ id: "project-1" }] };
      if (sql.includes("SELECT 1 FROM admin_users")) return { rows: [] };
      if (sql.includes("FROM projects")) return { rows: [{ id: "project-1" }] };
      if (sql.includes("INSERT INTO repositories")) return { rows: [repositoryRow] };
      if (sql.includes("INSERT INTO source_snapshots")) return { rows: [snapshotRow] };
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
