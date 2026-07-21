import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";

import { resolveMigrationDirectory } from "./migrate";

test("resolves production migrations from the application working directory", () => {
  expect(resolveMigrationDirectory("/srv/devkh")).toBe(path.join("/srv/devkh", "drizzle"));
});

test("assigns every migration a unique ordered prefix", async () => {
  const names = (await readdir(resolveMigrationDirectory()))
    .filter((name) => name.endsWith(".sql"));
  const prefixes = names.map((name) => name.split("_", 1)[0]);

  expect(new Set(prefixes).size).toBe(prefixes.length);
});

test("defines an immutable workspace-scoped source analysis cache migration", async () => {
  const sql = await readFile(path.join(resolveMigrationDirectory(), "0032_source_analysis_artifacts.sql"), "utf8");

  expect(sql).toMatch(/CREATE TABLE source_analysis_artifacts/);
  expect(sql).toMatch(/PRIMARY KEY \(workspace_id, content_hash, analyzer_id, analyzer_version, parser_config_digest\)/);
  expect(sql).toMatch(/REFERENCES workspaces\(id\) ON DELETE CASCADE/);
  expect(sql).toMatch(/jsonb_typeof\(facts\) = 'object'/);
  expect(sql).toMatch(/octet_length\(facts::text\) <= 8388608/);
  expect(sql).toMatch(/source analysis artifacts are immutable/);
  expect(sql).not.toMatch(/project_id|snapshot_id|source_refs|storage_key/);
});

test("defines durable project upload sessions, manifest entries, and idempotency results", async () => {
  const sql = await readFile(path.join(resolveMigrationDirectory(), "0033_upload_sessions.sql"), "utf8");

  expect(sql).toMatch(/CREATE TABLE upload_sessions/);
  expect(sql).toMatch(/session_version integer NOT NULL/);
  expect(sql).toMatch(/expires_at timestamptz NOT NULL/);
  expect(sql).toMatch(/CREATE TABLE upload_session_entries/);
  expect(sql).toMatch(/PRIMARY KEY \(session_id, ordinal\)/);
  expect(sql).toMatch(/UNIQUE \(session_id, path\)/);
  expect(sql).toMatch(/metadata_byte_size integer NOT NULL/);
  expect(sql).toMatch(/upload_session_entries_metadata_byte_size_check/);
  expect(sql).toMatch(/CREATE TABLE upload_idempotency_keys/);
  expect(sql).toMatch(/PRIMARY KEY \(workspace_id, actor_id, idempotency_key\)/);
  expect(sql).toMatch(/request_digest text NOT NULL/);
  expect(sql).toMatch(/response_body jsonb NOT NULL/);
  expect(sql).toMatch(/commit_response jsonb/);
  expect(sql).toMatch(/FOREIGN KEY \(repository_id, workspace_id, project_id\)/);
  expect(sql).toMatch(/FOREIGN KEY \(snapshot_id, workspace_id, repository_id\)/);
  expect(sql).toMatch(/import_reports_upload_session_unique_idx/);
  expect(sql).toMatch(/pending_upload_session_id uuid/);
  expect(sql).toMatch(/pending_import_report_id uuid/);
  expect(sql).toMatch(/import_reports_id_workspace_repository_idx/);
  expect(sql).toMatch(/FOREIGN KEY \(pending_import_report_id, workspace_id, repository_id\)/);
  expect(sql).toMatch(/upload_sessions_scope_unique/);
  expect(sql).toMatch(/CREATE UNIQUE INDEX upload_sessions_id_workspace_idx ON upload_sessions \(id, workspace_id\)/);
  expect(sql).toMatch(/expected_current_repository_id uuid NOT NULL/);
  expect(sql).toMatch(/expected_latest_snapshot_id uuid/);
  expect(sql).toMatch(/upload_sessions_expected_latest_snapshot_scope_fk/);
  expect(sql).toMatch(/WHERE pending_upload_session_id IS NULL AND pending_import_report_id IS NULL/);
  expect(sql).toMatch(/upload_sessions_expected_current_repository_scope_fk/);
  expect(sql).toMatch(/FOREIGN KEY \(upload_session_id, workspace_id, project_id, repository_id, actor_id\)/);
});

test("expands workspace source blobs without contracting legacy snapshot storage", async () => {
  const sql = await readFile(path.join(resolveMigrationDirectory(), "0034_source_blobs.sql"), "utf8");

  expect(sql).toMatch(/CREATE TABLE source_blobs/);
  expect(sql).toMatch(/UNIQUE \(workspace_id, content_hash, generation\)/);
  expect(sql).toMatch(/source_blobs_live_workspace_hash_idx/);
  expect(sql).toMatch(/WHERE status IN \('active', 'tombstoned'\)/);
  expect(sql).toMatch(/ALTER TABLE source_files ADD COLUMN source_blob_id uuid/);
  expect(sql).toMatch(/source_files_source_blob_workspace_fk/);
  expect(sql).not.toMatch(/source_blob_id uuid NOT NULL/);
  expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|DELETE FROM source_files/);
});

test("contracts source blob references only after an authorized locked revalidation", async () => {
  const sql = await readFile(path.join(resolveMigrationDirectory(), "0035_source_blobs_contract.sql"), "utf8");

  expect(sql).toMatch(/current_setting\('devkh\.source_blob_contract_authorized', true\)/);
  expect(sql).toMatch(/source blob contract migration is not authorized/i);
  expect(sql).toMatch(/LOCK TABLE source_files, source_blobs/);
  expect(sql).toMatch(/source_blob_id IS NULL/);
  expect(sql).toMatch(/blob\.workspace_id <> file\.workspace_id/);
  expect(sql).toMatch(/blob\.content_hash <> file\.content_hash/);
  expect(sql).toMatch(/blob\.byte_size <> file\.byte_size/);
  expect(sql).toMatch(/blob\.generation < 1/);
  expect(sql).toMatch(/blob\.status <> 'active'/);
  expect(sql).toMatch(/source_blobs_reference_identity_unique/);
  expect(sql).toMatch(/FOREIGN KEY \(source_blob_id, workspace_id, content_hash, byte_size\)/);
  expect(sql).toMatch(/ALTER COLUMN source_blob_id SET NOT NULL/);
  expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|DELETE FROM|TRUNCATE/);
});

test("fails closed before a container can include the contract migration", async () => {
  // @ts-expect-error The release verifier is an intentionally plain Node ESM entrypoint.
  const releaseVerifier = await import("../../scripts/release-verify.mjs");
  const {
    assertSourceBlobContractReleaseGates,
    validateSourceBlobContractRecoveryEvidence
  } = releaseVerifier;
  const complete = {
    DEVKH_SOURCE_BLOB_CONTRACT_AUTHORIZED: "true",
    DEVKH_SOURCE_BLOB_FORWARD_COMPATIBLE_HEALTHY: "true",
    DEVKH_SOURCE_BLOB_BACKFILL_COMPLETE: "true",
    DEVKH_SOURCE_BLOB_ACTIVE_PREFLIGHT: "passed",
    DEVKH_SOURCE_BLOB_DISK_CAPACITY_VALIDATED: "true",
    DEVKH_SOURCE_BLOB_HISTORIC_RELEASES_VALIDATED: "true",
    DEVKH_SOURCE_STORAGE_MODE: "shadow",
    DEVKH_SOURCE_BLOB_DUAL_READ_STARTED_AT: "2026-07-01T00:00:00.000Z",
    DEVKH_SOURCE_BLOB_RECOVERY_EVIDENCE_PATH: "/tmp/recovery.json"
  };

  expect(() => assertSourceBlobContractReleaseGates({}, {
    contractMigrationPresent: true,
    now: new Date("2026-07-09T00:00:00.000Z")
  })).toThrow(/not authorized/i);
  expect(() => assertSourceBlobContractReleaseGates(complete, {
    contractMigrationPresent: true,
    now: new Date("2026-07-07T23:59:59.999Z")
  })).toThrow(/seven days/i);
  expect(assertSourceBlobContractReleaseGates(complete, {
    contractMigrationPresent: true,
    now: new Date("2026-07-09T00:00:00.000Z")
  })).toEqual({ recoveryEvidencePath: "/tmp/recovery.json" });
  await expect(validateSourceBlobContractRecoveryEvidence("/tmp/recovery.json", {
    now: new Date("2026-07-09T00:00:00.000Z"),
    validateEvidence: async () => ({ finishedAt: "2026-07-07T23:59:59.999Z" })
  })).rejects.toThrow(/expired/i);
});
