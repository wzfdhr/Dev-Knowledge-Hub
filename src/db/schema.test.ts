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
        "sourceAnalysisArtifacts",
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
