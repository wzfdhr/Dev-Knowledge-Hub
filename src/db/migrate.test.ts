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

test("separates Git commit identity from upload content versions", async () => {
  const sql = await readFile(path.join(resolveMigrationDirectory(), "0036_frontend_experience_source_provenance.sql"), "utf8");

  expect(sql).toMatch(/ADD COLUMN source_kind text/);
  expect(sql).toMatch(/ADD COLUMN git_commit_sha text/);
  expect(sql).toMatch(/ADD COLUMN content_version text/);
  expect(sql).toMatch(/ADD COLUMN attestation text/);
  expect(sql).toMatch(/source_snapshots_provenance_shape_check/);
  expect(sql).toMatch(/kind = 'upload'/);
  expect(sql).toMatch(/kind IN \('git', 'local'\)/);
  expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|DELETE FROM|TRUNCATE/);
});

test("creates workspace-isolated frontend experience contracts", async () => {
  const sql = await readFile(path.join(resolveMigrationDirectory(), "0037_frontend_experience_contracts.sql"), "utf8");

  for (const table of [
    "workspace_pattern_groups", "workspace_pattern_evidence", "workspace_decisions",
    "workspace_outcomes", "workspace_experience_reviews", "workspace_experience_review_items",
    "workspace_standards"
  ]) expect(sql).toContain(`CREATE TABLE ${table}`);
  expect(sql).toMatch(/workspace_pattern_groups_state_check/);
  expect(sql).toMatch(/workspace_pattern_evidence_source_eligibility_check/);
  expect(sql).toMatch(/workspace_decisions_basis_check/);
  expect(sql).toMatch(/workspace_experience_reviews_basis_check/);
  expect(sql).toMatch(/workspace_pattern_groups_no_self_supersession_check/);
  expect(sql).toMatch(/workspace_decisions_validate_basis_trigger/);
  expect(sql).toMatch(/workspace_experience_reviews_append_only_trigger/);
  expect(sql).toMatch(/workspace_experience_review_items_append_only_trigger/);
  expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|TRUNCATE/);
});

test("creates user-bound workspace MCP tokens without widening project token scopes", async () => {
  const sql = await readFile(path.join(resolveMigrationDirectory(), "0038_workspace_mcp_tokens.sql"), "utf8");

  expect(sql).toContain("CREATE TABLE workspace_mcp_tokens");
  expect(sql).toMatch(/workspace_mcp_tokens_owner_workspace_fk/);
  expect(sql).toContain("workspace.patterns.read");
  expect(sql).toContain("workspace.solutions.read");
  expect(sql).toMatch(/interval '30 days'/);
  expect(sql).not.toContain("ALTER TABLE mcp_tokens");
});
