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
