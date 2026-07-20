import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";

import * as schema from "./schema";

describe("schema exports", () => {
  test("exports all required tables and status constants", () => {
    expect(Object.keys(schema)).toEqual(
      expect.arrayContaining([
        "workspaces",
        "adminUsers",
        "repositories",
        "encryptedCredentials",
        "sourceSnapshots",
        "sourceFiles",
        "sourceBlobs",
        "sourceAnalysisArtifacts",
        "uploadSessions",
        "uploadSessionEntries",
        "uploadIdempotencyKeys",
        "importReports",
        "codeSymbols",
        "codeEdges",
        "buildJobs",
        "buildStageRuns",
        "knowledgeArtifacts",
        "knowledgePages",
        "knowledgeChunks",
        "releases",
        "releaseChannels",
        "mcpTokens",
        "agentFeedback",
        "auditEvents",
        "BUILD_JOB_STATUSES",
        "AGENT_FEEDBACK_STATUSES"
      ])
    );
  });

  test("keeps source blobs generation-scoped while source file references remain expandable", () => {
    const blobs = getTableConfig(schema.sourceBlobs);
    const files = getTableConfig(schema.sourceFiles);

    expect(blobs.uniqueConstraints.map((item) => item.name)).toContain("source_blobs_workspace_hash_generation_unique");
    expect(blobs.indexes.map((item) => item.config.name)).toContain("source_blobs_active_workspace_hash_idx");
    expect(blobs.checks.map((item) => item.name)).toEqual(expect.arrayContaining([
      "source_blobs_content_hash_check",
      "source_blobs_generation_check",
      "source_blobs_status_check"
    ]));
    expect(files.columns.find((column) => column.name === "source_blob_id")?.notNull).toBe(false);
    expect(files.foreignKeys.map((key) => key.getName())).toContain("source_files_source_blob_workspace_fk");
  });

  test("keeps upload sessions workspace scoped with durable manifest and idempotency contracts", () => {
    const sessions = getTableConfig(schema.uploadSessions);
    const entries = getTableConfig(schema.uploadSessionEntries);
    const idempotency = getTableConfig(schema.uploadIdempotencyKeys);
    const reports = getTableConfig(schema.importReports);
    const snapshots = getTableConfig(schema.sourceSnapshots);

    expect(sessions.foreignKeys.map((key) => key.getName())).toEqual(expect.arrayContaining([
      "upload_sessions_project_workspace_fk",
      "upload_sessions_repository_scope_fk",
      "upload_sessions_expected_current_repository_scope_fk",
      "upload_sessions_expected_latest_snapshot_scope_fk",
      "upload_sessions_actor_workspace_fk",
      "upload_sessions_snapshot_repository_fk"
    ]));
    expect(sessions.checks.map((item) => item.name)).toEqual(expect.arrayContaining([
      "upload_sessions_status_check",
      "upload_sessions_entry_count_check",
      "upload_sessions_manifest_digest_check"
    ]));
    expect(sessions.columns.find((column) => column.name === "commit_response")?.notNull).toBe(false);
    expect(entries.primaryKeys).toHaveLength(1);
    expect(entries.primaryKeys[0]!.columns.map((column) => column.name)).toEqual(["session_id", "ordinal"]);
    expect(entries.uniqueConstraints.map((item) => item.name)).toContain("upload_session_entries_path_unique");
    expect(entries.columns.find((column) => column.name === "metadata_byte_size")?.notNull).toBe(true);
    expect(entries.checks.map((item) => item.name)).toContain("upload_session_entries_metadata_byte_size_check");
    expect(idempotency.primaryKeys).toHaveLength(1);
    expect(idempotency.primaryKeys[0]!.columns.map((column) => column.name)).toEqual([
      "workspace_id", "actor_id", "idempotency_key"
    ]);
    expect(reports.foreignKeys.map((key) => key.getName())).toContain(
      "import_reports_upload_session_scope_fk"
    );
    expect(reports.checks.map((item) => item.name)).toContain("import_reports_status_check");
    expect(reports.indexes.map((item) => item.config.name)).toContain("import_reports_retention_idx");
    expect(reports.indexes.map((item) => item.config.name)).toContain("import_reports_id_workspace_repository_idx");
    expect(snapshots.foreignKeys.map((key) => key.getName())).toContain(
      "source_snapshots_pending_import_report_scope_fk"
    );
  });

  test("keeps frontend release provenance foreign keys and shape checks in the typed schema", () => {
    const config = getTableConfig(schema.releases);
    expect(config.foreignKeys.map((key) => key.getName())).toEqual(expect.arrayContaining([
      "releases_package_artifact_id_knowledge_artifacts_id_fk",
      "releases_package_stage_run_id_build_stage_runs_id_fk"
    ]));
    expect(config.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
      "releases_artifact_family_check",
      "releases_frontend_provenance_shape_check"
    ]));
    expect(getTableConfig(schema.buildStageRuns).name).toBe("build_stage_runs");
    expect(getTableConfig(schema.knowledgeArtifacts).name).toBe("knowledge_artifacts");
  });

  test("keeps source analysis cache workspace-scoped and content-addressed", () => {
    const config = getTableConfig(schema.sourceAnalysisArtifacts);
    expect(config.name).toBe("source_analysis_artifacts");
    expect(config.primaryKeys).toHaveLength(1);
    expect(config.primaryKeys[0]!.columns.map((column) => column.name)).toEqual([
      "workspace_id",
      "content_hash",
      "analyzer_id",
      "analyzer_version",
      "parser_config_digest"
    ]);
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
      "source_analysis_artifacts_content_hash_check",
      "source_analysis_artifacts_parser_config_digest_check",
      "source_analysis_artifacts_facts_digest_check",
      "source_analysis_artifacts_facts_object_check",
      "source_analysis_artifacts_facts_size_check"
    ]));
  });

  test("exports required status values", () => {
    expect(schema.BUILD_JOB_STATUSES).toEqual([
      "queued",
      "syncing",
      "parsing",
      "synthesizing",
      "validating",
      "ready",
      "published",
      "failed"
    ]);
    expect(schema.AGENT_FEEDBACK_STATUSES).toEqual([
      "open",
      "acknowledged",
      "fixed",
      "dismissed"
    ]);
  });
});
