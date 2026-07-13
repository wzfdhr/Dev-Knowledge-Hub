import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Pool } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { runMigrations } from "../../db/migrate";
import { requireIsolatedTestDatabase } from "../../test/integration-database";
import { buildServer } from "../app";
import { syncRepository } from "../git/snapshot";
import { BuildService } from "../knowledge/build-service";
import { PgBossBuildJobQueue } from "../knowledge/job-queue";
import { hashMcpToken } from "../mcp/auth";
import { PostgresAppStore } from "./postgres-store";

const databaseUrl = process.env.TEST_DATABASE_URL
  ? requireIsolatedTestDatabase(process.env.TEST_DATABASE_URL)
  : undefined;
const integration = databaseUrl ? describe : describe.skip;
let pool: Pool | null = null;
let temporaryRoot: string | null = null;
const execute = promisify(execFile);

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for PostgreSQL workflow state");
}

integration("PostgreSQL cited knowledge integration", () => {
  test(databaseUrl
    ? "migrates durable build, citation, search, and release structures"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool = new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    const { rows } = await pool.query<{ names: string[] }>(
      `SELECT array_agg(table_name ORDER BY table_name) AS names
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('build_events', 'build_jobs', 'knowledge_chunks', 'releases')`
    );
    expect(rows[0].names).toEqual([
      "build_events", "build_jobs", "knowledge_chunks", "releases"
    ]);
    const extension = await pool.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'"
    );
    expect(extension.rows).toHaveLength(1);
  });

  test(databaseUrl
    ? "runs the audited production workflow, pg-boss reconciliation, publish rollback, and MCP revocation"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const store = new PostgresAppStore(pool);

    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-postgres-workflow-"));
    await execute("git", ["init", "-b", "main"], { cwd: temporaryRoot });
    await execute("git", ["config", "user.email", "workflow@example.com"], { cwd: temporaryRoot });
    await execute("git", ["config", "user.name", "Workflow Test"], { cwd: temporaryRoot });
    await writeFile(path.join(temporaryRoot, "index.ts"), "export const answer = 42;\n");
    await execute("git", ["add", "index.ts"], { cwd: temporaryRoot });
    await execute("git", ["commit", "-m", "fixture"], { cwd: temporaryRoot });

    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const repository = await store.createRepositoryWithAudit(setup!.workspace.id, {
      kind: "local",
      name: "Workflow",
      path: temporaryRoot
    }, setup!.admin.id);
    const dataDir = path.join(temporaryRoot, "data");
    const synced = await syncRepository({
      repository: repository!,
      dataDir,
      store,
      actorId: setup!.admin.id
    });
    const snapshot = await store.findSnapshotById(setup!.workspace.id, synced.snapshotId);
    const source = await store.findSourceFile(setup!.workspace.id, synced.snapshotId, "index.ts");
    expect(source?.contentHash).toBe(createHash("sha256")
      .update("export const answer = 42;\n").digest("hex"));
    const audit = await pool.query<{ action: string }>(
      "SELECT action FROM audit_events ORDER BY created_at, id"
    );
    expect(audit.rows.map((row) => row.action)).toEqual(expect.arrayContaining([
      "setup.completed",
      "repository.connected",
      "repository.sync_succeeded"
    ]));

    const queue = new PgBossBuildJobQueue(databaseUrl);
    const service = new BuildService(store, queue, { reconcileIntervalMs: 25 });
    let app: ReturnType<typeof buildServer> | null = null;
    let mcpClient: Client | null = null;
    await service.start();
    try {
      const undispatched = await store.createBuild({
        workspaceId: setup!.workspace.id,
        repositoryId: repository!.id,
        snapshotId: snapshot!.id,
        snapshotPath: snapshot!.storagePath,
        commitSha: snapshot!.commitSha
      });
      const ready = await waitFor(
        () => store.getBuild(setup!.workspace.id, undispatched.build.id),
        (build) => build?.status === "ready"
      );
      expect(ready?.status).toBe("ready");

      const firstRelease = await store.createReleaseDraft(
        setup!.workspace.id,
        repository!.id,
        undispatched.build.id,
        "1.0.0"
      );
      await store.publishRelease(setup!.workspace.id, firstRelease.id);
      expect((await store.currentRelease(setup!.workspace.id, repository!.id))?.id)
        .toBe(firstRelease.id);

      const oversizedCitations = Array.from({ length: 12 }, () => ({
        path: "index.ts",
        startLine: 1,
        endLine: 1,
        commitSha: snapshot!.commitSha,
        blobHash: source!.contentHash
      }));
      await pool!.query(
        `UPDATE knowledge_chunks chunk
         SET heading = 'Chunk 00', content = 'content-00', citations = $3::jsonb
         FROM knowledge_pages page
         WHERE chunk.page_id = page.id
           AND page.workspace_id = $1 AND page.build_job_id = $2
           AND page.slug = 'architecture-overview' AND chunk.position = 0`,
        [setup!.workspace.id, undispatched.build.id, JSON.stringify(oversizedCitations)]
      );
      await pool!.query(
        `INSERT INTO knowledge_chunks
         (workspace_id, page_id, position, heading, content, citations)
         SELECT $1, page.id, generated.position,
                'Chunk ' || lpad(generated.position::text, 2, '0'),
                'content-' || lpad(generated.position::text, 2, '0'),
                '[]'::jsonb
         FROM knowledge_pages page
         CROSS JOIN generate_series(1, 59) AS generated(position)
         WHERE page.workspace_id = $1 AND page.build_job_id = $2
           AND page.slug = 'architecture-overview'`,
        [setup!.workspace.id, undispatched.build.id]
      );

      const architecture = await store.findKnowledgePageBySlug(
        setup!.workspace.id,
        firstRelease.id,
        "architecture-overview"
      );
      expect(architecture?.chunks).toHaveLength(50);
      expect(architecture?.chunks.map((chunk) => chunk.heading)).toEqual(
        Array.from({ length: 50 }, (_, position) =>
          `Chunk ${String(position).padStart(2, "0")}`)
      );
      const architectureSearch = await store.searchKnowledge(
        setup!.workspace.id,
        repository!.id,
        "架构概览",
        firstRelease.id
      );
      expect(architectureSearch.find((result) => result.title === "架构概览")?.citations)
        .toHaveLength(8);

      for (const [query, title] of [
        ["快照", "架构概览"],
        ["配置", "开发约定"]
      ]) {
        const matches = await store.searchKnowledge(
          setup!.workspace.id,
          repository!.id,
          query,
          firstRelease.id
        );
        expect(matches).toEqual(expect.arrayContaining([
          expect.objectContaining({ title })
        ]));
      }

      const secondBuild = await service.startBuild({
        workspaceId: setup!.workspace.id,
        repositoryId: repository!.id,
        snapshotId: snapshot!.id,
        snapshotPath: snapshot!.storagePath,
        commitSha: snapshot!.commitSha
      });
      await waitFor(
        () => store.getBuild(setup!.workspace.id, secondBuild.build.id),
        (build) => build?.status === "ready"
      );
      const secondRelease = await store.createReleaseDraft(
        setup!.workspace.id,
        repository!.id,
        secondBuild.build.id,
        "2.0.0"
      );
      await pool.query(`
        CREATE OR REPLACE FUNCTION fail_second_release_publish() RETURNS trigger AS $$
        BEGIN
          IF NEW.version = '2.0.0' THEN RAISE EXCEPTION 'injected publish failure'; END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_second_release_publish
        BEFORE UPDATE ON releases FOR EACH ROW EXECUTE FUNCTION fail_second_release_publish();
      `);
      await expect(store.publishRelease(setup!.workspace.id, secondRelease.id))
        .rejects.toThrow("injected publish failure");
      await pool.query("DROP TRIGGER fail_second_release_publish ON releases");
      await pool.query("DROP FUNCTION fail_second_release_publish()");
      expect((await store.currentRelease(setup!.workspace.id, repository!.id))?.id)
        .toBe(firstRelease.id);
      expect((await store.getRelease(setup!.workspace.id, secondRelease.id))?.publishedAt)
        .toBeNull();
      expect((await store.getBuild(setup!.workspace.id, secondBuild.build.id))?.status)
        .toBe("ready");

      const plaintext = `dkh_${"z".repeat(43)}`;
      const token = await store.createMcpToken({
        workspaceId: setup!.workspace.id,
        projectId: repository!.projectId,
        name: "integration",
        tokenHash: hashMcpToken(plaintext),
        tokenPrefix: plaintext.slice(0, 12)
      });
      app = buildServer({
        store,
        masterKey: Buffer.alloc(32, 5).toString("base64"),
        sessionSecret: "postgres-workflow-session-secret",
        dataDir,
        nodeEnv: "test"
      });
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      mcpClient = new Client({ name: "postgres-workflow", version: "0.0.0" });
      await mcpClient.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${plaintext}` } }
      }));
      const releaseResult = await mcpClient.callTool({ name: "dkh_get_release", arguments: {} });
      expect(releaseResult.isError).not.toBe(true);
      await store.revokeMcpToken(setup!.workspace.id, token.id);
      await expect(mcpClient.callTool({ name: "dkh_get_release", arguments: {} })).rejects.toThrow();
    } finally {
      await mcpClient?.close().catch(() => undefined);
      await app?.close().catch(() => undefined);
      await service.stop();
    }
  }, 30_000);

  test(databaseUrl
    ? "rejects malformed release IDs before PostgreSQL UUID casts"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const app = buildServer({
      store: new PostgresAppStore(pool),
      masterKey: Buffer.alloc(32, 6).toString("base64"),
      sessionSecret: "postgres-release-route-session-secret",
      dataDir: "/tmp/devkh-postgres-release-route",
      nodeEnv: "test"
    });

    try {
      const setup = await app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { email: "admin@example.com", password: "correct horse battery staple" }
      });
      expect(setup.statusCode).toBe(201);
      const login = await app.inject({
        method: "POST",
        url: "/api/session",
        payload: { email: "admin@example.com", password: "correct horse battery staple" }
      });
      expect(login.statusCode).toBe(200);
      const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];

      const response = await app.inject({
        method: "GET",
        url: "/api/releases/not-a-uuid",
        headers: { cookie }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toEqual({
        code: "INVALID_INPUT",
        message: "Invalid release ID"
      });
    } finally {
      await app.close();
    }
  }, 30_000);
});

afterAll(async () => {
  if (pool) {
    await pool.query("DROP TRIGGER IF EXISTS fail_second_release_publish ON releases").catch(() => undefined);
    await pool.query("DROP FUNCTION IF EXISTS fail_second_release_publish()").catch(() => undefined);
  }
  await pool?.end();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});
