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
