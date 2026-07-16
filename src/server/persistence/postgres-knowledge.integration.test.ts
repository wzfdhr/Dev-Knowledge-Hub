import { authenticatedCookie, csrfHeaders } from "../test-support/csrf";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { runMigrations } from "../../db/migrate";
import { requireIsolatedTestDatabase } from "../../test/integration-database";
import { buildServer } from "../app";
import { syncRepository } from "../git/snapshot";
import { BuildService } from "../knowledge/build-service";
import { PgBossBuildJobQueue } from "../knowledge/job-queue";
import { ArtifactStore } from "../knowledge/pipeline/artifact-store";
import { createNormalizedSourcesStageExecutor, normalizedSourcesPipelineInputDigest } from "../knowledge/pipeline/convert-stage";
import { createKnowledgeIrStageExecutor } from "../knowledge/pipeline/extract-stage";
import { createKnowledgeGraphStageExecutor } from "../knowledge/pipeline/graph-stage";
import { createPipelineSearchIndexStageExecutor } from "../knowledge/pipeline/index-stage";
import { createKnowledgePackageStageExecutor } from "../knowledge/pipeline/package-stage";
import { createKnowledgeQualityStageExecutor } from "../knowledge/pipeline/quality-stage";
import { createPipelineStageExecutor } from "../knowledge/pipeline/stage-executor";
import { createB02StageInputPlanner } from "../knowledge/pipeline/stage-planner";
import { createKnowledgeSynthesisStageExecutor } from "../knowledge/pipeline/synthesize-stage";
import { createTableSchemasStageExecutor } from "../knowledge/pipeline/tables-stage";
import { createKnowledgeValidationStageExecutor } from "../knowledge/pipeline/validate-stage";
import { createKnowledgeVisualizationStageExecutor } from "../knowledge/pipeline/viz-stage";
import { PipelineStageWorker, type PipelineStageJob, type PipelineStageJobQueue } from "../knowledge/pipeline/worker";
import { hashMcpToken } from "../mcp/auth";
import { PostgresSessionStore } from "../security/session-store";
import { LastProjectAdminError } from "./store";
import { PostgresAppStore } from "./postgres-store";

const databaseUrl = process.env.TEST_DATABASE_URL
  ? requireIsolatedTestDatabase(process.env.TEST_DATABASE_URL)
  : undefined;
const integration = databaseUrl ? describe : describe.skip;
let pool: Pool | null = null;
let temporaryRoot: string | null = null;
const execute = promisify(execFile);

class RecordedPipelineQueue implements PipelineStageJobQueue {
  readonly sent: PipelineStageJob[] = [];

  async send(job: PipelineStageJob): Promise<void> {
    this.sent.push(job);
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  let latest: T | undefined;
  while (Date.now() < deadline) {
    const value = await read();
    latest = value;
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for PostgreSQL workflow state: ${JSON.stringify(latest)}`);
}

integration("PostgreSQL cited knowledge integration", () => {
  test(databaseUrl
    ? "migrates durable build, citation, search, and release structures"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool = new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    const { rows } = await pool.query<{ names: string[] }>(
      `SELECT json_agg(table_name ORDER BY table_name) AS names
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('auth_sessions', 'build_events', 'build_jobs', 'build_stage_runs', 'import_reports', 'knowledge_artifacts', 'knowledge_chunks', 'knowledge_graph_edges', 'knowledge_graph_nodes', 'project_members', 'releases', 'remediation_cases', 'remediation_events')`
    );
    expect(rows[0].names).toEqual([
      "auth_sessions", "build_events", "build_jobs", "build_stage_runs", "import_reports", "knowledge_artifacts", "knowledge_chunks", "knowledge_graph_edges", "knowledge_graph_nodes", "project_members", "releases", "remediation_cases", "remediation_events"
    ]);
    const extension = await pool.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'"
    );
    expect(extension.rows).toHaveLength(1);
  }, 30_000);

  test(databaseUrl
    ? "validates legacy remediation identities before applying the unique migration"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    const migrationSql = await readFile(path.resolve("drizzle/0022_remediation_issue_identity.sql"), "utf8");

    const runFixture = async (
      issues: Array<{ workspaceId: string; sourceBuildId: string; issue: object }>,
      verify: (client: PoolClient) => Promise<void>
    ) => {
      const client = await pool!.connect();
      const schema = `remediation_migration_${randomUUID().replaceAll("-", "")}`;
      try {
        await client.query(`CREATE SCHEMA ${schema}`);
        await client.query(`SET search_path TO ${schema}, public`);
        await client.query(`CREATE TABLE remediation_cases (
          workspace_id uuid NOT NULL,
          source_build_id uuid NOT NULL,
          issue jsonb NOT NULL
        )`);
        for (const row of issues) {
          await client.query(
            "INSERT INTO remediation_cases (workspace_id, source_build_id, issue) VALUES ($1, $2, $3::jsonb)",
            [row.workspaceId, row.sourceBuildId, JSON.stringify(row.issue)]
          );
        }
        await verify(client);
      } finally {
        await client.query("RESET search_path").catch(() => undefined);
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
        client.release();
      }
    };

    const workspaceId = randomUUID();
    const sourceBuildId = randomUUID();
    await runFixture([{ workspaceId, sourceBuildId, issue: { id: "lint-1" } }], async (client) => {
      await client.query(migrationSql);
      const { rows } = await client.query<{ issue_id: string }>("SELECT issue_id FROM remediation_cases");
      expect(rows).toEqual([{ issue_id: "lint-1" }]);
    });
    await runFixture([{ workspaceId, sourceBuildId, issue: {} }], async (client) => {
      await expect(client.query(migrationSql)).rejects.toThrow("missing a non-empty issue.id");
    });
    for (const issue of [{ id: 42 }, { id: "" }, { id: "   " }]) {
      await runFixture([{ workspaceId, sourceBuildId, issue }], async (client) => {
        await expect(client.query(migrationSql)).rejects.toThrow("missing a non-empty issue.id");
      });
    }
    await runFixture([
      { workspaceId, sourceBuildId, issue: { id: "lint-duplicate" } },
      { workspaceId, sourceBuildId, issue: { id: "lint-duplicate" } }
    ], async (client) => {
      await expect(client.query(migrationSql)).rejects.toThrow("duplicate issue identities");
    });
  }, 30_000);

  test(databaseUrl
    ? "persists only hashed opaque session records and revokes them transactionally"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const store = new PostgresAppStore(pool);
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const sessions = new PostgresSessionStore(pool);
    const idHash = createHash("sha256").update("opaque-session-id").digest("hex");
    await sessions.create({
      idHash,
      userId: setup!.admin.id,
      workspaceId: setup!.workspace.id,
      csrfSecretHash: createHash("sha256").update("csrf-nonce").digest("hex"),
      sessionVersion: setup!.admin.sessionVersion,
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null
    });

    await expect(sessions.findActive(idHash)).resolves.toMatchObject({
      userId: setup!.admin.id,
      workspaceId: setup!.workspace.id
    });
    const persisted = await pool.query<{ id_hash: string; csrf_secret_hash: string }>(
      "SELECT id_hash, csrf_secret_hash FROM auth_sessions WHERE id_hash = $1", [idHash]
    );
    expect(persisted.rows[0]).toMatchObject({ id_hash: idHash });
    expect(JSON.stringify(persisted.rows[0])).not.toContain("opaque-session-id");
    await sessions.revoke(idHash);
    await expect(sessions.findActive(idHash)).resolves.toBeNull();
  }, 30_000);

  test(databaseUrl
    ? "persists encrypted MFA state, one-time recovery hashes, and the lockout counter"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const store = new PostgresAppStore(pool);
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    const pending = await store.savePendingAdminMfa(setup!.workspace.id, setup!.admin.id, "encrypted-secret");
    expect(pending).toMatchObject({ enabledAt: null, failedAttempts: 0 });
    const enabled = await store.enableAdminMfa(
      setup!.workspace.id, setup!.admin.id, ["scrypt$test$hash"], setup!.admin.id
    );
    expect(enabled).toMatchObject({ enabledAt: expect.any(Date) });
    expect(await store.listActiveAdminMfaRecoveryCodes(setup!.workspace.id, setup!.admin.id))
      .toHaveLength(1);
    let state = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      state = await store.recordAdminMfaFailure(setup!.workspace.id, setup!.admin.id, new Date("2026-07-14T00:00:00.000Z"));
    }
    expect(state).toMatchObject({ failedAttempts: 5, lockedUntil: expect.any(Date) });
    const [recovery] = await store.listActiveAdminMfaRecoveryCodes(setup!.workspace.id, setup!.admin.id);
    await expect(store.consumeAdminMfaRecoveryCode(setup!.workspace.id, setup!.admin.id, recovery.id)).resolves.toBe(true);
    await expect(store.consumeAdminMfaRecoveryCode(setup!.workspace.id, setup!.admin.id, recovery.id)).resolves.toBe(false);
  }, 30_000);

  test(databaseUrl
    ? "isolates stage artifacts, claims queued work once, and retains published artifacts"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const store = new PostgresAppStore(pool);
    const setup = await store.createInitialSetup("pipeline@example.com", "hash");
    const repository = await store.createRepository(setup!.workspace.id, { kind: "upload", name: "Pipeline" });
    const snapshotId = randomUUID();
    await store.createSnapshot({
      snapshot: {
        id: snapshotId, workspaceId: setup!.workspace.id, repositoryId: repository!.id,
        commitSha: "a".repeat(40), ref: "upload", remoteUrl: null,
        commitTimestamp: new Date("2026-07-14T00:00:00.000Z"), storagePath: "/tmp/pipeline-snapshot"
      },
      files: []
    });
    const build = await store.createBuild({
      workspaceId: setup!.workspace.id, repositoryId: repository!.id, snapshotId,
      snapshotPath: "/tmp/pipeline-snapshot", commitSha: "a".repeat(40)
    });
    const baseStage = {
      workspaceId: setup!.workspace.id, projectId: repository!.projectId, snapshotId, buildId: build.build.id,
      attempt: 1, inputDigest: "b".repeat(64)
    };
    const convert = await store.createStageRun({ ...baseStage, stage: "convert" });
    const replayedConvert = await store.createStageRun({ ...baseStage, stage: "convert" });
    expect(replayedConvert.id).toBe(convert.id);
    await store.createStageRun({ ...baseStage, stage: "extract" });
    await expect(store.listPipelineStageEvents(
      setup!.workspace.id, repository!.projectId, build.build.id, 0
    )).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ stageRunId: convert.id, stage: "convert", status: "queued" })
    ]));
    const [firstClaim, secondClaim] = await Promise.all([
      store.claimNextStageRun(setup!.workspace.id, repository!.projectId, {
        buildId: build.build.id,
        stage: "convert"
      }),
      store.claimNextStageRun(setup!.workspace.id, repository!.projectId)
    ]);
    expect(firstClaim).toMatchObject({ status: "running" });
    expect(secondClaim).toMatchObject({ status: "running" });
    expect(firstClaim?.id).not.toBe(secondClaim?.id);
    const stageEvents = await store.listPipelineStageEvents(
      setup!.workspace.id, repository!.projectId, build.build.id, 0
    );
    expect(stageEvents.map((event) => event.sequence)).toEqual([...stageEvents]
      .map((event) => event.sequence).sort((left, right) => left - right));
    expect(stageEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ stageRunId: convert.id, status: "running" })
    ]));

    const artifact = {
      id: randomUUID(), workspaceId: setup!.workspace.id, projectId: repository!.projectId, snapshotId, buildId: build.build.id,
      stage: "convert" as const, kind: "normalized-source", schemaVersion: 1, inputDigest: "c".repeat(64), contentDigest: "d".repeat(64),
      storageKey: `${repository!.projectId}/${snapshotId}/convert/${"d".repeat(64)}.json`, sourceRefs: [], producer: "deterministic" as const,
      createdAt: "2026-07-14T00:00:00.000Z"
    };
    await expect(store.createArtifactWithAudit(artifact, setup!.admin.id)).resolves.toMatchObject({ id: artifact.id });
    await expect(store.findReusableArtifact(
      setup!.workspace.id, repository!.projectId, snapshotId, "convert", "normalized-source", artifact.inputDigest
    )).resolves.toMatchObject({ id: artifact.id });
    await expect(store.createArtifactWithAudit({ ...artifact, id: randomUUID() }, setup!.admin.id))
      .resolves.toMatchObject({ id: artifact.id });

    const searchDocument = {
      documentKey: "overview:0", kind: "page" as const, title: "Overview", content: "Pipeline overview",
      citations: [], metadata: { source: "integration" }
    };
    await expect(store.savePipelineSearchDocuments({
      workspaceId: setup!.workspace.id, projectId: repository!.projectId, snapshotId,
      buildId: build.build.id, sourceArtifactId: artifact.id, documents: [searchDocument]
    })).resolves.toHaveLength(1);

    const otherProject = await store.createProject(
      setup!.workspace.id, { name: "Other pipeline", slug: "other-pipeline" }, setup!.admin.id
    );
    await expect(store.createStageRun({ ...baseStage, projectId: otherProject!.id, stage: "tables" }))
      .rejects.toThrow("Stage run does not match");

    await store.transitionBuild(build.build.id, "queued", "ready");
    const release = await store.createReleaseDraft(setup!.workspace.id, repository!.id, build.build.id, "1.0.0");
    await store.publishRelease(setup!.workspace.id, release.id);
    const { build: reusedBuild, created } = await store.createBuild({
      workspaceId: setup!.workspace.id, repositoryId: repository!.id, snapshotId,
      snapshotPath: "/tmp/pipeline-snapshot", commitSha: "a".repeat(40)
    });
    expect(created).toBe(true);
    await expect(store.savePipelineSearchDocuments({
      workspaceId: setup!.workspace.id, projectId: repository!.projectId, snapshotId,
      buildId: reusedBuild.id, sourceArtifactId: artifact.id, documents: [searchDocument]
    })).resolves.toHaveLength(1);
    const queuedReuse = await store.createStageRun({
      ...baseStage, buildId: reusedBuild.id, stage: "convert"
    });
    await expect(store.cancelPipelineStageRuns(
      setup!.workspace.id, repository!.projectId, reusedBuild.id
    )).resolves.toEqual([expect.objectContaining({ id: queuedReuse.id, status: "cancelled" })]);
    await expect(store.currentRelease(setup!.workspace.id, repository!.id))
      .resolves.toMatchObject({ id: release.id, kernelMode: "legacy" });

    const packageArtifact = await store.createArtifactWithAudit({
      ...artifact,
      id: randomUUID(),
      stage: "package",
      kind: "pipeline-package",
      inputDigest: "e".repeat(64),
      contentDigest: "f".repeat(64),
      storageKey: `${repository!.projectId}/${snapshotId}/package/${"f".repeat(64)}.json`
    }, setup!.admin.id);
    await expect(pool.query(
      "UPDATE releases SET kernel_mode = 'pipeline', package_artifact_id = $1 WHERE id = $2",
      [packageArtifact.id, release.id]
    )).rejects.toThrow("Release pipeline provenance is immutable");
    await expect(pool.query("DELETE FROM knowledge_artifacts WHERE id = $1", [artifact.id]))
      .rejects.toThrow("Cannot delete artifacts from a published build");
  }, 30_000);

  test(databaseUrl
    ? "runs and reuses all ten shadow stages with PostgreSQL persistence"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-postgres-pipeline-source-"));
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-postgres-pipeline-artifacts-"));
    try {
      const sourcePath = "src/app.ts";
      const source = "export const answer = 42;\n";
      await mkdir(path.join(sourceRoot, "src"), { recursive: true });
      await writeFile(path.join(sourceRoot, sourcePath), source);

      const store = new PostgresAppStore(pool);
      const setup = await store.createInitialSetup("pipeline-worker@example.com", "hash");
      const project = (await store.listProjects(setup!.workspace.id))[0]!;
      const repository = await store.createRepository(
        setup!.workspace.id, { kind: "upload", name: "Pipeline source" }, project.id
      );
      const snapshotId = randomUUID();
      const snapshot = await store.createSnapshot({
        snapshot: {
          id: snapshotId,
          workspaceId: setup!.workspace.id,
          repositoryId: repository!.id,
          commitSha: "a".repeat(40),
          ref: "upload",
          remoteUrl: null,
          commitTimestamp: new Date("2026-07-16T00:00:00.000Z"),
          storagePath: sourceRoot
        },
        files: [{
          id: randomUUID(),
          workspaceId: setup!.workspace.id,
          snapshotId,
          path: sourcePath,
          byteSize: Buffer.byteLength(source),
          contentHash: createHash("sha256").update(source).digest("hex"),
          language: "typescript"
        }]
      });
      const artifactStore = new ArtifactStore(artifactRoot, store);
      await artifactStore.initialize();
      const queue = new RecordedPipelineQueue();
      const worker = new PipelineStageWorker(
        store,
        queue,
        createPipelineStageExecutor({
          convert: createNormalizedSourcesStageExecutor({ store, artifactStore }),
          extract: createKnowledgeIrStageExecutor({ store, artifactStore }),
          tables: createTableSchemasStageExecutor({ store, artifactStore }),
          graph: createKnowledgeGraphStageExecutor({ store, artifactStore }),
          synthesize: createKnowledgeSynthesisStageExecutor({ store, artifactStore }),
          index: createPipelineSearchIndexStageExecutor({ store, artifactStore }),
          lint: createKnowledgeQualityStageExecutor({ store, artifactStore }),
          viz: createKnowledgeVisualizationStageExecutor({ store, artifactStore }),
          validate: createKnowledgeValidationStageExecutor({ store, artifactStore }),
          package: createKnowledgePackageStageExecutor({ store, artifactStore })
        }),
        ["convert", "extract", "tables", "graph", "synthesize", "index", "lint", "viz", "validate", "package"],
        5_000,
        createB02StageInputPlanner(store)
      );
      const files = await store.listSnapshotFiles(setup!.workspace.id, snapshot.id);
      const runBuild = async () => {
        const { build } = await store.createBuild({
          workspaceId: setup!.workspace.id,
          repositoryId: repository!.id,
          snapshotId: snapshot.id,
          snapshotPath: snapshot.storagePath,
          commitSha: snapshot.commitSha
        });
        const queueStart = queue.sent.length;
        await worker.schedule({
          workspaceId: setup!.workspace.id,
          projectId: project.id,
          snapshotId: snapshot.id,
          buildId: build.id,
          inputDigest: normalizedSourcesPipelineInputDigest(snapshot, files, build.purpose)
        });
        for (let index = queueStart; index < queue.sent.length; index += 1) {
          await worker.process(queue.sent[index]!);
        }
        return build;
      };

      const firstBuild = await runBuild();
      expect((await store.listPipelineStageRuns(setup!.workspace.id, project.id, firstBuild.id))
        .map((run) => [run.stage, run.status]))
        .toEqual([
          ["convert", "succeeded"], ["extract", "succeeded"], ["tables", "succeeded"], ["graph", "succeeded"],
          ["synthesize", "succeeded"], ["index", "succeeded"], ["lint", "succeeded"], ["viz", "succeeded"],
          ["validate", "succeeded"], ["package", "succeeded"]
        ]);

      await store.transitionBuild(firstBuild.id, "queued", "ready");
      const release = await store.createReleaseDraft(setup!.workspace.id, repository!.id, firstBuild.id, "1.0.0");
      await store.publishRelease(setup!.workspace.id, release.id);
      const reusedBuild = await runBuild();
      expect((await store.listPipelineStageRuns(setup!.workspace.id, project.id, reusedBuild.id))
        .map((run) => [run.stage, run.status]))
        .toEqual([
          ["convert", "reused"], ["extract", "reused"], ["tables", "reused"], ["graph", "reused"],
          ["synthesize", "reused"], ["index", "reused"], ["lint", "reused"], ["viz", "reused"],
          ["validate", "reused"], ["package", "reused"]
        ]);
      await store.transitionBuild(reusedBuild.id, "queued", "ready");
      const firstConvert = (await store.listPipelineStageRuns(setup!.workspace.id, project.id, firstBuild.id))
        .find((run) => run.stage === "convert")!;
      const firstConvertArtifact = await store.findArtifactById(firstConvert.outputManifestIds[0]!);
      await rm(path.join(artifactRoot, firstConvertArtifact!.storageKey));

      const regeneratedBuild = await runBuild();
      expect((await store.listPipelineStageRuns(setup!.workspace.id, project.id, regeneratedBuild.id))
        .map((run) => [run.stage, run.status]))
        .toEqual([
          ["convert", "succeeded"], ["extract", "reused"], ["tables", "reused"], ["graph", "reused"],
          ["synthesize", "reused"], ["index", "reused"], ["lint", "reused"], ["viz", "reused"],
          ["validate", "reused"], ["package", "reused"]
        ]);
      await expect(store.currentRelease(setup!.workspace.id, repository!.id))
        .resolves.toMatchObject({ id: release.id, buildId: firstBuild.id, kernelMode: "legacy" });
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(artifactRoot, { recursive: true, force: true });
    }
  }, 60_000);

  test(databaseUrl
    ? "executes the legacy release backfill in batches and writes its report"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const reportDirectory = await mkdtemp(path.join(os.tmpdir(), "devkh-pipeline-backfill-"));
    const reportPath = path.join(reportDirectory, "report.json");
    try {
      const store = new PostgresAppStore(pool);
      const setup = await store.createInitialSetup("backfill@example.com", "hash");
      const repository = await store.createRepository(
        setup!.workspace.id, { kind: "upload", name: "Backfill source" }
      );
      const snapshotId = randomUUID();
      await store.createSnapshot({
        snapshot: {
          id: snapshotId,
          workspaceId: setup!.workspace.id,
          repositoryId: repository!.id,
          commitSha: "b".repeat(40),
          ref: "upload",
          remoteUrl: null,
          commitTimestamp: new Date("2026-07-16T00:00:00.000Z"),
          storagePath: "/tmp/backfill-snapshot"
        },
        files: []
      });
      const { build } = await store.createBuild({
        workspaceId: setup!.workspace.id,
        repositoryId: repository!.id,
        snapshotId,
        snapshotPath: "/tmp/backfill-snapshot",
        commitSha: "b".repeat(40)
      });
      await store.transitionBuild(build.id, "queued", "ready");
      const release = await store.createReleaseDraft(setup!.workspace.id, repository!.id, build.id, "1.0.0");
      await store.publishRelease(setup!.workspace.id, release.id);

      await execute(process.execPath, [path.resolve("scripts/backfill-pipeline-history.mjs")], {
        env: { ...process.env, DATABASE_URL: databaseUrl, PIPELINE_HISTORY_REPORT: reportPath }
      });

      await expect(readFile(reportPath, "utf8").then(JSON.parse)).resolves.toMatchObject({
        schemaVersion: 1,
        batchSize: 500,
        backfilled: 1,
        missingSnapshots: []
      });
      await expect(store.currentRelease(setup!.workspace.id, repository!.id))
        .resolves.toMatchObject({ id: release.id, kernelMode: "legacy", packageArtifactId: null });
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  }, 30_000);

  test(databaseUrl
    ? "persists project memberships, rejects cross-workspace users, and protects the final project administrator"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const store = new PostgresAppStore(pool);
    const setup = await store.createInitialSetup("admin@example.com", "hash");
    expect(await store.listActiveGitRepositories()).toEqual([]);
    const project = await store.createProject(setup!.workspace.id, { name: "Permissions", slug: "permissions" }, setup!.admin.id);
    const contributor = await store.createTeamMember(setup!.workspace.id, {
      email: "member@example.com", passwordHash: "hash", role: "member"
    }, setup!.admin.id);
    const disabledMember = await store.setTeamMemberDisabled(
      setup!.workspace.id, contributor!.id, true, setup!.admin.id
    );
    expect(disabledMember).toMatchObject({ id: contributor!.id, disabledAt: expect.any(Date), sessionVersion: 2 });
    expect(await store.findAdminById(contributor!.id, setup!.workspace.id))
      .toMatchObject({ disabledAt: expect.any(Date), sessionVersion: 2 });
    const enabledMember = await store.setTeamMemberDisabled(
      setup!.workspace.id, contributor!.id, false, setup!.admin.id
    );
    expect(enabledMember).toMatchObject({ id: contributor!.id, disabledAt: null, sessionVersion: 3 });
    expect(await store.projectAccess(setup!.workspace.id, project!.id, contributor!.id)).toBeNull();
    expect(await store.addProjectMember(
      setup!.workspace.id, project!.id, contributor!.id, "reader", setup!.admin.id
    )).toMatchObject({ id: contributor!.id, role: "reader" });
    expect(await store.projectAccess(setup!.workspace.id, project!.id, contributor!.id))
      .toMatchObject({ role: "reader" });
    const overview = await store.workspaceOverview(setup!.workspace.id, contributor!.id);
    expect(overview).toEqual([
      expect.objectContaining({ project: expect.objectContaining({ id: project!.id }), indexedTextBytes: 0 })
    ]);
    expect(await store.searchWorkspaceKnowledge(setup!.workspace.id, contributor!.id, "missing"))
      .toEqual([]);
    const repository = await store.createRepositoryWithAudit(setup!.workspace.id, {
      kind: "upload", name: "Permissions source"
    }, setup!.admin.id, project!.id);
    const connectedOverview = await store.workspaceOverview(setup!.workspace.id, contributor!.id);
    expect(connectedOverview).toEqual([
      expect.objectContaining({ repository: expect.objectContaining({ id: repository!.id, kind: "upload" }) })
    ]);

    await store.recordAudit({
      workspaceId: setup!.workspace.id,
      actorId: setup!.admin.id,
      action: "project.checked",
      resourceType: "project",
      resourceId: project!.id
    });
    expect(await store.listProjectActivity(setup!.workspace.id, project!.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "project.checked" })
    ]));
    expect(await store.countProjectActivity(setup!.workspace.id, project!.id)).toBeGreaterThan(0);

    const report = await store.createImportReport({
      workspaceId: setup!.workspace.id,
      projectId: project!.id,
      repositoryId: null,
      actorId: setup!.admin.id,
      sourceKind: "upload"
    });
    const completedReport = await store.finishImportReport(setup!.workspace.id, report.id, {
      status: "succeeded",
      collectedFileCount: 2,
      collectedTextBytes: 128,
      ignored: { total: 1, reasons: { generated: 1 } },
      snapshotId: null,
      failureCode: null
    });
    expect(completedReport).toMatchObject({ status: "succeeded", collectedTextBytes: 128 });
    expect(await store.listImportReports(setup!.workspace.id, project!.id)).toEqual([
      expect.objectContaining({ id: report.id, ignored: { total: 1, reasons: { generated: 1 } } })
    ]);

    const otherWorkspace = await pool.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug) VALUES ('Other', 'other') RETURNING id"
    );
    const outsider = await pool.query<{ id: string }>(
      `INSERT INTO admin_users (workspace_id, email, password_hash)
       VALUES ($1, 'outsider@example.com', 'hash') RETURNING id`,
      [otherWorkspace.rows[0].id]
    );
    await pool.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
      [otherWorkspace.rows[0].id, outsider.rows[0].id]
    );
    expect(await store.addProjectMember(
      setup!.workspace.id, project!.id, outsider.rows[0].id, "reader", setup!.admin.id
    )).toBeNull();

    await store.updateProjectMemberRole(
      setup!.workspace.id, project!.id, contributor!.id, "admin", setup!.admin.id
    );
    await store.removeProjectMember(setup!.workspace.id, project!.id, setup!.admin.id, setup!.admin.id);
    await expect(store.updateProjectMemberRole(
      setup!.workspace.id, project!.id, contributor!.id, "reader", contributor!.id
    )).rejects.toBeInstanceOf(LastProjectAdminError);
    const audit = await pool.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE workspace_id = $1 ORDER BY created_at, id",
      [setup!.workspace.id]
    );
    expect(audit.rows.map((row) => row.action)).toEqual(expect.arrayContaining([
      "project_member.added", "project_member.role_changed", "project_member.removed"
    ]));
  }, 30_000);

  test(databaseUrl
    ? "persists deterministic added, modified, and deleted files between snapshots"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const store = new PostgresAppStore(pool);
    const setup = await store.createInitialSetup("changes@example.com", "hash");
    const repository = await store.createRepository(setup!.workspace.id, { kind: "upload", name: "Changes" });
    const firstId = randomUUID();
    const secondId = randomUUID();
    await store.createSnapshot({
      snapshot: {
        id: firstId, workspaceId: setup!.workspace.id, repositoryId: repository!.id,
        commitSha: "a".repeat(40), ref: "main", remoteUrl: null,
        commitTimestamp: new Date("2026-01-01T00:00:00.000Z"), storagePath: "/tmp/changes-first"
      },
      files: [
        { id: randomUUID(), workspaceId: setup!.workspace.id, snapshotId: firstId, path: "src/kept.ts", byteSize: 3, contentHash: "one", language: "typescript" },
        { id: randomUUID(), workspaceId: setup!.workspace.id, snapshotId: firstId, path: "src/deleted.ts", byteSize: 3, contentHash: "old", language: "typescript" }
      ]
    });
    await store.createSnapshot({
      snapshot: {
        id: secondId, workspaceId: setup!.workspace.id, repositoryId: repository!.id,
        commitSha: "b".repeat(40), ref: "main", remoteUrl: null,
        commitTimestamp: new Date("2026-01-02T00:00:00.000Z"), storagePath: "/tmp/changes-second"
      },
      files: [
        { id: randomUUID(), workspaceId: setup!.workspace.id, snapshotId: secondId, path: "src/kept.ts", byteSize: 3, contentHash: "two", language: "typescript" },
        { id: randomUUID(), workspaceId: setup!.workspace.id, snapshotId: secondId, path: "src/added.ts", byteSize: 3, contentHash: "new", language: "typescript" }
      ]
    });

    await expect(store.snapshotChangeSummary(setup!.workspace.id, repository!.id, firstId))
      .resolves.toMatchObject({ previousSnapshotId: null, added: ["src/deleted.ts", "src/kept.ts"], modified: [], deleted: [], requiresBuild: true });
    await expect(store.snapshotChangeSummary(setup!.workspace.id, repository!.id, secondId))
      .resolves.toMatchObject({ previousSnapshotId: firstId, added: ["src/added.ts"], modified: ["src/kept.ts"], deleted: ["src/deleted.ts"], requiresBuild: true });
  }, 30_000);

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
      await pool.query("DELETE FROM pgboss.job WHERE name = $1", ["knowledge-build"]);
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
      const pendingJobs = await waitFor(
        async () => Number((await pool!.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM pgboss.job
           WHERE name = 'knowledge-build' AND singleton_key = $1 AND state = 'created'`,
          [undispatched.build.id]
        )).rows[0].count),
        (count) => count === 0
      );
      expect(pendingJobs).toBe(0);

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
      const cookie = authenticatedCookie(login);

      const response = await app.inject({
        method: "GET",
        url: "/api/releases/not-a-uuid",
        headers: { cookie, ...csrfHeaders(cookie) }
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

  test(databaseUrl
    ? "persists an accepted remediation build without changing the published release"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const store = new PostgresAppStore(pool);
    const setup = await store.createInitialSetup("remediation@example.com", "hash");
    const project = (await store.listProjects(setup!.workspace.id))[0];
    const repository = await store.createRepository(
      setup!.workspace.id, { kind: "upload", name: "Remediation source" }, project.id
    );
    const snapshotId = randomUUID();
    await store.createSnapshot({
      snapshot: {
        id: snapshotId, workspaceId: setup!.workspace.id, repositoryId: repository!.id,
        commitSha: "a".repeat(40), ref: "upload", remoteUrl: null,
        commitTimestamp: new Date("2026-07-15T00:00:00.000Z"), storagePath: "/tmp/remediation-snapshot"
      },
      files: []
    });
    const sourceBuild = await store.createBuild({
      workspaceId: setup!.workspace.id, repositoryId: repository!.id, snapshotId,
      snapshotPath: "/tmp/remediation-snapshot", commitSha: "a".repeat(40)
    });
    const remediation = await store.createRemediation({
      workspaceId: setup!.workspace.id, projectId: project.id, repositoryId: repository!.id,
      sourceBuildId: sourceBuild.build.id,
      issue: {
        id: "lint-coverage", buildId: sourceBuild.build.id, rule: "KNOWLEDGE_LOW_COVERAGE",
        severity: "warning", targetKind: "knowledge", targetId: "overview",
        message: "Knowledge coverage is low", sourceRefs: [], remediationState: "open"
      }
    });
    const replay = await store.createRemediation({
      workspaceId: setup!.workspace.id, projectId: project.id, repositoryId: repository!.id,
      sourceBuildId: sourceBuild.build.id,
      issue: {
        id: "lint-coverage", buildId: sourceBuild.build.id, rule: "KNOWLEDGE_LOW_COVERAGE",
        severity: "warning", targetKind: "knowledge", targetId: "overview",
        message: "Knowledge coverage is low", sourceRefs: [], remediationState: "open"
      }
    });
    expect(replay.id).toBe(remediation.id);
    await store.transitionRemediationWithAudit(
      setup!.workspace.id, remediation.id, "accepted", setup!.admin.id
    );
    const rebuild = await store.requestRemediationBuildWithAudit({
      workspaceId: setup!.workspace.id, remediationId: remediation.id, actorId: setup!.admin.id,
      build: {
        workspaceId: setup!.workspace.id, repositoryId: repository!.id, snapshotId,
        snapshotPath: "/tmp/remediation-snapshot", commitSha: "a".repeat(40)
      }
    });

    expect(rebuild.build.purpose).toMatchObject({
      kind: "remediation",
      remediationContext: [expect.objectContaining({ remediationId: remediation.id, issueId: "lint-coverage" })]
    });
    await expect(store.getRemediation(setup!.workspace.id, remediation.id)).resolves.toMatchObject({
      state: "rebuilding", rebuildBuildId: rebuild.build.id
    });
    await expect(store.listRemediationEvents(setup!.workspace.id, remediation.id)).resolves.toEqual([
      expect.objectContaining({ fromState: "open", toState: "accepted" }),
      expect.objectContaining({ fromState: "accepted", toState: "rebuilding" })
    ]);
    await expect(store.currentRelease(setup!.workspace.id, repository!.id)).resolves.toBeNull();
    await expect(store.getRemediation("00000000-0000-4000-8000-000000000000", remediation.id))
      .resolves.toBeNull();
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
