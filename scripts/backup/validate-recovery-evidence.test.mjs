import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validateRecoveryEvidence } from "./validate-recovery-evidence.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const validatorScript = join(scriptDirectory, "validate-recovery-evidence.mjs");
const digest = "a".repeat(64);

function validSourceBlobRecords() {
  return ["one.ts", "two.ts"].map((name) => ({
    workspaceId: "11111111-1111-4111-8111-111111111111",
    snapshotId: "55555555-5555-4555-8555-555555555555",
    sourcePath: `src/${name}`,
    storageKey: `blobs/11111111-1111-4111-8111-111111111111/aa/${digest}/1`,
    snapshotStoragePath: "/var/lib/devkh/snapshots/snapshots/55555555-5555-4555-8555-555555555555/files",
    contentHash: digest,
    generation: 1,
    byteSize: 32,
    status: "active",
    fencingToken: null,
    tombstonedAt: null,
    trashedAt: null,
    deletedAt: null,
    blobMode: "0444",
    viewMode: "0444",
    blobDevice: "2049",
    blobInode: "1001",
    viewDevice: "2049",
    viewInode: "1001",
    blobSize: "32",
    viewSize: "32",
    blobBlocks: "8",
    viewBlocks: "8",
    blobAllocatedBytes: "4096",
    viewAllocatedBytes: "4096",
    blobContentSha256: digest,
    viewContentSha256: digest,
    relationship: "same-device-inode-hardlink"
  }));
}

function serializeSourceBlobRecords(records = validSourceBlobRecords()) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function validEvidence() {
  const sourceBlobManifest = serializeSourceBlobRecords();
  return {
    schemaVersion: 3,
    operation: "restore-drill",
    result: "success",
    startedAt: "2026-07-15T00:00:00.000Z",
    finishedAt: "2026-07-15T00:01:00.000Z",
    resticSnapshotId: "f".repeat(64),
    databaseArchiveSha256: digest,
    volumeArchives: ["snapshots.tgz", "repositories.tgz", "sources.tgz", "artifacts.tgz"],
    volumeArchiveSha256: {
      snapshots: digest,
      repositories: digest,
      sources: digest,
      artifacts: digest
    },
    volumeFileCounts: { snapshots: 1, repositories: 1, sources: 1, artifacts: 1 },
    productionVolumeTouched: false,
    restoredSnapshotCount: 1,
    pgRestoreListValidated: true,
    ephemeralDatabaseRestored: true,
    healthCheckPassed: true,
    experienceRecoveryValidated: true,
    artifactContentVerifiedCount: 1,
    blobReferenceCount: 2,
    blobContentVerifiedCount: 1,
    blobHardlinkVerifiedCount: 2,
    referencedSourceBlobGenerationCount: 1,
    sourceBlobLogicalBytes: 32,
    sourceBlobPhysicalBytes: 4096,
    sourceBlobRecordManifest: {
      file: "evidence.source-blobs.ndjson",
      sha256: createHash("sha256").update(sourceBlobManifest).digest("hex"),
      recordCount: 2
    },
    databaseStats: {
      workspaceCount: 1,
      userCount: 1,
      projectCount: 1,
      projectMemberCount: 1,
      snapshotCount: 1,
      releaseCount: 1,
      releaseChannelCount: 1,
      artifactCount: 1,
      sourceAnalysisArtifactCount: 1,
      sourceBlobCount: 2,
      sourceFileBlobReferenceCount: 2,
      referencedSourceBlobGenerationCount: 1,
      frontendProjectProfileArtifactCount: 1,
      patternGroupCount: 1,
      patternEvidenceCount: 1,
      decisionCount: 1,
      outcomeCount: 1,
      experienceReviewCount: 1,
      experienceReviewItemCount: 1,
      standardCount: 1
    },
    integrity: {
      orphanedReleases: 0,
      orphanedReleaseChannels: 0,
      crossWorkspaceProjectMembers: 0,
      projectMembersWithoutWorkspaceMembership: 0,
      orphanedArtifacts: 0,
      orphanedSourceAnalysisArtifacts: 0,
      unboundSourceFiles: 0,
      invalidSourceBlobReferences: 0,
      invalidSourceProvenance: 0,
      orphanedExperienceEvidence: 0,
      experienceReleaseSnapshotMismatch: 0,
      experienceCitationSnapshotMismatch: 0,
      experienceEvidenceWithoutProfileArtifact: 0,
      invalidDecisionBasis: 0,
      invalidOutcomeEvidence: 0,
      outcomeVersionMismatch: 0,
      invalidExperienceReviewBasis: 0,
      invalidExperienceReviewItems: 0,
      invalidWorkspaceStandards: 0,
      experienceSupersessionCycles: 0
    }
  };
}

function legacyV2Evidence() {
  const evidence = validEvidence();
  evidence.schemaVersion = 2;
  for (const field of [
    "blobReferenceCount", "blobContentVerifiedCount", "blobHardlinkVerifiedCount",
    "referencedSourceBlobGenerationCount", "sourceBlobLogicalBytes", "sourceBlobPhysicalBytes",
    "sourceBlobRecordManifest", "experienceRecoveryValidated"
  ]) delete evidence[field];
  delete evidence.databaseStats.sourceBlobCount;
  delete evidence.databaseStats.sourceFileBlobReferenceCount;
  delete evidence.databaseStats.referencedSourceBlobGenerationCount;
  delete evidence.databaseStats.frontendProjectProfileArtifactCount;
  delete evidence.databaseStats.patternGroupCount;
  delete evidence.databaseStats.patternEvidenceCount;
  delete evidence.databaseStats.decisionCount;
  delete evidence.databaseStats.outcomeCount;
  delete evidence.databaseStats.experienceReviewCount;
  delete evidence.databaseStats.experienceReviewItemCount;
  delete evidence.databaseStats.standardCount;
  delete evidence.integrity.unboundSourceFiles;
  delete evidence.integrity.invalidSourceBlobReferences;
  delete evidence.integrity.invalidSourceProvenance;
  delete evidence.integrity.orphanedExperienceEvidence;
  delete evidence.integrity.experienceReleaseSnapshotMismatch;
  delete evidence.integrity.experienceCitationSnapshotMismatch;
  delete evidence.integrity.experienceEvidenceWithoutProfileArtifact;
  delete evidence.integrity.invalidDecisionBasis;
  delete evidence.integrity.invalidOutcomeEvidence;
  delete evidence.integrity.outcomeVersionMismatch;
  delete evidence.integrity.invalidExperienceReviewBasis;
  delete evidence.integrity.invalidExperienceReviewItems;
  delete evidence.integrity.invalidWorkspaceStandards;
  delete evidence.integrity.experienceSupersessionCycles;
  return evidence;
}

function runValidator(evidence, options = [], records = validSourceBlobRecords(), writeSidecar = true, setup) {
  const root = mkdtempSync(join(tmpdir(), "devkh-evidence-"));
  const path = join(root, "evidence.json");
  writeFileSync(path, `${JSON.stringify(evidence)}\n`);
  if (evidence.schemaVersion === 3 && writeSidecar && evidence.sourceBlobRecordManifest?.file) {
    writeFileSync(join(root, evidence.sourceBlobRecordManifest.file), serializeSourceBlobRecords(records));
  }
  setup?.({ root, path, sidecarPath: join(root, evidence.sourceBlobRecordManifest?.file ?? "missing.ndjson") });
  const result = spawnSync(process.execPath, [validatorScript, ...options, path], { encoding: "utf8" });
  rmSync(root, { recursive: true, force: true });
  return result;
}

test("accepts a complete representative recovery evidence document", () => {
  const result = runValidator(validEvidence());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).schemaVersion, 3);
});

test("requires and semantically validates the retained source blob record manifest", () => {
  const missing = runValidator(validEvidence(), [], validSourceBlobRecords(), false);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /source blob record manifest must be a regular no-follow file/);

  const digestMismatchEvidence = validEvidence();
  digestMismatchEvidence.sourceBlobRecordManifest.sha256 = "b".repeat(64);
  const digestMismatch = runValidator(digestMismatchEvidence);
  assert.notEqual(digestMismatch.status, 0);
  assert.match(digestMismatch.stderr, /source blob record manifest digest does not match/);

  const records = validSourceBlobRecords();
  records[0].blobMode = "0644";
  const evidence = validEvidence();
  const serialized = serializeSourceBlobRecords(records);
  evidence.sourceBlobRecordManifest.sha256 = createHash("sha256").update(serialized).digest("hex");
  const writable = runValidator(evidence, [], records);
  assert.notEqual(writable.status, 0);
  assert.match(writable.stderr, /source blob record mode must be read-only/);

  const unrelatedView = validSourceBlobRecords();
  unrelatedView[0].viewInode = "1002";
  const unrelatedEvidence = validEvidence();
  const unrelatedSerialized = serializeSourceBlobRecords(unrelatedView);
  unrelatedEvidence.sourceBlobRecordManifest.sha256 = createHash("sha256").update(unrelatedSerialized).digest("hex");
  const unrelated = runValidator(unrelatedEvidence, [], unrelatedView);
  assert.notEqual(unrelated.status, 0);
  assert.match(unrelated.stderr, /source blob record hardlink relationship is invalid/);
});

test("rejects physical inode reuse across workspaces or blob generation identities", () => {
  const crossWorkspace = validSourceBlobRecords();
  crossWorkspace[1].workspaceId = "22222222-2222-4222-8222-222222222222";
  crossWorkspace[1].storageKey = `blobs/${crossWorkspace[1].workspaceId}/aa/${digest}/1`;
  const crossWorkspaceEvidence = validEvidence();
  const crossWorkspaceManifest = serializeSourceBlobRecords(crossWorkspace);
  crossWorkspaceEvidence.sourceBlobRecordManifest.sha256 = createHash("sha256")
    .update(crossWorkspaceManifest).digest("hex");
  const crossWorkspaceResult = runValidator(crossWorkspaceEvidence, [], crossWorkspace);
  assert.notEqual(crossWorkspaceResult.status, 0);
  assert.match(crossWorkspaceResult.stderr, /source blob inode is reused across generation identities/);

  const differentGeneration = validSourceBlobRecords();
  differentGeneration[1].generation = 2;
  differentGeneration[1].storageKey = `blobs/${differentGeneration[1].workspaceId}/aa/${digest}/2`;
  const differentGenerationEvidence = validEvidence();
  const differentGenerationManifest = serializeSourceBlobRecords(differentGeneration);
  differentGenerationEvidence.sourceBlobRecordManifest.sha256 = createHash("sha256")
    .update(differentGenerationManifest).digest("hex");
  const differentGenerationResult = runValidator(differentGenerationEvidence, [], differentGeneration);
  assert.notEqual(differentGenerationResult.status, 0);
  assert.match(differentGenerationResult.stderr, /source blob inode is reused across generation identities/);
});

test("v3 evidence explicitly rejects unbound source files", () => {
  const evidence = validEvidence();
  evidence.integrity.unboundSourceFiles = 1;

  const result = runValidator(evidence);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unboundSourceFiles must be zero/);
});

test("rejects symlink and non-regular evidence or sidecar files", () => {
  const cases = [
    ["evidence symlink", ({ path }) => {
      const target = `${path}.real`;
      renameSync(path, target);
      symlinkSync(target, path);
    }],
    ["sidecar symlink", ({ sidecarPath }) => {
      const target = `${sidecarPath}.real`;
      renameSync(sidecarPath, target);
      symlinkSync(target, sidecarPath);
    }],
    ["evidence directory", ({ path }) => {
      unlinkSync(path);
      mkdirSync(path);
    }],
    ["sidecar directory", ({ sidecarPath }) => {
      unlinkSync(sidecarPath);
      mkdirSync(sidecarPath);
    }]
  ];

  for (const [name, setup] of cases) {
    const result = runValidator(validEvidence(), [], validSourceBlobRecords(), true, setup);
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, /must be a regular no-follow file/, name);
  }
});

test("rejects legacy v2 evidence by default and accepts it only with explicit compatibility", () => {
  const evidence = legacyV2Evidence();

  assert.throws(() => validateRecoveryEvidence(evidence), /schemaVersion must be 3/);
  assert.equal(validateRecoveryEvidence(evidence, { allowLegacyV2: true }).schemaVersion, 2);
  assert.notEqual(runValidator(evidence).status, 0);
  assert.equal(runValidator(evidence, ["--allow-legacy-v2"]).status, 0);
});

test("rejects incomplete or inconsistent recovery evidence", () => {
  const mutations = [
    (value) => { delete value.schemaVersion; },
    (value) => { delete value.volumeArchives; },
    (value) => { delete value.pgRestoreListValidated; },
    (value) => { delete value.integrity; },
    (value) => { delete value.integrity.orphanedArtifacts; },
    (value) => { delete value.integrity.orphanedSourceAnalysisArtifacts; },
    (value) => { delete value.integrity.unboundSourceFiles; },
    (value) => { delete value.integrity.invalidSourceBlobReferences; },
    (value) => { delete value.databaseStats.sourceAnalysisArtifactCount; },
    (value) => { delete value.databaseStats.sourceBlobCount; },
    (value) => { delete value.databaseStats.sourceFileBlobReferenceCount; },
    (value) => { delete value.databaseStats.referencedSourceBlobGenerationCount; },
    (value) => { delete value.sourceBlobRecordManifest; },
    (value) => { value.sourceBlobRecordManifest.sha256 = "invalid"; },
    (value) => { value.sourceBlobRecordManifest.recordCount = 1; },
    (value) => { value.databaseArchiveSha256 = "invalid"; },
    (value) => { value.artifactContentVerifiedCount = 0; },
    (value) => { value.blobReferenceCount = 1; },
    (value) => { value.blobContentVerifiedCount = 0; },
    (value) => { value.blobHardlinkVerifiedCount = 1; },
    (value) => { value.referencedSourceBlobGenerationCount = 2; },
    (value) => { value.databaseStats.sourceBlobCount = 0; },
    (value) => { value.sourceBlobLogicalBytes = -1; },
    (value) => { value.sourceBlobPhysicalBytes = value.sourceBlobLogicalBytes; },
    (value) => { value.resticSnapshotId = "abc123ef"; },
    (value) => { value.startedAt = 0; },
    (value) => { value.startedAt = "July 15, 2026"; },
    (value) => { value.finishedAt = "2026-07-14T23:59:59.000Z"; },
    (value) => { value.DEVKH_MASTER_KEY = "must-not-be-retained"; },
    (value) => { value.integrity.DEVKH_MASTER_KEY = "must-not-be-retained"; }
  ];

  for (const mutate of mutations) {
    const evidence = validEvidence();
    mutate(evidence);
    const result = runValidator(evidence);
    assert.notEqual(result.status, 0, JSON.stringify(evidence));
    assert.match(result.stderr, /recovery evidence validation failed/);
  }
});

test("the CI recovery drill uses the strict validator", () => {
  const script = readFileSync(join(scriptDirectory, "ci-recovery-drill.sh"), "utf8");
  assert.match(script, /validate-recovery-evidence\.mjs/);
  assert.match(script, /recovery_cleanup_failed/);
  assert.match(script, /write_status restore-drill failed/);
  assert.match(script, /RECOVERY_EVIDENCE_DEFER_FINALIZATION/);
  assert.match(script, /\*\.json\.pending/);
  assert.match(script, /\*\.json\.pending/);
  assert.match(script, /validate-recovery-evidence\.mjs" "\$evidence_path" >\/dev\/null/);
  assert.doesNotMatch(script, /--allow-legacy-v2/);
  assert.doesNotMatch(readFileSync(join(scriptDirectory, "devkh-restore-drill.sh"), "utf8"), /--allow-legacy-v2/);
});

test("the restore drill records unbound source files independently of joined blob references", () => {
  const script = readFileSync(join(scriptDirectory, "devkh-restore-drill.sh"), "utf8");
  assert.match(script, /'unboundSourceFiles'.*source_blob_id IS NULL/s);
});

test("the documented recovery evidence example passes the strict validator", () => {
  const document = readFileSync(join(scriptDirectory, "../../docs/operations/recovery-evidence.md"), "utf8");
  const json = document.match(/```json\n([\s\S]*?)\n```/)?.[1];
  const ndjson = document.match(/```ndjson\n([\s\S]*?)\n```/)?.[1];
  assert.ok(json);
  assert.ok(ndjson);
  const records = ndjson.split("\n").map((line) => JSON.parse(line));
  const result = runValidator(JSON.parse(json), [], records);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(json).schemaVersion, 3);
});
