import { authenticatedCookie, csrfHeaders } from "../test-support/csrf";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
import { analyzeSnapshot, type CodeIndex } from "../knowledge/intelligence";
import { generateKnowledge } from "../knowledge/generator";
import {
  assertRetrievalQuality,
  evaluateRetrievalCasesWithDetails,
  parseRetrievalCases
} from "../knowledge/retrieval-evaluation-v2";
import { PgBossBuildJobQueue } from "../knowledge/job-queue";
import { ArtifactStore } from "../knowledge/pipeline/artifact-store";
import { BUILD_STAGES, type BuildStage } from "../knowledge/pipeline/contracts";
import { createNormalizedSourcesStageExecutor, normalizedSourcesPipelineInputDigest } from "../knowledge/pipeline/convert-stage";
import { createKnowledgeIrStageExecutor } from "../knowledge/pipeline/extract-stage";
import { createKnowledgeGraphStageExecutor } from "../knowledge/pipeline/graph-stage";
import { createPipelineSearchIndexStageExecutor } from "../knowledge/pipeline/index-stage";
import { createKnowledgePackageStageExecutor } from "../knowledge/pipeline/package-stage";
import { createKnowledgeQualityStageExecutor } from "../knowledge/pipeline/quality-stage";
import { createPipelineStageExecutor } from "../knowledge/pipeline/stage-executor";
import { createKnowledgeSynthesisStageExecutor } from "../knowledge/pipeline/synthesize-stage";
import { createTableSchemasStageExecutor } from "../knowledge/pipeline/tables-stage";
import { createKnowledgeValidationStageExecutor } from "../knowledge/pipeline/validate-stage";
import { createKnowledgeVisualizationStageExecutor } from "../knowledge/pipeline/viz-stage";
import {
  ARTIFACT_KINDS,
  EMPTY_FRONTEND_ANALYZER_MANIFEST_DIGEST,
  createVerifiedFrontendReleaseDraft
} from "../knowledge/frontend/compatibility";
import {
  createFrontendShadowStageExecutor,
  createFrontendShadowStageInputPlanner,
  createKnowledgeV1StoreView
} from "../knowledge/frontend/shadow-stage";
import { PipelineStageWorker, type PipelineStageJob, type PipelineStageJobQueue } from "../knowledge/pipeline/worker";
import { hashMcpToken } from "../mcp/auth";
import { PostgresSessionStore } from "../security/session-store";
import { importFolderFiles, type FolderUploadFile } from "../uploads/folder-import";
import { LastProjectAdminError } from "./store";
import { PostgresAppStore } from "./postgres-store";

const databaseUrl = process.env.TEST_DATABASE_URL
  ? requireIsolatedTestDatabase(process.env.TEST_DATABASE_URL)
  : undefined;
const integration = databaseUrl ? describe : describe.skip;
let pool: Pool | null = null;
let temporaryRoot: string | null = null;
const retrievalFixtureRoots: string[] = [];
const execute = promisify(execFile);

function schemaScopedDatabaseUrl(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

class RecordedPipelineQueue implements PipelineStageJobQueue {
  readonly sent: PipelineStageJob[] = [];

  async send(job: PipelineStageJob): Promise<void> {
    this.sent.push(job);
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

async function* phaseFSourceFiles(project: string, revision = "baseline"): AsyncGenerator<FolderUploadFile> {
  yield {
    path: `src/${project}.ts`,
    content: Buffer.from(`export const ${project.replace(/-/g, "_")} = "${project}-${revision}";\n`)
  };
  yield { path: "README.md", content: Buffer.from(`# ${project} ${revision}\n`) };
}

async function removeReadonlyDirectory(directory: string): Promise<void> {
  async function makeWritable(candidate: string): Promise<void> {
    await chmod(candidate, 0o700).catch(() => undefined);
    const entries = await readdir(candidate, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) =>
      makeWritable(path.join(candidate, entry.name))
    ));
  }
  await makeWritable(directory);
  await rm(directory, { recursive: true, force: true });
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
    ? "changes project frontend rollout and its audit event in one transaction"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const store = new PostgresAppStore(pool);
    const setup = await store.createInitialSetup("frontend-rollout@example.com", "hash");
    const project = (await store.listProjects(setup!.workspace.id))[0]!;
    const projectAdmin = await store.createTeamMember(
      setup!.workspace.id,
      { email: "frontend-project-admin@example.com", passwordHash: "hash", role: "member" },
      setup!.admin.id
    );
    await store.addProjectMember(
      setup!.workspace.id, project.id, projectAdmin!.id, "admin", setup!.admin.id
    );
    await expect(store.setProjectFrontendRollout({
      workspaceId: setup!.workspace.id,
      projectId: project.id,
      mode: "shadow",
      reason: "Project administrators cannot change workspace rollout",
      actorId: projectAdmin!.id
    })).resolves.toBeNull();

    await expect(store.setProjectFrontendRollout({
      workspaceId: setup!.workspace.id,
      projectId: project.id,
      mode: "shadow",
      reason: "Validate frontend-v2 artifacts",
      actorId: setup!.admin.id
    })).resolves.toMatchObject({ mode: "shadow", updatedBy: setup!.admin.id });
    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
       WHERE workspace_id = $1 AND action = 'frontend_rollout.changed'
       ORDER BY created_at DESC LIMIT 1`,
      [setup!.workspace.id]
    );
    expect(audit.rows[0]?.metadata).toMatchObject({
      projectId: project.id,
      fromMode: "legacy",
      toMode: "shadow",
      reason: "Validate frontend-v2 artifacts"
    });

    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_frontend_rollout_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'frontend_rollout.changed' THEN
          RAISE EXCEPTION 'frontend rollout audit unavailable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_frontend_rollout_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION reject_frontend_rollout_audit();
    `);
    try {
      await expect(store.setProjectFrontendRollout({
        workspaceId: setup!.workspace.id,
        projectId: project.id,
        mode: "legacy",
        reason: "This transaction must roll back",
        actorId: setup!.admin.id
      })).rejects.toThrow("frontend rollout audit unavailable");
      await expect(store.getProjectFrontendRollout(setup!.workspace.id, project.id))
        .resolves.toMatchObject({ mode: "shadow", reason: "Validate frontend-v2 artifacts" });
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS reject_frontend_rollout_audit ON audit_events");
      await pool.query("DROP FUNCTION IF EXISTS reject_frontend_rollout_audit()");
    }
  });

  test(databaseUrl
    ? "enforces the versioned retrieval quality gate through the PostgreSQL search implementation"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const store = new PostgresAppStore(pool);
    const setup = await store.createInitialSetup("retrieval-evaluation@example.com", "hash");
    const cases = parseRetrievalCases(await readFile(
      path.resolve("evaluation/knowledge-v2/cases.jsonl"), "utf8"
    ));
    const fixtureRoots = {
      "fixture-a": path.resolve("src/test/fixtures/code-intelligence"),
      "fixture-b": path.resolve("src/test/fixtures/knowledge-evaluation-b")
    };
    const fixtures = new Map<string, { repositoryId: string; releaseId: string }>();

    for (const [name, fixtureRoot] of Object.entries(fixtureRoots)) {
      const repositoryPath = await mkdtemp(path.join(os.tmpdir(), `devkh-retrieval-${name}-`));
      retrievalFixtureRoots.push(repositoryPath);
      await cp(fixtureRoot, repositoryPath, { recursive: true });
      await execute("git", ["init", "-b", "main"], { cwd: repositoryPath });
      await execute("git", ["config", "user.email", "retrieval@example.com"], { cwd: repositoryPath });
      await execute("git", ["config", "user.name", "Retrieval Evaluation"], { cwd: repositoryPath });
      await execute("git", ["add", "."], { cwd: repositoryPath });
      await execute("git", ["commit", "-m", "evaluation fixture"], { cwd: repositoryPath });

      const project = await store.createProject(setup!.workspace.id, {
        name: `Retrieval evaluation ${name}`,
        slug: `retrieval-${name}`
      }, setup!.admin.id);
      const repository = await store.createRepository(setup!.workspace.id, {
        kind: "local", name: `Retrieval evaluation ${name}`, path: repositoryPath
      }, project!.id);
      const summary = await syncRepository({
        repository: repository!, dataDir: path.join(repositoryPath, "data"), store
      });
      const snapshot = await store.findSnapshotById(setup!.workspace.id, summary.snapshotId);
      const index = await analyzeSnapshot(snapshot!.storagePath, snapshot!.commitSha);
      const build = (await store.createBuild({
        workspaceId: setup!.workspace.id,
        repositoryId: repository!.id,
        snapshotId: snapshot!.id,
        snapshotPath: snapshot!.storagePath,
        commitSha: snapshot!.commitSha
      })).build;
      await store.saveKnowledge({ build, index, output: await generateKnowledge(index) });
      await store.transitionBuild(build.id, "queued", "ready");
      const release = await store.createReleaseDraft(
        setup!.workspace.id, repository!.id, build.id, `retrieval-${name}`
      );
      await store.publishRelease(setup!.workspace.id, release!.id);
      fixtures.set(name, { repositoryId: repository!.id, releaseId: release!.id });
    }

    const report = await evaluateRetrievalCasesWithDetails(cases, (item) => {
      const fixture = fixtures.get(item.project);
      if (!fixture) throw new Error(`Unknown retrieval evaluation fixture: ${item.project}`);
      return store.searchKnowledge(setup!.workspace.id, fixture.repositoryId, item.query, fixture.releaseId);
    });
    expect(report.metrics.total).toBeGreaterThanOrEqual(140);
    expect(report.failures).toEqual([]);
    expect(() => assertRetrievalQuality(report)).not.toThrow();
  }, 90_000);

  test(databaseUrl
    ? "keeps overlapping PostgreSQL imports, queued builds, and searches project-isolated under the Phase F budget"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "devkh-phase-f-postgres-"));
    const store = new PostgresAppStore(pool);
    const queue = new PgBossBuildJobQueue(databaseUrl);
    const buildService = new BuildService(store, queue, { reconcileIntervalMs: 25 });
    try {
      await buildService.start();
      const setup = await store.createInitialSetup("phase-f-load@example.com", "hash");
      const workspaceId = setup!.workspace.id;
      const firstProject = (await store.listProjects(workspaceId))[0]!;
      const projects = [
        firstProject,
        (await store.createProject(workspaceId, { name: "Second project", slug: "second-project" }, setup!.admin.id))!,
        (await store.createProject(workspaceId, { name: "Third project", slug: "third-project" }, setup!.admin.id))!
      ];
      const repositories = await Promise.all(projects.map((project) => store.createRepository(
        workspaceId, { kind: "upload", name: project.slug }, project.id
      )));
      const importAndQueueBuild = async (repositoryIndex: number, revision: string) => {
        const snapshot = await importFolderFiles({
          files: phaseFSourceFiles(projects[repositoryIndex]!.slug, revision), dataDir, workspaceId,
          repositoryId: repositories[repositoryIndex]!.id, actorId: setup!.admin.id, store
        });
        const started = await buildService.startBuild({
          workspaceId, repositoryId: repositories[repositoryIndex]!.id, snapshotId: snapshot.snapshotId,
          snapshotPath: snapshot.storagePath, commitSha: snapshot.sourceVersion
        });
        const build = await waitFor(
          () => store.getBuild(workspaceId, started.build.id),
          (candidate) => candidate?.status === "ready"
        );
        return { snapshot, build: build! };
      };
      const baseline = await Promise.all([importAndQueueBuild(0, "baseline"), importAndQueueBuild(1, "baseline")]);
      await Promise.all(baseline.map(async ({ build }, index) => {
        const release = await store.createReleaseDraft(workspaceId, repositories[index]!.id, build.id, `1.0.${index}`);
        await store.publishRelease(workspaceId, release.id);
      }));

      const operationStartedAt = performance.now();
      const imports = repositories.map((repository, index) => importFolderFiles({
        files: phaseFSourceFiles(projects[index]!.slug, "updated"), dataDir, workspaceId, repositoryId: repository!.id,
        actorId: setup!.admin.id, store
      }));
      const queuedBuilds = imports.slice(0, 2).map(async (snapshotPromise, index) => {
        const snapshot = await snapshotPromise;
        const started = await buildService.startBuild({
          workspaceId, repositoryId: repositories[index]!.id, snapshotId: snapshot.snapshotId,
          snapshotPath: snapshot.storagePath, commitSha: snapshot.sourceVersion
        });
        return waitFor(
          () => store.getBuild(workspaceId, started.build.id),
          (candidate) => candidate?.status === "ready"
        );
      });
      const searches = Promise.all(Array.from({ length: 10 }, async (_, index) => {
        const repositoryIndex = index % 2;
        const searchStartedAt = performance.now();
        const results = await store.searchKnowledge(
          workspaceId, repositories[repositoryIndex]!.id, projects[repositoryIndex]!.slug
        );
        return { repositoryIndex, results, durationMs: performance.now() - searchStartedAt };
      }));
      const [completedImports, completedBuilds, completedSearches] = await Promise.all([
        Promise.all(imports), Promise.all(queuedBuilds), searches
      ]);
      const elapsedMs = performance.now() - operationStartedAt;
      expect(completedImports.map((item) => item.fileCount)).toEqual([2, 2, 2]);
      expect(new Set(completedImports.map((item) => item.snapshotId)).size).toBe(3);
      expect(completedBuilds).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "ready", repositoryId: repositories[0]!.id }),
        expect.objectContaining({ status: "ready", repositoryId: repositories[1]!.id })
      ]));
      const searchResults = await completedSearches;
      const durations = searchResults.map((search) => search.durationMs).sort((left, right) => left - right);
      const p95Ms = durations[Math.ceil(durations.length * 0.95) - 1]!;
      expect(searchResults).toHaveLength(10);
      expect(searchResults.every(({ results }) => results.length > 0)).toBe(true);
      expect(searchResults.filter(({ repositoryIndex }) => repositoryIndex === 0).every(({ results }) =>
        results.every((result) => result.citations.every((citation) => citation.path.includes("default-project")))
      )).toBe(true);
      expect(searchResults.filter(({ repositoryIndex }) => repositoryIndex === 1).every(({ results }) =>
        results.every((result) => result.citations.every((citation) => citation.path.includes("second-project")))
      )).toBe(true);
      expect(p95Ms).toBeLessThanOrEqual(1_000);
      expect(elapsedMs).toBeLessThanOrEqual(15_000);
      expect(process.memoryUsage().rss).toBeLessThanOrEqual(1.5 * 1024 * 1024 * 1024);
    } finally {
      await buildService.stop();
      await removeReadonlyDirectory(dataDir);
    }
  }, 30_000);

  test(databaseUrl
    ? "rolls back LLM builds when their audit event cannot be persisted and preserves allowLlm projections"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const store = new PostgresAppStore(pool);
    const setup = await store.createInitialSetup("llm-atomic@example.com", "hash");
    const repository = await store.createRepository(
      setup!.workspace.id, { kind: "upload", name: "LLM atomic source" }
    );
    const snapshotId = randomUUID();
    await store.createSnapshot({
      snapshot: {
        id: snapshotId,
        workspaceId: setup!.workspace.id,
        repositoryId: repository!.id,
        commitSha: "d".repeat(40),
        ref: "upload",
        remoteUrl: null,
        commitTimestamp: new Date("2026-07-16T00:00:00.000Z"),
        storagePath: "/tmp/llm-atomic-snapshot"
      },
      files: []
    });
    await pool.query(`
      CREATE FUNCTION reject_llm_build_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'build.llm_opted_in' THEN RAISE EXCEPTION 'audit unavailable'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_llm_build_audit
        BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION reject_llm_build_audit();
    `);
    const input = {
      workspaceId: setup!.workspace.id,
      repositoryId: repository!.id,
      snapshotId,
      snapshotPath: "/tmp/llm-atomic-snapshot",
      commitSha: "d".repeat(40),
      allowLlm: true,
      llmAudit: { actorId: setup!.admin.id, projectId: repository!.projectId }
    };
    try {
      await expect(store.createBuild(input)).rejects.toThrow("audit unavailable");
      await expect(store.listBuilds(setup!.workspace.id, repository!.id)).resolves.toEqual([]);
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS reject_llm_build_audit ON audit_events");
      await pool.query("DROP FUNCTION IF EXISTS reject_llm_build_audit()");
    }

    const { build } = await store.createBuild(input);
    expect((await store.listBuilds(setup!.workspace.id, repository!.id))[0]).toMatchObject({ id: build.id, allowLlm: true });
    expect(await store.listUnfinishedBuilds()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: build.id, allowLlm: true })
    ]));
    expect((await store.workspaceOverview(setup!.workspace.id, setup!.admin.id))[0]?.latestBuild)
      .toMatchObject({ id: build.id, allowLlm: true });
  }, 30_000);

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
    ? "upgrades published legacy and pipeline-package v1 releases from migration 0030 without changing them"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    const schema = `frontend_upgrade_${randomUUID().replaceAll("-", "")}`;
    const migrationRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-frontend-upgrade-"));
    await pool.query(`CREATE SCHEMA ${schema}`);
    const scopedPool = new Pool({ connectionString: schemaScopedDatabaseUrl(databaseUrl, schema) });
    try {
      const names = (await readdir(path.resolve("drizzle")))
        .filter((name) => name.endsWith(".sql") && Number(name.slice(0, 4)) <= 30)
        .sort();
      for (const name of names) await cp(path.resolve("drizzle", name), path.join(migrationRoot, name));
      await runMigrations(scopedPool, migrationRoot);

      const store = new PostgresAppStore(scopedPool);
      const setup = await store.createInitialSetup("frontend-upgrade@example.com", "hash");
      const repository = await store.createRepository(
        setup!.workspace.id, { kind: "upload", name: "Upgrade source" }
      );
      const snapshotId = randomUUID();
      await store.createSnapshot({
        snapshot: {
          id: snapshotId, workspaceId: setup!.workspace.id, repositoryId: repository!.id,
          commitSha: "a".repeat(40), ref: "upload", remoteUrl: null,
          commitTimestamp: new Date("2026-07-17T00:00:00.000Z"), storagePath: "/tmp/frontend-upgrade"
        },
        files: []
      });
      const createPublishedBuild = async () => {
        const { build } = await store.createBuild({
          workspaceId: setup!.workspace.id, repositoryId: repository!.id, snapshotId,
          snapshotPath: "/tmp/frontend-upgrade", commitSha: "a".repeat(40)
        });
        await scopedPool.query("UPDATE build_jobs SET status = 'published' WHERE id = $1", [build.id]);
        return build;
      };
      const legacyBuild = await createPublishedBuild();
      const pipelineBuild = await createPublishedBuild();
      const legacyReleaseId = randomUUID();
      const pipelineReleaseId = randomUUID();
      const packageArtifactId = randomUUID();
      await scopedPool.query(
        `INSERT INTO knowledge_artifacts
           (id, workspace_id, project_id, snapshot_id, build_job_id, stage, kind, schema_version,
            input_digest, content_digest, storage_key, source_refs, producer)
         VALUES ($1, $2, $3, $4, $5, 'package', 'pipeline-package', 1,
           $6, $7, $8, '[]'::jsonb, 'deterministic')`,
        [
          packageArtifactId, setup!.workspace.id, repository!.projectId, snapshotId, pipelineBuild.id,
          "b".repeat(64), "c".repeat(64), `${repository!.projectId}/${snapshotId}/package/${"c".repeat(64)}.json`
        ]
      );
      await scopedPool.query(
        `INSERT INTO releases
           (id, workspace_id, repository_id, build_job_id, snapshot_id, version, kernel_mode,
            package_artifact_id, published_at)
         VALUES
           ($1, $3, $4, $5, $6, 'legacy-before-0031', 'legacy', NULL, now()),
           ($2, $3, $4, $7, $6, 'pipeline-v1-before-0031', 'pipeline', $8, now())`,
        [
          legacyReleaseId, pipelineReleaseId, setup!.workspace.id, repository!.id,
          legacyBuild.id, snapshotId, pipelineBuild.id, packageArtifactId
        ]
      );
      await scopedPool.query(
        `INSERT INTO release_channels (workspace_id, repository_id, release_id, name)
         VALUES ($1, $2, $3, 'current')`,
        [setup!.workspace.id, repository!.id, pipelineReleaseId]
      );

      const migrationName = "0031_frontend_contracts_rollout.sql";
      await cp(path.resolve("drizzle", migrationName), path.join(migrationRoot, migrationName));
      await expect(runMigrations(scopedPool, migrationRoot)).resolves.toEqual([migrationName]);
      const releases = await scopedPool.query<{
        id: string; kernel_mode: string; package_artifact_id: string | null;
        release_artifact_family: string; package_stage_run_id: string | null;
      }>(
        `SELECT id, kernel_mode, package_artifact_id, release_artifact_family, package_stage_run_id
         FROM releases ORDER BY version`
      );
      expect(releases.rows).toEqual([
        {
          id: legacyReleaseId, kernel_mode: "legacy", package_artifact_id: null,
          release_artifact_family: "knowledge-v1", package_stage_run_id: null
        },
        {
          id: pipelineReleaseId, kernel_mode: "pipeline", package_artifact_id: packageArtifactId,
          release_artifact_family: "knowledge-v1", package_stage_run_id: null
        }
      ]);
      await expect(store.currentRelease(setup!.workspace.id, repository!.id)).resolves.toMatchObject({
        id: pipelineReleaseId,
        kernelMode: "pipeline",
        packageArtifactId,
        releaseArtifactFamily: "knowledge-v1"
      });
      await expect(store.rollbackReleaseToLegacy(
        setup!.workspace.id, legacyReleaseId, setup!.admin.id
      )).resolves.toMatchObject({ release: { id: legacyReleaseId }, previousReleaseId: pipelineReleaseId });
    } finally {
      await scopedPool.end();
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await rm(migrationRoot, { recursive: true, force: true });
    }
  }, 60_000);

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
    const staleThreshold = new Date(Date.now() - 60_000);
    expect(await store.listStaleRunningStageRuns(staleThreshold)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: convert.id })
    ]));
    await pool.query(
      "UPDATE build_stage_runs SET started_at = now() - interval '10 minutes' WHERE id = $1",
      [convert.id]
    );
    await expect(store.listStaleRunningStageRuns(staleThreshold)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: convert.id, status: "running" })
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
    await expect(store.createArtifactWithAudit({
      ...artifact,
      id: randomUUID(),
      inputDigest: "e".repeat(64)
    }, setup!.admin.id)).resolves.toMatchObject({ id: artifact.id });

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
    )).rejects.toThrow(/Release .* provenance is immutable/);
    await expect(pool.query("DELETE FROM knowledge_artifacts WHERE id = $1", [artifact.id]))
      .rejects.toThrow("Cannot delete artifacts from a published build");
  }, 30_000);

  test(databaseUrl
    ? "serves a successful comparison from persisted PostgreSQL shadow artifacts to a workspace administrator"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const store = new PostgresAppStore(pool);
    const artifactContents = new Map<string, unknown>();
    const app = buildServer({
      store,
      sessionStore: new PostgresSessionStore(pool),
      qualityArtifactReader: { getJson: async (artifact) => artifactContents.get(artifact.id) },
      masterKey: Buffer.alloc(32, 14).toString("base64"),
      sessionSecret: "postgres-comparison-route-session-secret",
      dataDir: "/tmp/devkh-postgres-comparison-route",
      nodeEnv: "test"
    });

    try {
      const setupResponse = await app.inject({
        method: "POST", url: "/api/setup",
        payload: { email: "comparison-admin@example.com", password: "correct horse battery staple" }
      });
      expect(setupResponse.statusCode).toBe(201);
      const login = await app.inject({
        method: "POST", url: "/api/session",
        payload: { email: "comparison-admin@example.com", password: "correct horse battery staple" }
      });
      const cookie = authenticatedCookie(login);
      const workspace = await store.defaultWorkspace();
      const administrator = await store.findAdminByEmail("comparison-admin@example.com");
      const repository = await store.createRepository(
        workspace!.id, { kind: "upload", name: "Comparison source" }
      );
      const snapshotId = randomUUID();
      const citation = {
        path: "src/math.ts", startLine: 1, endLine: 1,
        commitSha: "d".repeat(40), blobHash: "e".repeat(64)
      };
      await store.createSnapshot({
        snapshot: {
          id: snapshotId, workspaceId: workspace!.id, repositoryId: repository!.id,
          commitSha: citation.commitSha, ref: "upload", remoteUrl: null,
          commitTimestamp: new Date("2026-07-17T00:00:00.000Z"), storagePath: "/tmp/comparison-route"
        },
        files: [{
          id: randomUUID(), workspaceId: workspace!.id, snapshotId, path: citation.path,
          byteSize: 20, contentHash: citation.blobHash, language: "typescript"
        }]
      });
      const build = await store.createBuild({
        workspaceId: workspace!.id, repositoryId: repository!.id, snapshotId,
        snapshotPath: "/tmp/comparison-route", commitSha: citation.commitSha
      });
      const index: CodeIndex = {
        rootPath: "/tmp/comparison-route", commitSha: citation.commitSha, files: [citation],
        symbols: [{ ...citation, name: "math", kind: "module", exported: true }],
        edges: [], documents: [], configs: []
      };
      const output = await generateKnowledge(index);
      await store.saveKnowledge({ build: build.build, index, output });
      const moduleNodeId = "1".repeat(64);
      const symbolNodeId = "2".repeat(64);
      await store.saveKnowledgeGraph({
        workspaceId: workspace!.id, projectId: repository!.projectId, snapshotId, buildId: build.build.id,
        actorId: administrator!.id,
        graph: {
          nodes: [
            { id: moduleNodeId, projectId: repository!.projectId, snapshotId, kind: "module", name: "math.ts", qualifiedName: citation.path, candidate: false, sourceRefs: [{ ...citation, snapshotId }], attributes: {} },
            { id: symbolNodeId, projectId: repository!.projectId, snapshotId, kind: "symbol", name: "math", qualifiedName: "math", candidate: false, sourceRefs: [{ ...citation, snapshotId }], attributes: {} }
          ],
          edges: [{ id: "3".repeat(64), fromNodeId: moduleNodeId, toNodeId: symbolNodeId, kind: "contains", candidate: false, confidence: 1, sourceRefs: [{ ...citation, snapshotId }] }]
        }
      });
      const createArtifact = async (stage: "synthesize" | "lint", kind: "knowledge-pages" | "knowledge-quality", digest: string) => store.createArtifactWithAudit({
        id: randomUUID(), workspaceId: workspace!.id, projectId: repository!.projectId, snapshotId, buildId: build.build.id,
        stage, kind, schemaVersion: 1, inputDigest: digest, contentDigest: digest,
        storageKey: `${repository!.projectId}/${snapshotId}/${stage}/${digest}.json`, sourceRefs: [], producer: "deterministic",
        createdAt: new Date().toISOString()
      }, administrator!.id);
      const synthesis = await createArtifact("synthesize", "knowledge-pages", "1".repeat(64));
      const quality = await createArtifact("lint", "knowledge-quality", "2".repeat(64));
      artifactContents.set(synthesis.id, { schemaVersion: 1, output });
      artifactContents.set(quality.id, {
        trust: { targetKind: "knowledge", targetId: build.build.id, score: 0.95, citationScore: 1, parserScore: 1, freshnessScore: 1, lintPenalty: 0.05, reasons: ["integration"] },
        issues: []
      });
      const completeArtifactStage = async (stage: "synthesize" | "lint", artifactId: string, digest: string) => {
        const run = await store.createStageRun({
          workspaceId: workspace!.id, projectId: repository!.projectId, snapshotId, buildId: build.build.id,
          stage, attempt: 1, inputDigest: digest
        });
        const claimed = await store.claimNextStageRun(workspace!.id, repository!.projectId, { buildId: build.build.id, stage });
        expect(claimed?.id).toBe(run.id);
        await store.completeStageRunAndCreateNext({
          workspaceId: workspace!.id, projectId: repository!.projectId, stageRunId: run.id,
          status: "succeeded", outputManifestIds: [artifactId]
        });
      };
      await completeArtifactStage("synthesize", synthesis.id, "3".repeat(64));
      await completeArtifactStage("lint", quality.id, "4".repeat(64));
      await store.savePipelineSearchDocuments({
        workspaceId: workspace!.id, projectId: repository!.projectId, snapshotId, buildId: build.build.id,
        sourceArtifactId: synthesis.id,
        documents: output.pages.flatMap((page) => page.chunks.map((chunk, position) => ({
          documentKey: `${page.slug}:${position}`, kind: "page" as const, title: page.title, content: chunk.content,
          citations: chunk.citations.map((entry) => ({ ...entry, snapshotId })), metadata: {}
        })))
      });

      const response = await app.inject({
        method: "GET", url: `/api/builds/${build.build.id}/comparison`, headers: { cookie }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        buildId: build.build.id,
        comparison: { blockingDefects: [], citations: { valid: true } }
      });
    } finally {
      await app.close();
    }
  }, 30_000);

  test(databaseUrl
    ? "atomically persists the ready transition with its initial shadow stage"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const store = new PostgresAppStore(pool);
    const setup = await store.createInitialSetup("pipeline-finalize@example.com", "hash");
    const repository = await store.createRepository(
      setup!.workspace.id,
      { kind: "upload", name: "Finalized pipeline" }
    );
    const snapshotId = randomUUID();
    await store.createSnapshot({
      snapshot: {
        id: snapshotId,
        workspaceId: setup!.workspace.id,
        repositoryId: repository!.id,
        commitSha: "a".repeat(40),
        ref: "upload",
        remoteUrl: null,
        commitTimestamp: new Date("2026-07-16T00:00:00.000Z"),
        storagePath: "/tmp/pipeline-finalize-snapshot"
      },
      files: []
    });
    const { build } = await store.createBuild({
      workspaceId: setup!.workspace.id,
      repositoryId: repository!.id,
      snapshotId,
      snapshotPath: "/tmp/pipeline-finalize-snapshot",
      commitSha: "a".repeat(40)
    });
    for (const [from, to] of [["queued", "syncing"], ["syncing", "parsing"], ["parsing", "synthesizing"], ["synthesizing", "validating"]] as const) {
      await expect(store.transitionBuild(build.id, from, to)).resolves.toMatchObject({ status: to });
    }

    await pool.query(`
      CREATE FUNCTION reject_initial_stage() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'initial stage unavailable';
      END
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_initial_stage_insert
      BEFORE INSERT ON build_stage_runs
      FOR EACH ROW EXECUTE FUNCTION reject_initial_stage();
    `);
    await expect(store.transitionBuildAndCreateInitialStage(
      build.id,
      "validating",
      "ready",
      { requireNotCancelled: true },
      { inputDigest: "b".repeat(64) }
    )).rejects.toThrow("initial stage unavailable");
    await pool.query("DROP TRIGGER reject_initial_stage_insert ON build_stage_runs");
    await pool.query("DROP FUNCTION reject_initial_stage()");
    await expect(store.getBuild(setup!.workspace.id, build.id)).resolves.toMatchObject({ status: "validating" });
    await expect(store.listPipelineStageRuns(
      setup!.workspace.id,
      repository!.projectId,
      build.id
    )).resolves.toEqual([]);

    await expect(store.transitionBuildAndCreateInitialStage(
      build.id,
      "validating",
      "ready",
      { requireNotCancelled: true },
      { inputDigest: "b".repeat(64) }
    )).resolves.toMatchObject({ build: { status: "ready" } });
    await expect(store.listPipelineStageRuns(
      setup!.workspace.id,
      repository!.projectId,
      build.id
    )).resolves.toEqual([
      expect.objectContaining({ stage: "convert", attempt: 1, status: "queued", inputDigest: "b".repeat(64) })
    ]);
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
      const knowledgeV1Store = createKnowledgeV1StoreView(store);
      const legacyExecutor = createPipelineStageExecutor({
        convert: createNormalizedSourcesStageExecutor({ store: knowledgeV1Store, artifactStore }),
        extract: createKnowledgeIrStageExecutor({ store: knowledgeV1Store, artifactStore }),
        tables: createTableSchemasStageExecutor({ store: knowledgeV1Store, artifactStore }),
        graph: createKnowledgeGraphStageExecutor({ store: knowledgeV1Store, artifactStore }),
        synthesize: createKnowledgeSynthesisStageExecutor({ store: knowledgeV1Store, artifactStore }),
        index: createPipelineSearchIndexStageExecutor({ store: knowledgeV1Store, artifactStore }),
        lint: createKnowledgeQualityStageExecutor({ store: knowledgeV1Store, artifactStore }),
        viz: createKnowledgeVisualizationStageExecutor({ store: knowledgeV1Store, artifactStore }),
        validate: createKnowledgeValidationStageExecutor({ store: knowledgeV1Store, artifactStore }),
        package: createKnowledgePackageStageExecutor({ store: knowledgeV1Store, artifactStore })
      });
      const worker = new PipelineStageWorker(
        store,
        queue,
        createFrontendShadowStageExecutor({ store, artifactStore, legacy: legacyExecutor }),
        ["convert", "extract", "tables", "graph", "synthesize", "index", "lint", "viz", "validate", "package"],
        5_000,
        createFrontendShadowStageInputPlanner(store)
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
          const delivery = queue.sent[index]!;
          await Promise.all([worker.process(delivery), worker.process(delivery)]);
        }
        return build;
      };

      const firstBuild = await runBuild();
      const firstRuns = await store.listPipelineStageRuns(setup!.workspace.id, project.id, firstBuild.id);
      expect(firstRuns.map((run) => ({ stage: run.stage, status: run.status, errorDetail: run.errorDetail })))
        .toEqual([
          { stage: "convert", status: "succeeded", errorDetail: null },
          { stage: "extract", status: "succeeded", errorDetail: null },
          { stage: "tables", status: "succeeded", errorDetail: null },
          { stage: "graph", status: "succeeded", errorDetail: null },
          { stage: "synthesize", status: "succeeded", errorDetail: null },
          { stage: "index", status: "succeeded", errorDetail: null },
          { stage: "lint", status: "succeeded", errorDetail: null },
          { stage: "viz", status: "succeeded", errorDetail: null },
          { stage: "validate", status: "succeeded", errorDetail: null },
          { stage: "package", status: "succeeded", errorDetail: null }
        ]);
      for (const run of firstRuns) {
        const manifests = await Promise.all(run.outputManifestIds.map((id) => store.findArtifactById(id)));
        expect(manifests).toHaveLength(run.stage === "convert" ? 1 : 2);
        for (const family of ["knowledge-v1", "frontend-v2"] as const) {
          const expected = ARTIFACT_KINDS[run.stage][family];
          expect(manifests).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: expected.kind, schemaVersion: expected.schemaVersion })
          ]));
        }
      }

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
      const reusedPackageRun = (await store.listPipelineStageRuns(
        setup!.workspace.id, project.id, reusedBuild.id
      )).find((run) => run.stage === "package")!;
      const reusedPackageArtifact = (await Promise.all(reusedPackageRun.outputManifestIds.map((id) =>
        store.findArtifactById(id)
      ))).find((manifest) => manifest?.kind === "frontend-pipeline-package")!;
      await expect(createVerifiedFrontendReleaseDraft({
        store, artifactReader: artifactStore, workspaceId: setup!.workspace.id,
        repositoryId: repository!.id, buildId: reusedBuild.id, version: "frontend-v2-reused",
        packageStageRunId: reusedPackageRun.id, packageArtifactId: reusedPackageArtifact.id
      })).resolves.toMatchObject({
        releaseArtifactFamily: "frontend-v2",
        buildId: reusedBuild.id,
        packageArtifactId: reusedPackageArtifact.id
      });
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
    ? "retains legacy release provenance and reports absent build snapshots without mutations"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const reportDirectory = await mkdtemp(path.join(os.tmpdir(), "devkh-pipeline-backfill-"));
    const reportName = "report.json";
    const reportPath = path.join(reportDirectory, "reports", reportName);
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
      await pool.query("UPDATE build_jobs SET snapshot_id = NULL WHERE id = $1", [build.id]);
      await pool.query(
        `WITH generated_builds AS (
           INSERT INTO build_jobs
             (workspace_id, repository_id, snapshot_id, snapshot_path, commit_sha, status)
           SELECT $1, $2, $3, '/tmp/backfill-snapshot', repeat('c', 40), 'queued'
           FROM generate_series(1, 501)
           RETURNING id, snapshot_id
         )
         INSERT INTO releases (workspace_id, repository_id, build_job_id, snapshot_id, version)
         SELECT $1, $2, id, snapshot_id, 'legacy-batch-' || row_number() OVER ()
         FROM generated_builds`,
        [setup!.workspace.id, repository!.id, snapshotId]
      );
      await pool.query(`
        CREATE FUNCTION reject_pipeline_history_release_updates()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'pipeline history backfill must not update releases';
        END;
        $$;
        CREATE TRIGGER reject_pipeline_history_release_updates
          BEFORE INSERT OR UPDATE OR DELETE ON releases
          FOR EACH ROW EXECUTE FUNCTION reject_pipeline_history_release_updates();
      `);

      await execute(process.execPath, [path.resolve("scripts/backfill-pipeline-history.mjs")], {
        env: {
          ...process.env, DATABASE_URL: databaseUrl,
          DEVKH_DATA_DIR: reportDirectory, PIPELINE_HISTORY_REPORT: reportName
        }
      });
      const firstReport = await readFile(reportPath, "utf8");
      expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
      await execute(process.execPath, [path.resolve("scripts/backfill-pipeline-history.mjs")], {
        env: {
          ...process.env, DATABASE_URL: databaseUrl,
          DEVKH_DATA_DIR: reportDirectory, PIPELINE_HISTORY_REPORT: reportName
        }
      });

      expect(await readFile(reportPath, "utf8")).toBe(firstReport);
      expect(JSON.parse(firstReport)).toEqual({
        schemaVersion: 2,
        policy: "legacy-provenance-only",
        batchSize: 500,
        legacyReleasesRetained: 502,
        missingSnapshots: [{
          releaseId: release.id,
          workspaceId: setup!.workspace.id,
          buildId: build.id,
          snapshotId: null
        }]
      });
      await expect(store.currentRelease(setup!.workspace.id, repository!.id))
        .resolves.toMatchObject({ id: release.id, kernelMode: "legacy", packageArtifactId: null });
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS reject_pipeline_history_release_updates ON releases");
      await pool.query("DROP FUNCTION IF EXISTS reject_pipeline_history_release_updates()");
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

  test(databaseUrl
    ? "claims scheduled Git synchronization once across store instances and preserves retry timing"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const firstStore = new PostgresAppStore(pool);
    const secondStore = new PostgresAppStore(pool);
    const setup = await firstStore.createInitialSetup("git-schedule@example.com", "hash");
    const project = (await firstStore.listProjects(setup!.workspace.id))[0];
    const repository = await firstStore.createRepository(setup!.workspace.id, {
      kind: "git", name: "Scheduled Git source", url: "https://github.com/example/scheduled-source.git"
    }, project.id);
    const now = new Date();

    const [firstClaims, secondClaims] = await Promise.all([
      firstStore.claimDueGitSynchronizations(now, 10, 60_000),
      secondStore.claimDueGitSynchronizations(now, 10, 60_000)
    ]);
    const claims = [...firstClaims, ...secondClaims];
    expect(claims).toHaveLength(1);
    expect(claims[0]?.repository.id).toBe(repository!.id);

    await expect(firstStore.finishGitSynchronization({
      repositoryId: repository!.id,
      leaseToken: claims[0]!.leaseToken,
      status: "failed",
      failureCode: "GIT_SYNC_TIMEOUT",
      now
    })).resolves.toBe(true);
    const afterFailure = await pool.query<{ failure_count: number; next_attempt_at: Date }>(
      `SELECT failure_count, next_attempt_at
       FROM repository_sync_schedules WHERE repository_id = $1`,
      [repository!.id]
    );
    expect(afterFailure.rows[0]).toMatchObject({ failure_count: 1 });
    expect(afterFailure.rows[0]!.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    await expect(secondStore.claimDueGitSynchronizations(new Date(), 10, 60_000)).resolves.toEqual([]);
    await pool.query(
      "UPDATE repository_sync_schedules SET next_attempt_at = clock_timestamp() WHERE repository_id = $1",
      [repository!.id]
    );

    const [retry] = await secondStore.claimDueGitSynchronizations(new Date(), 10, 60_000);
    await expect(secondStore.finishGitSynchronization({
      repositoryId: repository!.id,
      leaseToken: retry!.leaseToken,
      status: "succeeded",
      now: new Date()
    })).resolves.toBe(true);
    const afterSuccess = await pool.query<{ failure_count: number; next_attempt_at: Date }>(
      `SELECT failure_count, next_attempt_at
       FROM repository_sync_schedules WHERE repository_id = $1`,
      [repository!.id]
    );
    expect(afterSuccess.rows[0]).toMatchObject({ failure_count: 0 });
    expect(afterSuccess.rows[0]!.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    await expect(firstStore.claimDueGitSynchronizations(
      new Date(), 10, 60_000
    )).resolves.toEqual([]);
  }, 30_000);

  test(databaseUrl
    ? "rolls current back to a legacy release atomically with its audit event"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const store = new PostgresAppStore(pool);
    const setup = await store.createInitialSetup("release-rollback@example.com", "hash");
    const repository = await store.createRepository(
      setup!.workspace.id, { kind: "upload", name: "Rollback source" }
    );
    const snapshotId = randomUUID();
    await store.createSnapshot({
      snapshot: {
        id: snapshotId, workspaceId: setup!.workspace.id, repositoryId: repository!.id,
        commitSha: "a".repeat(40), ref: "upload", remoteUrl: null,
        commitTimestamp: new Date("2026-07-17T00:00:00.000Z"), storagePath: "/tmp/release-rollback"
      },
      files: []
    });
    const createPublishedRelease = async (version: string) => {
      const build = await store.createBuild({
        workspaceId: setup!.workspace.id, repositoryId: repository!.id, snapshotId,
        snapshotPath: "/tmp/release-rollback", commitSha: version[0]!.repeat(40)
      });
      await store.transitionBuild(build.build.id, "queued", "ready");
      const release = await store.createReleaseDraft(
        setup!.workspace.id, repository!.id, build.build.id, version
      );
      await store.publishRelease(setup!.workspace.id, release.id);
      return release;
    };
    const legacy = await createPublishedRelease("1.0.0");
    const current = await createPublishedRelease("2.0.0");
    await pool.query(`
      CREATE FUNCTION reject_release_rollback_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'release.rolled_back' THEN RAISE EXCEPTION 'audit unavailable'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_release_rollback_audit
        BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION reject_release_rollback_audit();
    `);
    try {
      await expect(store.rollbackReleaseToLegacy(
        setup!.workspace.id, legacy.id, setup!.admin.id
      )).rejects.toThrow("audit unavailable");
      await expect(store.currentRelease(setup!.workspace.id, repository!.id))
        .resolves.toMatchObject({ id: current.id });
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS reject_release_rollback_audit ON audit_events");
      await pool.query("DROP FUNCTION IF EXISTS reject_release_rollback_audit()");
    }

    await expect(store.rollbackReleaseToLegacy(
      setup!.workspace.id, legacy.id, setup!.admin.id
    )).resolves.toMatchObject({ release: { id: legacy.id }, previousReleaseId: current.id });
    await expect(store.currentRelease(setup!.workspace.id, repository!.id))
      .resolves.toMatchObject({ id: legacy.id, kernelMode: "legacy" });
    await expect(store.rollbackReleaseToLegacy(
      setup!.workspace.id, legacy.id, setup!.admin.id
    )).resolves.toMatchObject({ release: { id: legacy.id }, previousReleaseId: legacy.id });
    const audit = await pool.query<{ action: string; resource_id: string; metadata: { previousReleaseId: string } }>(
      `SELECT action, resource_id, metadata FROM audit_events
       WHERE workspace_id = $1 AND action = 'release.rolled_back'`,
      [setup!.workspace.id]
    );
    expect(audit.rows).toEqual([expect.objectContaining({
      action: "release.rolled_back", resource_id: legacy.id,
      metadata: expect.objectContaining({ previousReleaseId: current.id })
    })]);
  }, 30_000);

  test(databaseUrl
    ? "enforces PostgreSQL-backed HTTP rollback authorization for anonymous, project, and workspace roles"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const store = new PostgresAppStore(pool);
    const app = buildServer({
      store,
      sessionStore: new PostgresSessionStore(pool),
      masterKey: Buffer.alloc(32, 12).toString("base64"),
      sessionSecret: "postgres-rollback-http-session-secret",
      dataDir: "/tmp/devkh-postgres-rollback-http",
      nodeEnv: "test"
    });

    try {
      const setupResponse = await app.inject({
        method: "POST", url: "/api/setup",
        payload: { email: "workspace-admin@example.com", password: "correct horse battery staple" }
      });
      expect(setupResponse.statusCode).toBe(201);
      const adminLogin = await app.inject({
        method: "POST", url: "/api/session",
        payload: { email: "workspace-admin@example.com", password: "correct horse battery staple" }
      });
      const adminCookie = authenticatedCookie(adminLogin);
      const workspace = await store.defaultWorkspace();
      const repository = await store.createRepository(
        workspace!.id, { kind: "upload", name: "HTTP rollback source" }
      );
      const snapshotId = randomUUID();
      await store.createSnapshot({
        snapshot: {
          id: snapshotId, workspaceId: workspace!.id, repositoryId: repository!.id,
          commitSha: "c".repeat(40), ref: "upload", remoteUrl: null,
          commitTimestamp: new Date("2026-07-17T00:00:00.000Z"), storagePath: "/tmp/release-rollback-http"
        },
        files: []
      });
      const createPublishedRelease = async (version: string) => {
        const build = await store.createBuild({
          workspaceId: workspace!.id, repositoryId: repository!.id, snapshotId,
          snapshotPath: "/tmp/release-rollback-http", commitSha: version[0]!.repeat(40)
        });
        await store.transitionBuild(build.build.id, "queued", "ready");
        const release = await store.createReleaseDraft(workspace!.id, repository!.id, build.build.id, version);
        await store.publishRelease(workspace!.id, release.id);
        return release;
      };
      const legacy = await createPublishedRelease("1.0.0");
      const current = await createPublishedRelease("2.0.0");
      const memberResponse = await app.inject({
        method: "POST", url: "/api/members", headers: { cookie: adminCookie, ...csrfHeaders(adminCookie) },
        payload: { email: "project-admin@example.com", password: "correct horse battery staple", role: "member" }
      });
      expect(memberResponse.statusCode).toBe(201);
      const projectAdministratorId = memberResponse.json().member.id as string;
      const added = await app.inject({
        method: "POST", url: `/api/projects/${repository!.projectId}/members`, headers: { cookie: adminCookie, ...csrfHeaders(adminCookie) },
        payload: { userId: projectAdministratorId, role: "admin" }
      });
      expect(added.statusCode).toBe(201);
      const projectAdminLogin = await app.inject({
        method: "POST", url: "/api/session",
        payload: { email: "project-admin@example.com", password: "correct horse battery staple" }
      });
      const projectAdminCookie = authenticatedCookie(projectAdminLogin);

      const anonymous = await app.inject({ method: "POST", url: `/api/releases/${legacy.id}/rollback` });
      expect(anonymous.statusCode).toBe(401);
      const projectAdmin = await app.inject({
        method: "POST", url: `/api/releases/${legacy.id}/rollback`,
        headers: { cookie: projectAdminCookie, ...csrfHeaders(projectAdminCookie) }
      });
      expect(projectAdmin.statusCode).toBe(403);
      const workspaceAdmin = await app.inject({
        method: "POST", url: `/api/releases/${legacy.id}/rollback`,
        headers: { cookie: adminCookie, ...csrfHeaders(adminCookie) }
      });
      expect(workspaceAdmin.statusCode).toBe(200);
      expect(workspaceAdmin.json()).toMatchObject({ release: { id: legacy.id }, previousReleaseId: current.id });
    } finally {
      await app.close();
    }
  }, 30_000);

  test(databaseUrl
    ? "enforces reusable frontend v2 release provenance and physical package integrity"
    : "skipped explicitly: TEST_DATABASE_URL is not configured", async () => {
    if (!databaseUrl) return;
    pool ??= new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await pool.query("TRUNCATE workspaces CASCADE");
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "devkh-frontend-v2-artifacts-"));
    try {
      const store = new PostgresAppStore(pool);
      const setup = await store.createInitialSetup("frontend-v2-release@example.com", "hash");
      const repository = await store.createRepository(
        setup!.workspace.id, { kind: "upload", name: "Frontend v2 source" }
      );
      const snapshotId = randomUUID();
      await store.createSnapshot({
        snapshot: {
          id: snapshotId, workspaceId: setup!.workspace.id, repositoryId: repository!.id,
          commitSha: "f".repeat(40), ref: "upload", remoteUrl: null,
          commitTimestamp: new Date("2026-07-18T00:00:00.000Z"), storagePath: "/tmp/frontend-v2"
        },
        files: []
      });
      const artifactStore = new ArtifactStore(artifactRoot, store);
      await artifactStore.initialize();

      const createReadyBuildAndRun = async (artifactId?: string) => {
        const { build } = await store.createBuild({
          workspaceId: setup!.workspace.id, repositoryId: repository!.id, snapshotId,
          snapshotPath: "/tmp/frontend-v2", commitSha: "f".repeat(40)
        });
        const run = await store.createStageRun({
          workspaceId: setup!.workspace.id, projectId: repository!.projectId, snapshotId,
          buildId: build.id, stage: "package", attempt: 1, inputDigest: "9".repeat(64)
        });
        await store.claimStageRun(run.id, build.id, repository!.projectId);
        if (artifactId) {
          await store.completeStageRunAndCreateNext({
            workspaceId: setup!.workspace.id, projectId: repository!.projectId,
            stageRunId: run.id, status: "reused", outputManifestIds: [artifactId]
          });
        }
        await store.transitionBuild(build.id, "queued", "ready");
        return { build, run };
      };

      const first = await createReadyBuildAndRun();
      const packagedArtifacts = Object.fromEntries(await Promise.all(BUILD_STAGES.map(async (stage) => {
        const families = stage === "package"
          ? ["knowledge-v1"] as const
          : ["knowledge-v1", "frontend-v2"] as const;
        const contracts = [...new Map(families.map((family) => {
          const expected = ARTIFACT_KINDS[stage][family];
          return [`${expected.kind}@${expected.schemaVersion}`, expected] as const;
        })).values()];
        const manifests = await Promise.all(contracts.map(async (expected, index) => (await artifactStore.putJson({
          manifest: {
            id: randomUUID(), workspaceId: setup!.workspace.id, projectId: repository!.projectId,
            snapshotId, buildId: first.build.id, stage, kind: expected.kind,
            schemaVersion: expected.schemaVersion,
            inputDigest: createHash("sha256").update(`${stage}:${index}`).digest("hex"),
            contentDigest: "0".repeat(64), storageKey: "pending", sourceRefs: [],
            producer: "deterministic", createdAt: new Date().toISOString()
          },
          value: { schemaVersion: expected.schemaVersion, stage, kind: expected.kind }
        })).manifest));
        if (stage !== "package") {
          const stageRun = await store.createStageRun({
            workspaceId: setup!.workspace.id, projectId: repository!.projectId, snapshotId,
            buildId: first.build.id, stage, attempt: 1,
            inputDigest: createHash("sha256").update(`run:${stage}`).digest("hex")
          });
          await store.claimStageRun(stageRun.id, first.build.id, repository!.projectId);
          await store.completeStageRunAndCreateNext({
            workspaceId: setup!.workspace.id, projectId: repository!.projectId,
            stageRunId: stageRun.id, status: "succeeded",
            outputManifestIds: manifests.map((manifest) => manifest.id)
          });
        }
        return [stage, manifests.map((manifest) => manifest.id)] as const;
      }))) as Record<BuildStage, string[]>;
      const saved = await artifactStore.putJson({
        manifest: {
          id: randomUUID(), workspaceId: setup!.workspace.id, projectId: repository!.projectId,
          snapshotId, buildId: first.build.id, stage: "package", kind: "frontend-pipeline-package",
          schemaVersion: 2, inputDigest: "9".repeat(64), contentDigest: "0".repeat(64), storageKey: "pending",
          sourceRefs: [], producer: "deterministic", createdAt: new Date().toISOString()
        },
        value: {
          schemaVersion: 2, family: "frontend-v2", stage: "package", snapshotId,
          analyzerManifestDigest: EMPTY_FRONTEND_ANALYZER_MANIFEST_DIGEST,
          upstreamManifestIds: packagedArtifacts.validate,
          sourceArtifactId: packagedArtifacts.package[0]!,
          irSchemaVersion: 2, graphSchemaVersion: 2,
          artifacts: packagedArtifacts
        }
      });
      await store.completeStageRunAndCreateNext({
        workspaceId: setup!.workspace.id, projectId: repository!.projectId,
        stageRunId: first.run.id, status: "succeeded",
        outputManifestIds: [...packagedArtifacts.package, saved.manifest.id]
      });
      const firstRelease = await createVerifiedFrontendReleaseDraft({
        store, artifactReader: artifactStore, workspaceId: setup!.workspace.id,
        repositoryId: repository!.id, buildId: first.build.id, version: "frontend-v2.0.0",
        packageStageRunId: first.run.id, packageArtifactId: saved.manifest.id
      });
      expect(firstRelease).toMatchObject({
        releaseArtifactFamily: "frontend-v2",
        packageStageRunId: first.run.id,
        analyzerManifestDigest: EMPTY_FRONTEND_ANALYZER_MANIFEST_DIGEST
      });

      const insertRawRun = async (input: {
        attempt: number; status: string; artifactId: string;
        projectId?: string; snapshotId?: string; buildId?: string;
      }) => {
        const result = await pool!.query<{ id: string }>(
          `INSERT INTO build_stage_runs
             (workspace_id, project_id, snapshot_id, build_job_id, stage, attempt, status,
              input_digest, output_manifest_ids, finished_at)
           VALUES ($1, $2, $3, $4, 'package', $5, $6, $7, ARRAY[$8::uuid],
             CASE WHEN $6 IN ('succeeded', 'reused') THEN now() ELSE NULL END)
           RETURNING id`,
          [
            setup!.workspace.id, input.projectId ?? repository!.projectId,
            input.snapshotId ?? snapshotId, input.buildId ?? first.build.id,
            input.attempt, input.status, String(input.attempt).repeat(64).slice(0, 64), input.artifactId
          ]
        );
        return result.rows[0]!.id;
      };
      const expectInvalidRelease = async (input: {
        version: string; runId: string; artifactId: string;
        buildId?: string; snapshotId?: string;
      }) => expect(pool!.query(
        `INSERT INTO releases
           (workspace_id, repository_id, build_job_id, snapshot_id, version, kernel_mode,
            package_artifact_id, release_artifact_family, package_stage_run_id,
            frontend_ir_schema_version, frontend_graph_schema_version, analyzer_manifest_digest)
         VALUES ($1, $2, $3, $4, $5, 'pipeline', $6, 'frontend-v2', $7, 2, 2, $8)`,
        [
          setup!.workspace.id, repository!.id, input.buildId ?? first.build.id,
          input.snapshotId ?? snapshotId, input.version, input.artifactId, input.runId,
          EMPTY_FRONTEND_ANALYZER_MANIFEST_DIGEST
        ]
      )).rejects.toThrow();

      await expect(pool.query(
        `INSERT INTO releases
           (workspace_id, repository_id, build_job_id, snapshot_id, version, kernel_mode,
            package_artifact_id, release_artifact_family)
         VALUES ($1, $2, $3, $4, 'frontend-v2-partial', 'pipeline', $5, 'frontend-v2')`,
        [setup!.workspace.id, repository!.id, first.build.id, snapshotId, saved.manifest.id]
      )).rejects.toThrow();
      const queuedRunId = await insertRawRun({
        attempt: 2, status: "queued", artifactId: saved.manifest.id
      });
      await expectInvalidRelease({
        version: "frontend-v2-queued", runId: queuedRunId, artifactId: saved.manifest.id
      });
      for (const [attempt, status] of [[6, "running"], [7, "failed"], [8, "cancelled"]] as const) {
        const invalidStatusRunId = await insertRawRun({ attempt, status, artifactId: saved.manifest.id });
        await expectInvalidRelease({
          version: `frontend-v2-${status}`, runId: invalidStatusRunId, artifactId: saved.manifest.id
        });
      }
      const legacyPackage = await artifactStore.putJson({
        manifest: {
          ...saved.manifest,
          id: randomUUID(), kind: "pipeline-package", schemaVersion: 1,
          inputDigest: "8".repeat(64), contentDigest: "0".repeat(64), storageKey: "pending"
        },
        value: { schemaVersion: 1, kind: "legacy-package" }
      });
      const legacyPackageRunId = await insertRawRun({
        attempt: 3, status: "succeeded", artifactId: legacyPackage.manifest.id
      });
      await expectInvalidRelease({
        version: "frontend-v2-v1-package", runId: legacyPackageRunId,
        artifactId: legacyPackage.manifest.id
      });

      const otherSameProjectSnapshotId = randomUUID();
      await store.createSnapshot({
        snapshot: {
          id: otherSameProjectSnapshotId, workspaceId: setup!.workspace.id, repositoryId: repository!.id,
          commitSha: "d".repeat(40), ref: "upload", remoteUrl: null,
          commitTimestamp: new Date("2026-07-18T00:00:00.000Z"), storagePath: "/tmp/frontend-v2-snapshot"
        },
        files: []
      });
      const { build: otherSameProjectBuild } = await store.createBuild({
        workspaceId: setup!.workspace.id, repositoryId: repository!.id, snapshotId: otherSameProjectSnapshotId,
        snapshotPath: "/tmp/frontend-v2-snapshot", commitSha: "d".repeat(40)
      });
      const crossSnapshotArtifact = await artifactStore.putJson({
        manifest: {
          ...saved.manifest,
          id: randomUUID(), snapshotId: otherSameProjectSnapshotId, buildId: otherSameProjectBuild.id,
          inputDigest: "6".repeat(64), contentDigest: "0".repeat(64), storageKey: "pending"
        },
        value: { otherSnapshot: true }
      });
      const crossSnapshotRunId = await insertRawRun({
        attempt: 5, status: "succeeded", artifactId: crossSnapshotArtifact.manifest.id
      });
      await expectInvalidRelease({
        version: "frontend-v2-cross-snapshot", runId: crossSnapshotRunId,
        artifactId: crossSnapshotArtifact.manifest.id
      });

      const otherProject = await store.createProject(
        setup!.workspace.id, { name: "Other frontend project", slug: "other-frontend-project" }, setup!.admin.id
      );
      const otherRepository = await store.createRepository(
        setup!.workspace.id, { kind: "upload", name: "Other frontend source" }, otherProject!.id
      );
      const otherSnapshotId = randomUUID();
      await store.createSnapshot({
        snapshot: {
          id: otherSnapshotId, workspaceId: setup!.workspace.id, repositoryId: otherRepository!.id,
          commitSha: "e".repeat(40), ref: "upload", remoteUrl: null,
          commitTimestamp: new Date("2026-07-18T00:00:00.000Z"), storagePath: "/tmp/frontend-v2-other"
        },
        files: []
      });
      const { build: otherBuild } = await store.createBuild({
        workspaceId: setup!.workspace.id, repositoryId: otherRepository!.id, snapshotId: otherSnapshotId,
        snapshotPath: "/tmp/frontend-v2-other", commitSha: "e".repeat(40)
      });
      await store.transitionBuild(otherBuild.id, "queued", "ready");
      const otherArtifact = await artifactStore.putJson({
        manifest: {
          ...saved.manifest,
          id: randomUUID(), projectId: otherProject!.id, snapshotId: otherSnapshotId,
          buildId: otherBuild.id, inputDigest: "7".repeat(64), contentDigest: "0".repeat(64), storageKey: "pending"
        },
        value: { other: true }
      });
      const crossProjectRunId = await insertRawRun({
        attempt: 4, status: "succeeded", artifactId: otherArtifact.manifest.id
      });
      await expectInvalidRelease({
        version: "frontend-v2-cross-project", runId: crossProjectRunId,
        artifactId: otherArtifact.manifest.id
      });
      const forgedRunId = await insertRawRun({
        attempt: 1, status: "succeeded", artifactId: otherArtifact.manifest.id,
        projectId: repository!.projectId, snapshotId: otherSnapshotId, buildId: otherBuild.id
      });
      await expectInvalidRelease({
        version: "frontend-v2-forged-build", runId: forgedRunId,
        artifactId: otherArtifact.manifest.id, buildId: otherBuild.id, snapshotId: otherSnapshotId
      });

      for (const update of [
        ["workspace_id", randomUUID()], ["repository_id", randomUUID()],
        ["build_job_id", randomUUID()], ["snapshot_id", randomUUID()],
        ["kernel_mode", "legacy"], ["package_artifact_id", null],
        ["release_artifact_family", "knowledge-v1"], ["package_stage_run_id", null],
        ["frontend_ir_schema_version", 3], ["frontend_graph_schema_version", 3],
        ["analyzer_manifest_digest", "b".repeat(64)]
      ] as const) {
        await expect(pool.query(
          `UPDATE releases SET ${update[0]} = $1 WHERE id = $2`,
          [update[1], firstRelease.id]
        )).rejects.toThrow("Release frontend provenance is immutable");
      }

      const reused = await createReadyBuildAndRun(saved.manifest.id);
      const reusedRelease = await createVerifiedFrontendReleaseDraft({
        store, artifactReader: artifactStore, workspaceId: setup!.workspace.id,
        repositoryId: repository!.id, buildId: reused.build.id, version: "frontend-v2-reused",
        packageStageRunId: reused.run.id, packageArtifactId: saved.manifest.id
      });
      expect(reusedRelease.buildId).toBe(reused.build.id);
      await expect(pool.query(
        "UPDATE releases SET repository_id = $1 WHERE id = $2",
        [randomUUID(), reusedRelease.id]
      )).rejects.toThrow("Release frontend provenance is immutable");
      await expect(pool.query("DELETE FROM build_stage_runs WHERE id = $1", [reused.run.id]))
        .rejects.toThrow();
      await expect(pool.query("DELETE FROM knowledge_artifacts WHERE id = $1", [saved.manifest.id]))
        .rejects.toThrow();

      await rm(path.join(artifactStore.root, saved.manifest.storageKey));
      const missing = await createReadyBuildAndRun(saved.manifest.id);
      await expect(createVerifiedFrontendReleaseDraft({
        store, artifactReader: artifactStore, workspaceId: setup!.workspace.id,
        repositoryId: repository!.id, buildId: missing.build.id, version: "frontend-v2-missing",
        packageStageRunId: missing.run.id, packageArtifactId: saved.manifest.id
      })).rejects.toThrow("Artifact content is unavailable");
      const missingRelease = await pool.query(
        "SELECT 1 FROM releases WHERE repository_id = $1 AND version = 'frontend-v2-missing'",
        [repository!.id]
      );
      expect(missingRelease.rows).toEqual([]);
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

afterAll(async () => {
  if (pool) {
    await pool.query("DROP TRIGGER IF EXISTS fail_second_release_publish ON releases").catch(() => undefined);
    await pool.query("DROP FUNCTION IF EXISTS fail_second_release_publish()").catch(() => undefined);
  }
  await pool?.end();
  await Promise.all([
    ...(temporaryRoot ? [temporaryRoot] : []),
    ...retrievalFixtureRoots
  ].map((directory) => rm(directory, { recursive: true, force: true })));
});
