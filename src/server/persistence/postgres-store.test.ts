import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { SourceBlobStore } from "../uploads/source-blob-store.js";
import { PostgresAppStore } from "./postgres-store";

describe("PostgresAppStore source blob locking", () => {
  test("keeps the advisory lock and all catalog queries on one transaction client", async () => {
    const blobRow = {
      id: "33333333-3333-4333-8333-333333333333",
      workspace_id: "11111111-1111-4111-8111-111111111111",
      content_hash: "a".repeat(64),
      generation: 1,
      byte_size: "12",
      status: "active",
      storage_key: "blobs/workspace/aa/hash/1",
      fencing_token: null,
      tombstoned_at: null,
      trashed_at: null,
      deleted_at: null
    };
    const clientQuery = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      if (sql.includes("COALESCE(MAX(generation)")) return { rows: [{ next_generation: 1 }] };
      if (sql.includes("INSERT INTO source_blobs")) return { rows: [blobRow] };
      return { rows: [] };
    });
    const client = { query: clientQuery, release: vi.fn() };
    const poolQuery = vi.fn(async () => { throw new Error("pool query escaped source blob lock"); });
    const store = new PostgresAppStore({
      query: poolQuery,
      connect: vi.fn(async () => client)
    } as never);

    const created = await store.withSourceBlobLock(
      blobRow.workspace_id,
      blobRow.content_hash,
      async (catalog) => {
        expect(await catalog.findActive()).toBeNull();
        const generation = await catalog.nextGeneration();
        return catalog.create({
          workspaceId: blobRow.workspace_id,
          contentHash: blobRow.content_hash,
          generation,
          byteSize: 12,
          storageKey: blobRow.storage_key
        });
      }
    );

    expect(created).toMatchObject({ id: blobRow.id, generation: 1, byteSize: 12 });
    expect(poolQuery).not.toHaveBeenCalled();
    expect(clientQuery.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  test("keeps fenced GC transitions, reference checks, and inconsistency audit inside the blob lock transaction", async () => {
    const active = {
      id: "33333333-3333-4333-8333-333333333333",
      workspace_id: "11111111-1111-4111-8111-111111111111",
      content_hash: "a".repeat(64),
      generation: 1,
      byte_size: "12",
      status: "active",
      storage_key: `blobs/11111111-1111-4111-8111-111111111111/aa/${"a".repeat(64)}/1`,
      fencing_token: null,
      tombstoned_at: null,
      trashed_at: null,
      deleted_at: null
    };
    const fence = "44444444-4444-4444-8444-444444444444";
    const tombstonedAt = new Date("2026-07-20T00:00:00.000Z");
    const trashedAt = new Date("2026-07-20T01:00:00.000Z");
    const deletedAt = new Date("2026-07-20T02:00:00.000Z");
    const tombstoned = { ...active, status: "tombstoned", fencing_token: fence, tombstoned_at: tombstonedAt };
    const trash = { ...tombstoned, status: "trash", trashed_at: trashedAt };
    const deleted = { ...trash, status: "deleted", deleted_at: deletedAt };
    const clientQuery = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      if (sql.includes("count(*)::text AS reference_count")) return { rows: [{ reference_count: "0" }] };
      if (sql.includes("status = 'tombstoned'") && sql.includes("status = 'active'")) return { rows: [tombstoned] };
      if (sql.includes("status = 'trash'") && sql.includes("status = 'tombstoned'")) return { rows: [trash] };
      if (sql.includes("status = 'deleted'") && sql.includes("status = 'trash'")) return { rows: [deleted] };
      if (sql.includes("FROM source_blobs") && sql.includes("id = $3")) return { rows: [active] };
      return { rows: [] };
    });
    const client = { query: clientQuery, release: vi.fn() };
    const store = new PostgresAppStore({
      query: vi.fn(async () => { throw new Error("pool query escaped source blob lock"); }),
      connect: vi.fn(async () => client)
    } as never);

    await store.withSourceBlobLock(active.workspace_id, active.content_hash, async (catalog) => {
      await expect(catalog.findById(active.id)).resolves.toMatchObject({ id: active.id, status: "active" });
      await expect(catalog.countReferences(active.id)).resolves.toBe(0);
      await expect(catalog.tombstoneIfUnreferenced(active.id, fence, tombstonedAt))
        .resolves.toMatchObject({ status: "tombstoned", fencingToken: fence });
      await expect(catalog.markTrash(active.id, fence, trashedAt)).resolves.toMatchObject({ status: "trash" });
      await expect(catalog.markDeletedIfUnreferenced(active.id, fence, deletedAt))
        .resolves.toMatchObject({ status: "deleted" });
      await catalog.recordGcInconsistency(active.id, "source_content_mismatch");
    });

    const statements = clientQuery.mock.calls.map(([sql]) => String(sql));
    expect(statements.filter((sql) => sql.includes("UPDATE source_blobs"))
      .every((sql) => sql.includes("id =") && sql.includes("fencing_token ="))).toBe(true);
    expect(statements.filter((sql) => sql.includes("SET status = 'tombstoned'") || sql.includes("SET status = 'deleted'"))
      .every((sql) => sql.includes("NOT EXISTS") && sql.includes("source_files"))).toBe(true);
    expect(clientQuery.mock.calls.some(([, values]) =>
      Array.isArray(values) && values.includes("source_blob.gc_inconsistent")
    )).toBe(true);
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  test("lists active zero-reference and non-active GC candidates from source_blobs", async () => {
    const tailRow = {
      id: "33333333-3333-4333-8333-333333333333",
      workspace_id: "11111111-1111-4111-8111-111111111111",
      content_hash: "f".repeat(64),
      generation: 2
    };
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => {
      void _values;
      if (_sql.includes("ORDER BY blob.workspace_id DESC")) return { rows: [tailRow] };
      return { rows: [] };
    });
    const store = new PostgresAppStore({ query } as never);

    const tail = await store.findSourceBlobGcCandidateTail();
    await expect(store.listSourceBlobGcCandidates({ through: tail!, limit: 7 })).resolves.toEqual([]);

    expect(tail).toEqual({
      workspaceId: tailRow.workspace_id,
      contentHash: tailRow.content_hash,
      generation: tailRow.generation,
      id: tailRow.id
    });
    const sql = String(query.mock.calls[1]?.[0]);
    expect(sql).toContain("FROM source_blobs");
    expect(sql).toContain("status IN ('tombstoned', 'trash')");
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("source_files");
    expect(sql).toContain("ROW(blob.workspace_id, blob.content_hash, blob.generation, blob.id)");
    expect(sql).toContain("<= ROW($1, $2, $3, $4)");
    expect(sql).toContain("LIMIT $5");
    expect(query.mock.calls[1]?.[1]).toEqual([
      tailRow.workspace_id, tailRow.content_hash, tailRow.generation, tailRow.id, 7
    ]);
  });

  test("commits a moved referenced tombstone audit before SourceBlobStore.put throws outside the lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devkh-postgres-put-audit-"));
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const bytes = Buffer.from("postgres referenced tombstone");
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const blobRow = {
      id: "33333333-3333-4333-8333-333333333333",
      workspace_id: workspaceId,
      content_hash: contentHash,
      generation: 1,
      byte_size: String(bytes.length),
      status: "tombstoned",
      storage_key: `blobs/${workspaceId}/${contentHash.slice(0, 2)}/${contentHash}/1`,
      fencing_token: randomUUID(),
      tombstoned_at: new Date("2026-07-20T00:00:00.000Z"),
      trashed_at: null,
      deleted_at: null
    };
    const trash = path.join(root, ".trash", workspaceId, contentHash, "1");
    await mkdir(path.dirname(path.join(root, blobRow.storage_key)), { recursive: true });
    await mkdir(path.dirname(trash), { recursive: true });
    await writeFile(trash, bytes);
    await chmod(trash, 0o444);
    const clientQuery = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      if (sql.includes("status = 'active'") && sql.includes("FROM source_blobs")) return { rows: [] };
      if (sql.includes("status = 'tombstoned'") && sql.includes("FROM source_blobs")) return { rows: [blobRow] };
      if (sql.includes("count(*)::text AS reference_count")) return { rows: [{ reference_count: "1" }] };
      if (sql.includes("SELECT id, status, generation")) {
        return { rows: [{ id: blobRow.id, status: blobRow.status, generation: blobRow.generation }] };
      }
      return { rows: [] };
    });
    const client = { query: clientQuery, release: vi.fn() };
    const catalog = new PostgresAppStore({ connect: vi.fn(async () => client) } as never);
    const blobs = new SourceBlobStore({ dataDir: root, catalog });

    try {
      await expect(blobs.put({ workspaceId, bytes }))
        .rejects.toMatchObject({ code: "SOURCE_BLOB_INTEGRITY_FAILED" });
      const statements = clientQuery.mock.calls.map(([sql]) => String(sql));
      expect(statements).toContain("COMMIT");
      expect(statements).not.toContain("ROLLBACK");
      expect(statements.some((sql) => sql.includes("INSERT INTO audit_events"))).toBe(true);
      expect(statements.some((sql) => sql.includes("UPDATE source_blobs"))).toBe(false);
      expect(clientQuery.mock.calls.some(([, values]) =>
        Array.isArray(values) && values.includes("source_blob.gc_inconsistent")
      )).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("locks and validates active source blob identity and metadata before inserting a source_file binding", async () => {
    const snapshot = {
      id: "snapshot-1", workspace_id: "workspace-1", repository_id: "repository-1",
      commit_sha: "a".repeat(40), ref: "main", remote_url: null,
      commit_timestamp: new Date("2026-07-20T00:00:00.000Z"), storage_path: "/tmp/snapshot"
    };
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      if (sql.includes("INSERT INTO source_snapshots")) return { rows: [snapshot] };
      if (sql.includes("FROM source_blobs") && sql.includes("FOR SHARE")) {
        return sql.includes("content_hash = $3") && sql.includes("byte_size = $4")
          ? { rows: [] }
          : { rows: [{ id: "blob-1" }] };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({ connect: vi.fn(async () => client) } as never);

    await expect(store.createSnapshot({
      snapshot: {
        id: snapshot.id, workspaceId: snapshot.workspace_id, repositoryId: snapshot.repository_id,
        commitSha: snapshot.commit_sha, ref: snapshot.ref, remoteUrl: null,
        commitTimestamp: snapshot.commit_timestamp, storagePath: snapshot.storage_path
      },
      files: [{
        id: "file-1", workspaceId: snapshot.workspace_id, snapshotId: snapshot.id, path: "src/index.ts",
        language: "typescript", contentHash: "b".repeat(64), byteSize: 12, sourceBlobId: "blob-1"
      }]
    })).rejects.toThrow("SOURCE_BLOB_NOT_ACTIVE");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("FOR SHARE"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("content_hash = $3"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("byte_size = $4"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO source_files"))).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
});

const stageRow = {
  id: "stage-run-1", workspace_id: "workspace-1", project_id: "project-1", snapshot_id: "snapshot-1", build_job_id: "build-1",
  stage: "convert", attempt: 1, status: "queued", input_digest: "a".repeat(64), output_manifest_ids: [],
  started_at: null, finished_at: null, error_code: null, error_detail: null
};

const artifactRow = {
  id: "artifact-1", workspace_id: "workspace-1", project_id: "project-1", snapshot_id: "snapshot-1", build_job_id: "build-1",
  stage: "convert", kind: "normalized-source", schema_version: 1, input_digest: "a".repeat(64), content_digest: "b".repeat(64),
  storage_key: "project-1/snapshot-1/convert/b.json", source_refs: [], producer: "deterministic", created_at: new Date("2026-07-14T00:00:00.000Z")
};

describe("PostgresAppStore pipeline persistence", () => {
  test("rolls back a frontend release when an internal artifact is outside its scope", async () => {
    const releaseRow = {
      id: "release-1", workspace_id: "workspace-1", repository_id: "repository-1",
      build_job_id: "build-1", snapshot_id: "snapshot-1", version: "frontend-v2.0.0",
      kernel_mode: "pipeline", package_artifact_id: "package-1",
      release_artifact_family: "frontend-v2", package_stage_run_id: "package-run-1",
      frontend_ir_schema_version: 2, frontend_graph_schema_version: 2,
      analyzer_manifest_digest: "a".repeat(64), created_at: new Date(), published_at: null
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO releases")) return { rows: [releaseRow] };
      if (sql.includes("INSERT INTO release_artifacts")) return { rows: [] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({ connect: vi.fn(async () => client) } as never);

    await expect(store.createReleaseDraft(
      "workspace-1", "repository-1", "build-1", "frontend-v2.0.0", {
        releaseArtifactFamily: "frontend-v2", packageArtifactId: "package-1",
        packageStageRunId: "package-run-1", artifactIds: ["internal-1"],
        frontendIrSchemaVersion: 2, frontendGraphSchemaVersion: 2,
        analyzerManifestDigest: "a".repeat(64)
      }
    )).rejects.toThrow("same release scope");
    expect(String(query.mock.calls[2]![0])).toContain("JOIN repositories");
    expect(String(query.mock.calls[2]![0])).toContain("artifact.snapshot_id = $5");
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN", expect.stringContaining("INSERT INTO releases"),
      expect.stringContaining("INSERT INTO release_artifacts"), "ROLLBACK"
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  test("writes and reads an immutable project-scoped graph transactionally", async () => {
    const sourceRef = { snapshotId: "snapshot-1", path: "src/main.ts", startLine: 1, endLine: 1, blobHash: "a".repeat(64) };
    const node = {
      id: "b".repeat(64), projectId: "project-1", snapshotId: "snapshot-1",
      kind: "module" as const, name: "main.ts", qualifiedName: "src/main.ts", candidate: false, sourceRefs: [sourceRef], attributes: { language: "typescript" }
    };
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [], rowCount: 0 };
      if (sql.includes("FROM build_jobs build")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT 1 FROM knowledge_graph_nodes")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT node_id")) return { rows: [{
        node_id: node.id, workspace_id: "workspace-1", project_id: node.projectId, snapshot_id: node.snapshotId,
        kind: node.kind, name: node.name, qualified_name: node.qualifiedName, candidate: false, source_refs: [sourceRef], attributes: node.attributes
      }], rowCount: 1 };
      if (sql.includes("SELECT edge_id")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({ query, connect: vi.fn(async () => client) } as never);

    await expect(store.saveKnowledgeGraph({
      workspaceId: "workspace-1", projectId: "project-1", snapshotId: "snapshot-1", buildId: "build-1", graph: { nodes: [node], edges: [] }
    })).resolves.toBeUndefined();
    await expect(store.getKnowledgeGraph("workspace-1", "project-1", "build-1"))
      .resolves.toEqual({ nodes: [node], edges: [] });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO knowledge_graph_nodes"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("workspace_id = $1 AND project_id = $2 AND build_job_id = $3"))).toBe(true);
  });

  test("writes project-scoped stage runs and reuses only matching immutable artifacts", async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("INSERT INTO build_stage_runs")) return { rows: [stageRow] };
      if (sql.includes("INSERT INTO knowledge_artifacts")) return { rows: [artifactRow] };
      if (sql.includes("FROM knowledge_artifacts")) return { rows: [artifactRow] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({ query, connect: vi.fn(async () => client) } as never);

    await expect(store.createStageRun({
      workspaceId: "workspace-1", projectId: "project-1", snapshotId: "snapshot-1", buildId: "build-1",
      stage: "convert", attempt: 1, inputDigest: "a".repeat(64)
    })).resolves.toMatchObject({ stage: "convert", status: "queued" });
    await expect(store.createArtifactWithAudit({
      id: "artifact-1", workspaceId: "workspace-1", projectId: "project-1", snapshotId: "snapshot-1", buildId: "build-1",
      stage: "convert", kind: "normalized-source", schemaVersion: 1, inputDigest: "a".repeat(64), contentDigest: "b".repeat(64),
      storageKey: "project-1/snapshot-1/convert/b.json", sourceRefs: [], producer: "deterministic", createdAt: "2026-07-14T00:00:00.000Z"
    })).resolves.toMatchObject({ id: "artifact-1", contentDigest: "b".repeat(64) });
    await expect(store.findReusableArtifact(
      "workspace-1", "project-1", "snapshot-1", "convert", "normalized-source", "a".repeat(64)
    )).resolves.toMatchObject({ id: "artifact-1" });
    await expect(store.findArtifactById("artifact-1")).resolves.toMatchObject({ id: "artifact-1" });

    expect(query.mock.calls.some(([sql]) => String(sql).includes("workspace_id, project_id, snapshot_id, build_job_id"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO knowledge_artifacts"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("workspace_id = $1 AND project_id = $2"))).toBe(true);
    expect(query.mock.calls.some(([sql, values]) =>
      String(sql).includes("WHERE id = $1") && values?.[0] === "artifact-1"
    )).toBe(true);
  });

  test("reuses a content-addressed artifact when an upstream input digest changes", async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("INSERT INTO knowledge_artifacts")) return { rows: [] };
      if (sql.includes("storage_key = $1")) return { rows: [artifactRow] };
      if (sql.includes("FROM knowledge_artifacts")) return { rows: [] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({ query, connect: vi.fn(async () => client) } as never);

    await expect(store.createArtifactWithAudit({
      id: "artifact-2", workspaceId: "workspace-1", projectId: "project-1", snapshotId: "snapshot-1", buildId: "build-1",
      stage: "convert", kind: "normalized-source", schemaVersion: 1, inputDigest: "e".repeat(64), contentDigest: "b".repeat(64),
      storageKey: "project-1/snapshot-1/convert/b.json", sourceRefs: [], producer: "deterministic", createdAt: "2026-07-14T00:00:00.000Z"
    })).resolves.toMatchObject({ id: "artifact-1", inputDigest: "a".repeat(64) });

    expect(query.mock.calls.some(([sql]) => String(sql).includes("WHERE storage_key = $1"))).toBe(true);
  });

  test("persists pipeline search documents only after validating the source artifact scope", async () => {
    const documentRow = {
      id: "document-1", workspace_id: "workspace-1", project_id: "project-1", snapshot_id: "snapshot-1",
      build_job_id: "build-1", source_artifact_id: "artifact-1", document_key: "architecture-overview:0",
      kind: "page", title: "Architecture", content: "Overview", citations: [], metadata: { pageSlug: "architecture-overview" },
      created_at: new Date("2026-07-16T00:00:00.000Z")
    };
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [], rowCount: 0 };
      if (sql.includes("FROM knowledge_artifacts")) return { rows: [], rowCount: 1 };
      if (sql.includes("INSERT INTO pipeline_search_documents")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM pipeline_search_documents")) return { rows: [documentRow], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({ query, connect: vi.fn(async () => client) } as never);
    const input = {
      workspaceId: "workspace-1", projectId: "project-1", snapshotId: "snapshot-1", buildId: "build-1",
      sourceArtifactId: "artifact-1",
      documents: [{
        documentKey: "architecture-overview:0", kind: "page" as const, title: "Architecture", content: "Overview",
        citations: [], metadata: { pageSlug: "architecture-overview" }
      }]
    };

    await expect(store.savePipelineSearchDocuments(input)).resolves.toEqual([
      expect.objectContaining({ sourceArtifactId: "artifact-1", documentKey: "architecture-overview:0" })
    ]);
    await expect(store.listPipelineSearchDocuments("workspace-1", "project-1", "build-1")).resolves.toHaveLength(1);
    expect(query.mock.calls.some(([sql, values]) =>
      String(sql).includes("FROM knowledge_artifacts")
      && values?.slice(0, 4).join(":") === "artifact-1:workspace-1:project-1:snapshot-1"
    )).toBe(true);
  });

  test("creates a stage run idempotently when the queue replays its schedule request", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO build_stage_runs")) return { rows: [stageRow] };
      return { rows: [] };
    });
    const store = new PostgresAppStore({ query } as never);

    await store.createStageRun({
      workspaceId: "workspace-1", projectId: "project-1", snapshotId: "snapshot-1", buildId: "build-1",
      stage: "convert", attempt: 1, inputDigest: "a".repeat(64)
    });

    expect(String(query.mock.calls[0][0])).toContain(
      "ON CONFLICT (build_job_id, stage, attempt) DO UPDATE"
    );
  });

  test("claims one queued stage with SKIP LOCKED inside a transaction", async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("UPDATE build_stage_runs")) return { rows: [{ ...stageRow, status: "running", started_at: new Date("2026-07-14T00:00:00.000Z") }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({ connect: vi.fn(async () => client) } as never);

    await expect(store.claimNextStageRun("workspace-1", "project-1", {
      buildId: "build-1",
      stage: "convert"
    })).resolves.toMatchObject({
      id: "stage-run-1", status: "running"
    });
    expect(String(query.mock.calls[1][0])).toContain("FOR UPDATE SKIP LOCKED");
    expect(query.mock.calls[1][1]).toEqual(["workspace-1", "project-1", "build-1", "convert"]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  test("commits a completed stage and its next queued stage in one transaction", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.startsWith("UPDATE build_stage_runs")) {
        return { rows: [{ ...stageRow, status: "succeeded", started_at: new Date("2026-07-14T00:00:00.000Z"), finished_at: new Date("2026-07-14T00:00:01.000Z") }] };
      }
      if (sql.includes("INSERT INTO build_stage_runs")) return { rows: [{ ...stageRow, id: "stage-run-2", stage: "extract" }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({ connect: vi.fn(async () => client) } as never);

    await expect(store.completeStageRunAndCreateNext({
      workspaceId: "workspace-1", projectId: "project-1", stageRunId: "stage-run-1",
      status: "succeeded", outputManifestIds: ["artifact-1"],
      next: {
        workspaceId: "workspace-1", projectId: "project-1", snapshotId: "snapshot-1", buildId: "build-1",
        stage: "extract", attempt: 1, inputDigest: "a".repeat(64)
      }
    })).resolves.toMatchObject({
      completed: { id: "stage-run-1", status: "succeeded" },
      next: { id: "stage-run-2", stage: "extract", status: "queued" }
    });
    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual(expect.arrayContaining([
      "BEGIN", "COMMIT"
    ]));
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO build_stage_events"))).toHaveLength(2);
    expect(client.release).toHaveBeenCalledOnce();
  });

  test("preserves a failed attempt before atomically scheduling its delayed retry", async () => {
    const retryAt = new Date("2026-07-16T04:00:05.000Z");
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.startsWith("UPDATE build_stage_runs")) {
        return { rows: [{ ...stageRow, status: "failed", started_at: new Date("2026-07-16T04:00:00.000Z"), finished_at: new Date("2026-07-16T04:00:01.000Z"), error_code: "PIPELINE_STAGE_FAILED", error_detail: "database unavailable" }] };
      }
      if (sql.includes("INSERT INTO build_stage_runs")) return { rows: [{ ...stageRow, id: "stage-run-2", attempt: 2 }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({ connect: vi.fn(async () => client) } as never);

    await expect(store.failStageRunAndCreateRetry({
      workspaceId: "workspace-1", projectId: "project-1", stageRunId: "stage-run-1",
      errorCode: "PIPELINE_STAGE_FAILED", errorDetail: "database unavailable",
      retry: { inputDigest: "a".repeat(64), availableAt: retryAt }
    })).resolves.toMatchObject({
      failed: { id: "stage-run-1", status: "failed", attempt: 1 },
      retry: { id: "stage-run-2", status: "queued", attempt: 2 }
    });
    const retryInsert = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO build_stage_runs"));
    expect(String(retryInsert?.[0])).toContain("available_at");
    expect(retryInsert?.[1]).toContain(retryAt);
    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]));
  });
});

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

    const switched = await store.switchRepositoryWithAudit("workspace-1", "project-1", {
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

    await expect(store.switchRepositoryWithAudit("workspace-1", "project-1", {
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
      .toContain("WHERE pending_upload_session_id IS NULL AND pending_import_report_id IS NULL");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO source_files")))
      .toBe(false);
  });
});

describe("PostgresAppStore Git synchronization leases", () => {
  test("uses the PostgreSQL clock instead of the caller clock for lease decisions", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({
      query,
      connect: vi.fn(async () => client)
    } as never);
    const callerClock = new Date("2040-01-01T00:00:00.000Z");

    await store.claimDueGitSynchronizations(callerClock, 10, 60_000);
    await store.finishGitSynchronization({
      repositoryId: "11111111-1111-4111-8111-111111111111",
      leaseToken: "22222222-2222-4222-8222-222222222222",
      status: "failed",
      failureCode: "GIT_SYNC_TIMEOUT",
      now: callerClock
    });

    const calls = query.mock.calls as unknown as Array<[string, unknown[]?]>;
    const schedulingStatements = calls.filter(([sql]) =>
      sql.includes("repository_sync_schedules")
    );
    expect(schedulingStatements).toHaveLength(3);
    for (const [sql, values] of schedulingStatements) {
      expect(sql).toContain("clock_timestamp()");
      expect(values).not.toContain(callerClock);
    }
  });

  test("makes the lease check part of the snapshot insert", async () => {
    const snapshotRow = {
      id: "33333333-3333-4333-8333-333333333333",
      workspace_id: "workspace-1",
      repository_id: "11111111-1111-4111-8111-111111111111",
      commit_sha: "a".repeat(40),
      ref: "origin/main",
      remote_url: "https://github.com/example/source.git",
      commit_timestamp: new Date(),
      storage_path: "/tmp/snapshot"
    };
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("INSERT INTO source_snapshots")
        ? [snapshotRow]
        : sql.includes("repository_sync_schedules")
          ? [{ repository_id: snapshotRow.repository_id }]
          : []
    }));
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({ connect: vi.fn(async () => client) } as never);

    await expect(store.createSnapshotWithGitSynchronizationLease({
      snapshot: {
        id: snapshotRow.id,
        workspaceId: snapshotRow.workspace_id,
        repositoryId: snapshotRow.repository_id,
        commitSha: snapshotRow.commit_sha,
        ref: snapshotRow.ref,
        remoteUrl: snapshotRow.remote_url,
        commitTimestamp: snapshotRow.commit_timestamp,
        storagePath: snapshotRow.storage_path
      },
      files: []
    }, {
      repositoryId: snapshotRow.repository_id,
      leaseToken: "22222222-2222-4222-8222-222222222222"
    })).resolves.toMatchObject({ id: snapshotRow.id });

    const snapshotInsert = (query.mock.calls as unknown as Array<[string, unknown[]?]>).find(([sql]) =>
      sql.includes("INSERT INTO source_snapshots")
    );
    expect(snapshotInsert?.[0]).toContain("WITH held_lease AS");
    expect(snapshotInsert?.[0]).toContain("lease_expires_at > clock_timestamp()");
    expect(snapshotInsert?.[0]).toContain("FOR UPDATE");
    const leaseChecks = (query.mock.calls as unknown as Array<[string, unknown[]?]>).filter(([sql]) =>
      sql.includes("repository_sync_schedules")
    );
    expect(leaseChecks).toHaveLength(2);
  });
});

describe("PostgresAppStore MCP token rotation", () => {
  test("rotates an active MCP token in one audited transaction", async () => {
    const oldToken = {
      id: "token-old", workspace_id: "workspace-1", project_id: "project-1", name: "Codex",
      token_hash: "old-hash", token_prefix: "dkh_old", created_at: new Date("2026-07-01"),
      last_used_at: null, revoked_at: null
    };
    const newToken = { ...oldToken, id: "token-new", token_hash: "new-hash", token_prefix: "dkh_new", created_at: new Date("2026-07-14") };
    const revokedToken = { ...oldToken, revoked_at: new Date("2026-07-14") };
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      void _values;
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("FROM mcp_tokens") && sql.includes("FOR UPDATE")) return { rows: [oldToken] };
      if (sql.includes("INSERT INTO mcp_tokens")) return { rows: [newToken] };
      if (sql.includes("UPDATE mcp_tokens")) return { rows: [revokedToken] };
      if (sql.includes("INSERT INTO audit_events")) return { rows: [] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({ connect: vi.fn(async () => client) } as never);

    const rotation = await store.rotateMcpTokenWithAudit(
      "workspace-1", "token-old", { tokenHash: "new-hash", tokenPrefix: "dkh_new" }, "admin-1"
    );

    expect(rotation).toMatchObject({
      previous: { id: "token-old", revokedAt: expect.any(Date) },
      replacement: { id: "token-new", projectId: "project-1", revokedAt: null }
    });
    expect(query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/)[0])).toEqual([
      "BEGIN", "SELECT", "INSERT", "UPDATE", "INSERT", "COMMIT"
    ]);
    expect(query.mock.calls[4][1]).toEqual(expect.arrayContaining([
      expect.stringContaining("replacementTokenId"), expect.stringContaining("token-new")
    ]));
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
    expect(sql).toContain("to_tsvector('english', regexp_replace(kp.title || ' ' || kp.body");
    expect(sql).toContain("'([a-z])([A-Z])'");
    expect(sql).toContain("lower(kp.title || ' ' || kp.body) LIKE '%' || lower($3) || '%'");
    expect(sql).toContain("$3 !~ '[/.]' AND similarity(lower(cs.name), lower($3)) > 0.35");
    expect(sql).toContain("$3 !~ '[/.]' AND similarity(lower(kp.title), lower($3)) > 0.35");
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
  const remediationRow = {
    id: "remediation-1",
    workspace_id: "workspace-1",
    project_id: "project-1",
    repository_id: "repo-1",
    source_build_id: "source-build-1",
    issue: {
      id: "lint-1", buildId: "source-build-1", rule: "KNOWLEDGE_LOW_COVERAGE",
      severity: "warning", targetKind: "knowledge", targetId: "overview",
      message: "Coverage is low", sourceRefs: [], remediationState: "open"
    },
    state: "accepted",
    rebuild_build_id: null,
    created_at: new Date(),
    updated_at: new Date()
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

  test("rolls back remediation build association and event when its audit insert fails", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO audit_events")) throw new Error("audit unavailable");
      if (sql.includes("FROM remediation_cases") && sql.includes("FOR UPDATE")) return { rows: [remediationRow] };
      if (sql.includes("FROM build_jobs")) return { rows: [buildRow] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new PostgresAppStore({ connect: vi.fn(async () => client) } as never);

    await expect(store.requestRemediationBuildWithAudit({
      workspaceId: "workspace-1", remediationId: "remediation-1", actorId: "admin-1",
      build: {
        workspaceId: "workspace-1", repositoryId: "repo-1", snapshotId: "snapshot-1",
        snapshotPath: "/snapshot", commitSha: "b".repeat(40)
      }
    })).rejects.toThrow("audit unavailable");

    expect(query.mock.calls[0][0]).toBe("BEGIN");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO remediation_events"))).toBe(true);
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
  });
});
