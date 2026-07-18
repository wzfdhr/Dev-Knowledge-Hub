import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  assertFrontendArtifactFamily,
  EMPTY_FRONTEND_ANALYZER_MANIFEST_DIGEST,
  frontendGraphV2Schema,
  frontendPipelinePackageSchema,
  frontendStageArtifactKinds,
  releaseArtifactFamily
} from "./compatibility.js";

const root = process.cwd();

describe("frontend v2 compatibility contracts", () => {
  test("keeps old releases on knowledge-v1 and recognizes explicit frontend-v2 only", () => {
    expect(releaseArtifactFamily({})).toBe("knowledge-v1");
    expect(releaseArtifactFamily({ releaseArtifactFamily: "knowledge-v1" })).toBe("knowledge-v1");
    expect(releaseArtifactFamily({ releaseArtifactFamily: "frontend-v2" })).toBe("frontend-v2");
    expect(() => releaseArtifactFamily({ releaseArtifactFamily: "future-v3" })).toThrow("Unsupported release artifact family");
  });

  test("requires exactly the enabled artifact kinds per stage and family", () => {
    expect(frontendStageArtifactKinds("extract", ["knowledge-v1", "frontend-v2"])).toEqual([
      "frontend-ir-v2", "knowledge-ir"
    ]);
    expect(() => assertFrontendArtifactFamily("extract", ["knowledge-v1", "frontend-v2"], [
      { kind: "knowledge-ir", schemaVersion: 1 }
    ])).toThrow("missing frontend-ir-v2@2");
    expect(() => assertFrontendArtifactFamily("extract", ["knowledge-v1"], [
      { kind: "knowledge-ir", schemaVersion: 1 },
      { kind: "knowledge-ir", schemaVersion: 1 }
    ])).toThrow("exactly one knowledge-ir@1");
  });

  test("requires a complete immutable package manifest for every shadow stage", () => {
    const value = {
      schemaVersion: 2, family: "frontend-v2", stage: "package", snapshotId: "snapshot-1",
      analyzerManifestDigest: EMPTY_FRONTEND_ANALYZER_MANIFEST_DIGEST,
      upstreamManifestIds: ["validate-v1", "validate-v2"], sourceArtifactId: "package-v1",
      irSchemaVersion: 2, graphSchemaVersion: 2,
      artifacts: {
        convert: ["convert-v1"], extract: ["extract-v1", "extract-v2"],
        tables: ["tables-v1", "tables-v2"], graph: ["graph-v1", "graph-v2"],
        synthesize: ["synthesize-v1", "synthesize-v2"], index: ["index-v1", "index-v2"],
        lint: ["lint-v1", "lint-v2"], viz: ["viz-v1", "viz-v2"],
        validate: ["validate-v1", "validate-v2"], package: ["package-v1"]
      }
    } as const;
    expect(frontendPipelinePackageSchema.parse(value)).toEqual(value);
    expect(() => frontendPipelinePackageSchema.parse({
      ...value,
      artifacts: { ...value.artifacts, graph: ["graph-v1"] }
    })).toThrow();
  });

  test("freezes a graph v2 artifact independently from the legacy graph", () => {
    expect(frontendGraphV2Schema.parse({
      schemaVersion: 2,
      snapshotId: "snapshot-1",
      analyzerManifestDigest: EMPTY_FRONTEND_ANALYZER_MANIFEST_DIGEST,
      nodes: [],
      edges: []
    })).toMatchObject({ schemaVersion: 2, nodes: [], edges: [] });
  });

  test("defines additive immutable v2 release provenance and project rollout storage", async () => {
    const sql = await readFile(path.join(root, "drizzle/0031_frontend_contracts_rollout.sql"), "utf8");
    for (const fragment of [
      "project_frontend_rollouts",
      "release_artifact_family",
      "package_stage_run_id",
      "frontend_ir_schema_version",
      "frontend_graph_schema_version",
      "analyzer_manifest_digest",
      "DEFAULT 'knowledge-v1'",
      "ON DELETE RESTRICT",
      "output_manifest_ids",
      "frontend-pipeline-package",
      "artifact.schema_version = 2",
      "run.status IN ('succeeded', 'reused')",
      "build.repository_id = NEW.repository_id",
      "build.snapshot_id = NEW.snapshot_id",
      "build.status = 'ready'",
      "snapshot.repository_id = NEW.repository_id",
      "NEW.repository_id IS DISTINCT FROM OLD.repository_id",
      "NEW.build_job_id IS DISTINCT FROM OLD.build_job_id",
      "NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id",
      "Release frontend provenance is immutable"
    ]) expect(sql).toContain(fragment);
    expect(sql).not.toContain("UPDATE releases SET kernel_mode");
    const schema = await readFile(path.join(root, "src/db/schema.ts"), "utf8");
    for (const fragment of [
      "projectFrontendRollouts",
      'releaseArtifactFamily: text("release_artifact_family").notNull().default("knowledge-v1")',
      'packageStageRunId: uuid("package_stage_run_id")',
      'frontendIrSchemaVersion: integer("frontend_ir_schema_version")',
      'frontendGraphSchemaVersion: integer("frontend_graph_schema_version")',
      'analyzerManifestDigest: text("analyzer_manifest_digest")'
    ]) expect(schema).toContain(fragment);
    expect(sql).toContain("'routes_to'");
    expect(sql).not.toContain("'routes-to'");
    for (const kind of [
      "workspace_package", "application_entry", "route", "layout", "page", "component",
      "hook_or_composable", "state_store", "state_field", "api_operation", "data_schema",
      "style_token", "style_scope", "visualization", "test_case", "test_fixture", "tooling_config",
      "lazy_loads", "provides", "injects", "reads_state", "writes_state", "requests",
      "subscribes", "configures"
    ]) expect(sql).toContain(`'${kind}'`);
  });
});
