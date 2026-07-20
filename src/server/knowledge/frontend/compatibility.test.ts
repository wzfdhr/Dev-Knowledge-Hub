import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { BUILD_STAGES, type ArtifactManifest } from "../pipeline/contracts.js";
import type { PipelineStageRunRecord } from "../../persistence/store.js";

import {
  assertFrontendArtifactFamily,
  ARTIFACT_KINDS,
  createVerifiedFrontendReleaseDraft,
  EMPTY_FRONTEND_ANALYZER_MANIFEST_DIGEST,
  frontendGraphV2Schema,
  frontendPipelinePackageSchema,
  frontendStageArtifactKinds,
  releaseArtifactFamily
} from "./compatibility.js";

const root = process.cwd();

function releaseFixture() {
  const workspaceId = "workspace-1";
  const projectId = "project-1";
  const repositoryId = "repository-1";
  const snapshotId = "snapshot-1";
  const buildId = "build-1";
  const artifacts = {} as Record<(typeof BUILD_STAGES)[number], string[]>;
  const manifests = new Map<string, ArtifactManifest>();
  const runs: PipelineStageRunRecord[] = [];
  for (const stage of BUILD_STAGES) {
    const families = stage === "package" ? ["knowledge-v1"] as const : ["knowledge-v1", "frontend-v2"] as const;
    const contracts = [...new Map(families.map((family) => {
      const expected = ARTIFACT_KINDS[stage][family];
      return [`${expected.kind}@${expected.schemaVersion}`, expected] as const;
    })).values()];
    const ids = contracts.map((expected, index) => {
      const id = `${stage}-artifact-${index}`;
      manifests.set(id, {
        id, workspaceId, projectId, snapshotId, buildId, stage,
        kind: expected.kind, schemaVersion: expected.schemaVersion,
        inputDigest: "a".repeat(64), contentDigest: "b".repeat(64),
        storageKey: `${stage}/${id}.json`, sourceRefs: [], producer: "deterministic",
        createdAt: "2026-07-18T00:00:00.000Z"
      });
      return id;
    });
    artifacts[stage] = ids;
    runs.push({
      id: `${stage}-run`, workspaceId, projectId, snapshotId, buildId, stage,
      attempt: 1, status: "succeeded", inputDigest: "a".repeat(64),
      outputManifestIds: [...ids], startedAt: "2026-07-18T00:00:00.000Z",
      finishedAt: "2026-07-18T00:00:01.000Z", errorCode: null, errorDetail: null
    });
  }
  const packageArtifactId = "frontend-package";
  manifests.set(packageArtifactId, {
    id: packageArtifactId, workspaceId, projectId, snapshotId, buildId, stage: "package",
    kind: "frontend-pipeline-package", schemaVersion: 2,
    inputDigest: "c".repeat(64), contentDigest: "d".repeat(64),
    storageKey: "package/frontend-package.json", sourceRefs: [], producer: "deterministic",
    createdAt: "2026-07-18T00:00:00.000Z"
  });
  runs.at(-1)!.outputManifestIds.push(packageArtifactId);
  const packageValue = {
    schemaVersion: 2 as const, family: "frontend-v2" as const, stage: "package" as const, snapshotId,
    analyzerManifestDigest: EMPTY_FRONTEND_ANALYZER_MANIFEST_DIGEST,
    upstreamManifestIds: artifacts.validate, sourceArtifactId: artifacts.package[0]!,
    irSchemaVersion: 2 as const, graphSchemaVersion: 2 as const, artifacts
  };
  const createReleaseDraft = vi.fn(async () => ({ id: "release-1" }) as never);
  const store = {
    getBuild: async () => ({ id: buildId, workspaceId, repositoryId, snapshotId, status: "ready" }),
    getRepository: async () => ({ id: repositoryId, workspaceId, projectId }),
    listPipelineStageRuns: async () => runs,
    findArtifactById: async (id: string) => manifests.get(id) ?? null,
    createReleaseDraft
  };
  const artifactReader = {
    getJson: vi.fn(async (manifest: ArtifactManifest): Promise<unknown> => {
      if (manifest.id === packageArtifactId) return packageValue;
      if (manifest.id === artifacts.validate[1]) {
        return {
          schemaVersion: 2, family: "frontend-v2", stage: "validate", snapshotId,
          analyzerManifestDigest: EMPTY_FRONTEND_ANALYZER_MANIFEST_DIGEST,
          upstreamManifestIds: artifacts.viz, sourceArtifactId: artifacts.validate[0],
          valid: true, pageCount: 1, issueCount: 0,
          graphReferenceCount: 2, checkedReferenceCount: 5, invalidReferenceCount: 0
        };
      }
      return { ok: true };
    })
  };
  const releaseInput = {
    store, artifactReader, workspaceId, repositoryId, buildId, version: "frontend-v2.0.0",
    packageStageRunId: "package-run", packageArtifactId
  };
  return { artifacts, manifests, runs, packageValue, artifactReader, createReleaseDraft, releaseInput };
}

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
    expect(frontendStageArtifactKinds("convert", ["knowledge-v1", "frontend-v2"], "shadow"))
      .toEqual(["normalized-source-refs", "normalized-sources"]);
    expect(frontendStageArtifactKinds("convert", ["knowledge-v1", "frontend-v2"], "active"))
      .toEqual(["normalized-source-refs"]);
    expect(() => assertFrontendArtifactFamily("convert", ["knowledge-v1", "frontend-v2"], [
      { kind: "normalized-source-refs", schemaVersion: 2 }
    ], "active")).not.toThrow();
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
    expect(frontendPipelinePackageSchema.parse({
      ...value,
      sourceStorageMode: "shadow",
      artifacts: { ...value.artifacts, convert: ["convert-v1", "convert-v2"] }
    })).toMatchObject({ sourceStorageMode: "shadow", artifacts: { convert: ["convert-v1", "convert-v2"] } });
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

  test("verifies every physical artifact inside a frontend release package", async () => {
    const fixture = releaseFixture();
    await expect(createVerifiedFrontendReleaseDraft(fixture.releaseInput)).resolves.toEqual({ id: "release-1" });
    expect(fixture.artifactReader.getJson).toHaveBeenCalledTimes(
      1 + Object.values(fixture.artifacts).flat().length
    );
    expect(fixture.createReleaseDraft).toHaveBeenCalledOnce();
    expect(fixture.createReleaseDraft).toHaveBeenCalledWith(
      fixture.releaseInput.workspaceId,
      fixture.releaseInput.repositoryId,
      fixture.releaseInput.buildId,
      fixture.releaseInput.version,
      expect.objectContaining({
        artifactIds: Object.values(fixture.artifacts).flat().sort()
      })
    );
  });

  test("rejects completed stage outputs from another snapshot", async () => {
    const fixture = releaseFixture();
    fixture.runs.find((run) => run.stage === "extract")!.snapshotId = "other-snapshot";
    await expect(createVerifiedFrontendReleaseDraft(fixture.releaseInput))
      .rejects.toThrow("not completed build outputs");
  });

  test("rejects cross-project, missing, and unreadable internal package artifacts", async () => {
    const crossProject = releaseFixture();
    const crossId = crossProject.artifacts.extract[0]!;
    crossProject.manifests.set(crossId, { ...crossProject.manifests.get(crossId)!, projectId: "other-project" });
    await expect(createVerifiedFrontendReleaseDraft(crossProject.releaseInput)).rejects.toThrow("build scope");

    const missing = releaseFixture();
    missing.manifests.delete(missing.artifacts.graph[0]!);
    await expect(createVerifiedFrontendReleaseDraft(missing.releaseInput)).rejects.toThrow("build scope");

    const unreadable = releaseFixture();
    const unreadableId = unreadable.artifacts.synthesize[0]!;
    unreadable.artifactReader.getJson.mockImplementation(async (manifest) => {
      if (manifest.id === unreadableId) throw new Error("Artifact content digest mismatch");
      return manifest.id === unreadable.releaseInput.packageArtifactId
        ? unreadable.packageValue
        : { ok: true };
    });
    await expect(createVerifiedFrontendReleaseDraft(unreadable.releaseInput)).rejects.toThrow("digest mismatch");
  });

  test("rejects a release package whose frontend validation lacks complete Graph evidence", async () => {
    const fixture = releaseFixture();
    const validationId = fixture.artifacts.validate[1]!;
    fixture.artifactReader.getJson.mockImplementation(async (manifest) => {
      if (manifest.id === fixture.releaseInput.packageArtifactId) return fixture.packageValue;
      if (manifest.id === validationId) {
        return {
          schemaVersion: 2, family: "frontend-v2", stage: "validate",
          snapshotId: "snapshot-1", analyzerManifestDigest: EMPTY_FRONTEND_ANALYZER_MANIFEST_DIGEST,
          upstreamManifestIds: fixture.artifacts.viz, sourceArtifactId: fixture.artifacts.validate[0],
          valid: true, pageCount: 1, issueCount: 0
        };
      }
      return { ok: true };
    });

    await expect(createVerifiedFrontendReleaseDraft(fixture.releaseInput))
      .rejects.toThrow("complete Graph reference evidence");
    expect(fixture.createReleaseDraft).not.toHaveBeenCalled();
  });

  test("rejects valid reference evidence from a different validation snapshot", async () => {
    const fixture = releaseFixture();
    const validationId = fixture.artifacts.validate[1]!;
    const original = fixture.artifactReader.getJson.getMockImplementation()!;
    fixture.artifactReader.getJson.mockImplementation(async (manifest) => {
      const value = await original(manifest);
      return manifest.id === validationId && value && typeof value === "object"
        ? { ...value, snapshotId: "other-snapshot" }
        : value;
    });

    await expect(createVerifiedFrontendReleaseDraft(fixture.releaseInput))
      .rejects.toThrow("validation provenance");
    expect(fixture.createReleaseDraft).not.toHaveBeenCalled();
  });

  test("defines additive immutable v2 release provenance and project rollout storage", async () => {
    const sql = await readFile(path.join(root, "drizzle/0031_frontend_contracts_rollout.sql"), "utf8");
    for (const fragment of [
      "project_frontend_rollouts",
      "release_artifacts",
      "release_artifacts_artifact_idx",
      "release_artifact_family",
      "package_stage_run_id",
      "frontend_ir_schema_version",
      "frontend_graph_schema_version",
      "analyzer_manifest_digest",
      "DEFAULT 'knowledge-v1'",
      "ON DELETE RESTRICT",
      "REFERENCES releases(id) ON DELETE CASCADE",
      "REFERENCES knowledge_artifacts(id) ON DELETE RESTRICT",
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
      "releaseArtifacts",
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
