import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const validatorScript = join(scriptDirectory, "validate-recovery-evidence.mjs");
const digest = "a".repeat(64);

function validEvidence() {
  return {
    schemaVersion: 2,
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
    artifactContentVerifiedCount: 1,
    databaseStats: {
      workspaceCount: 1,
      userCount: 1,
      projectCount: 1,
      projectMemberCount: 1,
      snapshotCount: 1,
      releaseCount: 1,
      releaseChannelCount: 1,
      artifactCount: 1,
      sourceAnalysisArtifactCount: 1
    },
    integrity: {
      orphanedReleases: 0,
      orphanedReleaseChannels: 0,
      crossWorkspaceProjectMembers: 0,
      projectMembersWithoutWorkspaceMembership: 0,
      orphanedArtifacts: 0,
      orphanedSourceAnalysisArtifacts: 0
    }
  };
}

function runValidator(evidence) {
  const root = mkdtempSync(join(tmpdir(), "devkh-evidence-"));
  const path = join(root, "evidence.json");
  writeFileSync(path, `${JSON.stringify(evidence)}\n`);
  const result = spawnSync(process.execPath, [validatorScript, path], { encoding: "utf8" });
  rmSync(root, { recursive: true, force: true });
  return result;
}

test("accepts a complete representative recovery evidence document", () => {
  const result = runValidator(validEvidence());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).schemaVersion, 2);
});

test("rejects incomplete or inconsistent recovery evidence", () => {
  const mutations = [
    (value) => { delete value.schemaVersion; },
    (value) => { delete value.volumeArchives; },
    (value) => { delete value.pgRestoreListValidated; },
    (value) => { delete value.integrity; },
    (value) => { delete value.integrity.orphanedArtifacts; },
    (value) => { delete value.integrity.orphanedSourceAnalysisArtifacts; },
    (value) => { delete value.databaseStats.sourceAnalysisArtifactCount; },
    (value) => { value.databaseArchiveSha256 = "invalid"; },
    (value) => { value.artifactContentVerifiedCount = 0; },
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
});

test("the documented recovery evidence example passes the strict validator", () => {
  const document = readFileSync(join(scriptDirectory, "../../docs/operations/recovery-evidence.md"), "utf8");
  const json = document.match(/```json\n([\s\S]*?)\n```/)?.[1];
  assert.ok(json);
  const result = runValidator(JSON.parse(json));
  assert.equal(result.status, 0, result.stderr);
});
