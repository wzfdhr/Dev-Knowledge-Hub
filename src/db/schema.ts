import {
  boolean,
  bigint,
  bigserial,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import {
  AGENT_FEEDBACK_STATUSES,
  BUILD_JOB_STATUSES
} from "../shared/contracts.js";
import type { Citation } from "../server/knowledge/intelligence.js";
import type { FeedbackGenerationContext, RemediationGenerationContext } from "../server/knowledge/build-service.js";
import type { LintIssue, SourceRef } from "../shared/api-contracts.js";
import type { RemediationState } from "../server/knowledge/remediation.js";

export { AGENT_FEEDBACK_STATUSES, BUILD_JOB_STATUSES } from "../shared/contracts.js";

export const buildJobStatus = pgEnum("build_job_status", BUILD_JOB_STATUSES);
export const agentFeedbackStatus = pgEnum("agent_feedback_status", AGENT_FEEDBACK_STATUSES);
export const teamRole = pgEnum("team_role", ["admin", "member", "reader"]);

function uploadSessionWorkspaceKey(): [AnyPgColumn, AnyPgColumn] {
  return [uploadSessions.id, uploadSessions.workspaceId];
}

function importReportScopeKey(): [AnyPgColumn, AnyPgColumn, AnyPgColumn] {
  return [importReports.id, importReports.workspaceId, importReports.repositoryId];
}

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
};

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  ...timestamps
}, (table) => [uniqueIndex("workspaces_slug_idx").on(table.slug)]);

export const adminUsers = pgTable("admin_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  ...timestamps
}, (table) => [
  uniqueIndex("admin_users_id_workspace_idx").on(table.id, table.workspaceId),
  uniqueIndex("admin_users_workspace_email_idx").on(table.workspaceId, table.email)
]);

export const workspaceMembers = pgTable("workspace_members", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull(),
  role: teamRole("role").notNull().default("member"),
  ...timestamps
}, (table) => [
  uniqueIndex("workspace_members_workspace_user_idx").on(table.workspaceId, table.userId),
  index("workspace_members_workspace_role_idx").on(table.workspaceId, table.role),
  foreignKey({
    columns: [table.userId, table.workspaceId],
    foreignColumns: [adminUsers.id, adminUsers.workspaceId],
    name: "workspace_members_user_workspace_fk"
  }).onDelete("cascade")
]);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  ...timestamps
}, (table) => [
  uniqueIndex("projects_workspace_slug_idx").on(table.workspaceId, table.slug),
  uniqueIndex("projects_id_workspace_idx").on(table.id, table.workspaceId),
  index("projects_workspace_active_idx").on(table.workspaceId, table.archivedAt)
]);

export const projectFrontendRollouts = pgTable("project_frontend_rollouts", {
  projectId: uuid("project_id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  mode: text("mode").$type<"legacy" | "shadow" | "active">().notNull().default("legacy"),
  reason: text("reason").notNull(),
  updatedBy: uuid("updated_by").notNull(),
  ...timestamps
}, (table) => [
  index("project_frontend_rollouts_workspace_mode_idx").on(table.workspaceId, table.mode, table.projectId),
  foreignKey({
    columns: [table.projectId, table.workspaceId],
    foreignColumns: [projects.id, projects.workspaceId],
    name: "project_frontend_rollouts_project_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.updatedBy, table.workspaceId],
    foreignColumns: [adminUsers.id, adminUsers.workspaceId],
    name: "project_frontend_rollouts_actor_workspace_fk"
  }).onDelete("restrict")
]);

export const repositories = pgTable("repositories", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("git"),
  localPath: text("local_path"),
  cloneUrl: text("clone_url"),
  defaultBranch: text("default_branch").notNull().default("main"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  ...timestamps
}, (table) => [
  uniqueIndex("repositories_id_workspace_idx").on(table.id, table.workspaceId),
  uniqueIndex("repositories_id_workspace_project_idx").on(table.id, table.workspaceId, table.projectId),
  uniqueIndex("repositories_project_current_unique_idx")
    .on(table.projectId)
    .where(sql`${table.archivedAt} IS NULL`)
  ,
  foreignKey({
    columns: [table.projectId, table.workspaceId],
    foreignColumns: [projects.id, projects.workspaceId],
    name: "repositories_project_workspace_fk"
  }).onDelete("cascade")
]);

export const repositorySyncSchedules = pgTable("repository_sync_schedules", {
  repositoryId: uuid("repository_id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  failureCount: integer("failure_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
  lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  ...timestamps
}, (table) => [
  index("repository_sync_schedules_due_idx").on(table.nextAttemptAt),
  foreignKey({
    columns: [table.repositoryId, table.workspaceId],
    foreignColumns: [repositories.id, repositories.workspaceId],
    name: "repository_sync_schedules_repository_workspace_fk"
  }).onDelete("cascade")
]);

export const encryptedCredentials = pgTable("encrypted_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  repositoryId: uuid("repository_id"),
  name: text("name").notNull(),
  ciphertext: text("ciphertext").notNull(),
  metadata: jsonb("metadata").$type<Record<string, string>>().notNull().default({}),
  ...timestamps
}, (table) => [
  uniqueIndex("encrypted_credentials_id_workspace_idx").on(table.id, table.workspaceId),
  uniqueIndex("encrypted_credentials_repo_name_idx").on(table.repositoryId, table.name),
  uniqueIndex("encrypted_credentials_workspace_model_idx")
    .on(table.workspaceId, table.name)
    .where(sql`${table.repositoryId} IS NULL`),
  index("encrypted_credentials_workspace_idx").on(table.workspaceId),
  foreignKey({
    columns: [table.repositoryId, table.workspaceId],
    foreignColumns: [repositories.id, repositories.workspaceId],
    name: "encrypted_credentials_repository_workspace_fk"
  }).onDelete("cascade")
]);

export const sourceSnapshots = pgTable("source_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  repositoryId: uuid("repository_id").notNull(),
  commitSha: text("commit_sha").notNull(),
  ref: text("ref").notNull(),
  remoteUrl: text("remote_url"),
  commitTimestamp: timestamp("commit_timestamp", { withTimezone: true }).notNull(),
  storagePath: text("storage_path").notNull(),
  pendingUploadSessionId: uuid("pending_upload_session_id"),
  pendingImportReportId: uuid("pending_import_report_id"),
  ...timestamps
}, (table) => [
  uniqueIndex("source_snapshots_id_workspace_idx").on(table.id, table.workspaceId),
  uniqueIndex("source_snapshots_id_workspace_repository_idx").on(table.id, table.workspaceId, table.repositoryId),
  index("source_snapshots_workspace_repo_idx").on(table.workspaceId, table.repositoryId),
  uniqueIndex("source_snapshots_repo_commit_idx").on(table.repositoryId, table.commitSha)
    .where(sql`${table.pendingUploadSessionId} IS NULL AND ${table.pendingImportReportId} IS NULL`),
  uniqueIndex("source_snapshots_pending_upload_session_unique_idx")
    .on(table.pendingUploadSessionId)
    .where(sql`${table.pendingUploadSessionId} IS NOT NULL`),
  uniqueIndex("source_snapshots_pending_import_report_unique_idx")
    .on(table.pendingImportReportId)
    .where(sql`${table.pendingImportReportId} IS NOT NULL`),
  foreignKey({
    columns: [table.repositoryId, table.workspaceId],
    foreignColumns: [repositories.id, repositories.workspaceId],
    name: "source_snapshots_repository_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.pendingUploadSessionId, table.workspaceId],
    foreignColumns: uploadSessionWorkspaceKey(),
    name: "source_snapshots_pending_upload_session_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.pendingImportReportId, table.workspaceId, table.repositoryId],
    foreignColumns: importReportScopeKey(),
    name: "source_snapshots_pending_import_report_scope_fk"
  }).onDelete("cascade")
]);

export const sourceFiles = pgTable("source_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  snapshotId: uuid("snapshot_id").notNull(),
  path: text("path").notNull(),
  language: text("language"),
  contentHash: text("content_hash").notNull(),
  byteSize: integer("byte_size").notNull(),
  ...timestamps
}, (table) => [
  uniqueIndex("source_files_id_workspace_idx").on(table.id, table.workspaceId),
  uniqueIndex("source_files_snapshot_path_idx").on(table.snapshotId, table.path),
  foreignKey({
    columns: [table.snapshotId, table.workspaceId],
    foreignColumns: [sourceSnapshots.id, sourceSnapshots.workspaceId],
    name: "source_files_snapshot_workspace_fk"
  }).onDelete("cascade")
]);

export const uploadSessions = pgTable("upload_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull(),
  repositoryId: uuid("repository_id").notNull(),
  actorId: uuid("actor_id").notNull(),
  sessionVersion: integer("session_version").notNull(),
  isReplacement: boolean("is_replacement").notNull(),
  expectedCurrentRepositoryId: uuid("expected_current_repository_id").notNull(),
  expectedLatestSnapshotId: uuid("expected_latest_snapshot_id"),
  status: text("status").$type<"open" | "committing" | "committed" | "cancelled">().notNull().default("open"),
  entryCount: integer("entry_count").notNull(),
  manifestDigest: text("manifest_digest"),
  snapshotId: uuid("snapshot_id"),
  commitResponse: jsonb("commit_response").$type<Record<string, unknown>>(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  committedAt: timestamp("committed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  ...timestamps
}, (table) => [
  uniqueIndex("upload_sessions_id_workspace_idx").on(table.id, table.workspaceId),
  unique("upload_sessions_scope_unique").on(
    table.id, table.workspaceId, table.projectId, table.repositoryId, table.actorId
  ),
  index("upload_sessions_expiry_idx").on(table.expiresAt)
    .where(sql`${table.status} IN ('open', 'committing', 'committed', 'cancelled')`),
  index("upload_sessions_project_created_idx").on(table.workspaceId, table.projectId, table.createdAt.desc()),
  check("upload_sessions_status_check", sql`${table.status} IN ('open', 'committing', 'committed', 'cancelled')`),
  check("upload_sessions_entry_count_check", sql`${table.entryCount} BETWEEN 1 AND 100000`),
  check("upload_sessions_manifest_digest_check", sql`${table.manifestDigest} IS NULL OR ${table.manifestDigest} ~ '^[0-9a-f]{64}$'`),
  check("upload_sessions_terminal_shape_check", sql`
    (${table.status} = 'committed' AND ${table.manifestDigest} IS NOT NULL
      AND ${table.snapshotId} IS NOT NULL AND ${table.commitResponse} IS NOT NULL
      AND ${table.committedAt} IS NOT NULL)
    OR (${table.status} = 'cancelled' AND ${table.cancelledAt} IS NOT NULL)
    OR ${table.status} IN ('open', 'committing')
  `),
  foreignKey({
    columns: [table.projectId, table.workspaceId],
    foreignColumns: [projects.id, projects.workspaceId],
    name: "upload_sessions_project_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.repositoryId, table.workspaceId, table.projectId],
    foreignColumns: [repositories.id, repositories.workspaceId, repositories.projectId],
    name: "upload_sessions_repository_scope_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.expectedCurrentRepositoryId, table.workspaceId, table.projectId],
    foreignColumns: [repositories.id, repositories.workspaceId, repositories.projectId],
    name: "upload_sessions_expected_current_repository_scope_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.expectedLatestSnapshotId, table.workspaceId, table.repositoryId],
    foreignColumns: [sourceSnapshots.id, sourceSnapshots.workspaceId, sourceSnapshots.repositoryId],
    name: "upload_sessions_expected_latest_snapshot_scope_fk"
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.actorId, table.workspaceId],
    foreignColumns: [adminUsers.id, adminUsers.workspaceId],
    name: "upload_sessions_actor_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.snapshotId, table.workspaceId, table.repositoryId],
    foreignColumns: [sourceSnapshots.id, sourceSnapshots.workspaceId, sourceSnapshots.repositoryId],
    name: "upload_sessions_snapshot_repository_fk"
  }).onDelete("restrict")
]);

export const uploadSessionEntries = pgTable("upload_session_entries", {
  sessionId: uuid("session_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  ordinal: integer("ordinal").notNull(),
  path: text("path").notNull(),
  kind: text("kind").$type<"source" | "asset">().notNull(),
  byteSize: bigint("byte_size", { mode: "number" }).notNull(),
  contentHash: text("content_hash"),
  mediaType: text("media_type"),
  metadataByteSize: integer("metadata_byte_size").notNull(),
  disposition: text("disposition").$type<"upload_required" | "metadata_only" | "ignored">().notNull(),
  trust: text("trust").$type<"pending" | "server_verified" | "client_unverified">().notNull(),
  ignoreReason: text("ignore_reason"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
  ...timestamps
}, (table) => [
  primaryKey({ columns: [table.sessionId, table.ordinal], name: "upload_session_entries_pkey" }),
  unique("upload_session_entries_path_unique").on(table.sessionId, table.path),
  foreignKey({
    columns: [table.sessionId, table.workspaceId],
    foreignColumns: [uploadSessions.id, uploadSessions.workspaceId],
    name: "upload_session_entries_session_workspace_fk"
  }).onDelete("cascade"),
  check("upload_session_entries_ordinal_check", sql`${table.ordinal} >= 0`),
  check("upload_session_entries_path_check", sql`octet_length(${table.path}) BETWEEN 1 AND 4096`),
  check("upload_session_entries_kind_check", sql`${table.kind} IN ('source', 'asset')`),
  check("upload_session_entries_byte_size_check", sql`${table.byteSize} >= 0`),
  check("upload_session_entries_metadata_byte_size_check", sql`${table.metadataByteSize} > 0`),
  check("upload_session_entries_content_hash_check", sql`
    (${table.kind} = 'source' AND ${table.contentHash} ~ '^[0-9a-f]{64}$')
    OR (${table.kind} = 'asset' AND ${table.contentHash} IS NULL)
  `),
  check("upload_session_entries_disposition_check", sql`${table.disposition} IN ('upload_required', 'metadata_only', 'ignored')`),
  check("upload_session_entries_trust_check", sql`${table.trust} IN ('pending', 'server_verified', 'client_unverified')`),
  check("upload_session_entries_state_check", sql`
    (${table.disposition} = 'upload_required' AND ${table.trust} IN ('pending', 'server_verified') AND ${table.ignoreReason} IS NULL)
    OR (${table.disposition} = 'metadata_only' AND ${table.trust} = 'client_unverified' AND ${table.ignoreReason} IS NULL)
    OR (${table.disposition} = 'ignored' AND ${table.ignoreReason} IS NOT NULL)
  `)
]);

export const uploadIdempotencyKeys = pgTable("upload_idempotency_keys", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  actorId: uuid("actor_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  operation: text("operation").notNull(),
  requestDigest: text("request_digest").notNull(),
  sessionId: uuid("session_id"),
  responseStatus: integer("response_status").notNull(),
  responseBody: jsonb("response_body").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
}, (table) => [
  primaryKey({
    columns: [table.workspaceId, table.actorId, table.idempotencyKey],
    name: "upload_idempotency_keys_pkey"
  }),
  index("upload_idempotency_keys_expiry_idx").on(table.expiresAt),
  check("upload_idempotency_keys_key_check", sql`char_length(${table.idempotencyKey}) BETWEEN 1 AND 200`),
  check("upload_idempotency_keys_request_digest_check", sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`),
  check("upload_idempotency_keys_response_status_check", sql`${table.responseStatus} BETWEEN 200 AND 599`),
  foreignKey({
    columns: [table.actorId, table.workspaceId],
    foreignColumns: [adminUsers.id, adminUsers.workspaceId],
    name: "upload_idempotency_keys_actor_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.sessionId, table.workspaceId],
    foreignColumns: [uploadSessions.id, uploadSessions.workspaceId],
    name: "upload_idempotency_keys_session_workspace_fk"
  }).onDelete("cascade")
]);

export const importReports = pgTable("import_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  repositoryId: uuid("repository_id").references(() => repositories.id, { onDelete: "set null" }),
  actorId: uuid("actor_id").references(() => adminUsers.id, { onDelete: "set null" }),
  sourceKind: text("source_kind").notNull(),
  status: text("status").$type<"running" | "succeeded" | "failed" | "cancelled">().notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  collectedFileCount: integer("collected_file_count").notNull().default(0),
  collectedTextBytes: bigint("collected_text_bytes", { mode: "number" }).notNull().default(0),
  ignored: jsonb("ignored").$type<{ total: number; reasons: Record<string, number> }>().notNull().default({ total: 0, reasons: {} }),
  snapshotId: uuid("snapshot_id").references(() => sourceSnapshots.id, { onDelete: "set null" }),
  failureCode: text("failure_code"),
  uploadSessionId: uuid("upload_session_id")
}, (table) => [
  index("import_reports_project_started_idx").on(
    table.workspaceId, table.projectId, table.startedAt.desc(), table.id.desc()
  ),
  index("import_reports_retention_idx").on(table.status, table.finishedAt)
    .where(sql`${table.status} IN ('failed', 'cancelled')`),
  uniqueIndex("import_reports_id_workspace_repository_idx")
    .on(table.id, table.workspaceId, table.repositoryId),
  check("import_reports_status_check", sql`${table.status} IN ('running', 'succeeded', 'failed', 'cancelled')`),
  uniqueIndex("import_reports_upload_session_unique_idx")
    .on(table.uploadSessionId)
    .where(sql`${table.uploadSessionId} IS NOT NULL`),
  foreignKey({
    columns: [table.uploadSessionId, table.workspaceId, table.projectId, table.repositoryId, table.actorId],
    foreignColumns: [uploadSessions.id, uploadSessions.workspaceId, uploadSessions.projectId, uploadSessions.repositoryId, uploadSessions.actorId],
    name: "import_reports_upload_session_scope_fk"
  })
]);

export const sourceAnalysisArtifacts = pgTable("source_analysis_artifacts", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contentHash: text("content_hash").notNull(),
  analyzerId: text("analyzer_id").notNull(),
  analyzerVersion: text("analyzer_version").notNull(),
  parserConfigDigest: text("parser_config_digest").notNull(),
  facts: jsonb("facts").$type<Record<string, unknown>>().notNull(),
  factsDigest: text("facts_digest").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  primaryKey({
    columns: [table.workspaceId, table.contentHash, table.analyzerId, table.analyzerVersion, table.parserConfigDigest],
    name: "source_analysis_artifacts_pkey"
  }),
  check("source_analysis_artifacts_content_hash_check", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
  check("source_analysis_artifacts_analyzer_id_check", sql`${table.analyzerId} ~ '^[a-z0-9][a-z0-9._-]{0,127}$'`),
  check("source_analysis_artifacts_analyzer_version_check", sql`${table.analyzerVersion} ~ '^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$'`),
  check("source_analysis_artifacts_parser_config_digest_check", sql`${table.parserConfigDigest} ~ '^[0-9a-f]{64}$'`),
  check("source_analysis_artifacts_facts_object_check", sql`jsonb_typeof(${table.facts}) = 'object'`),
  check("source_analysis_artifacts_facts_size_check", sql`octet_length(${table.facts}::text) <= 8388608`),
  check("source_analysis_artifacts_facts_digest_check", sql`${table.factsDigest} ~ '^[0-9a-f]{64}$'`)
]);

export const codeSymbols = pgTable("code_symbols", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sourceFileId: uuid("source_file_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  signature: text("signature"),
  startLine: integer("start_line").notNull().default(1),
  endLine: integer("end_line").notNull().default(1),
  exported: boolean("exported").notNull().default(false),
  ...timestamps
}, (table) => [
  uniqueIndex("code_symbols_id_workspace_idx").on(table.id, table.workspaceId),
  uniqueIndex("code_symbols_source_identity_idx").on(
    table.sourceFileId, table.kind, table.name, table.startLine, table.endLine
  ),
  index("code_symbols_workspace_file_idx").on(table.workspaceId, table.sourceFileId),
  foreignKey({
    columns: [table.sourceFileId, table.workspaceId],
    foreignColumns: [sourceFiles.id, sourceFiles.workspaceId],
    name: "code_symbols_source_file_workspace_fk"
  }).onDelete("cascade")
]);

export const codeEdges = pgTable("code_edges", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sourceSymbolId: uuid("source_symbol_id"),
  targetSymbolId: uuid("target_symbol_id"),
  kind: text("kind").notNull(),
  sourceName: text("source_name").notNull().default(""),
  targetName: text("target_name").notNull().default(""),
  targetPath: text("target_path"),
  sourcePath: text("source_path").notNull().default(""),
  snapshotId: uuid("snapshot_id"),
  startLine: integer("start_line").notNull().default(1),
  endLine: integer("end_line").notNull().default(1),
  ...timestamps
}, (table) => [
  uniqueIndex("code_edges_id_workspace_idx").on(table.id, table.workspaceId),
  index("code_edges_workspace_source_idx").on(table.workspaceId, table.sourceSymbolId),
  foreignKey({
    columns: [table.sourceSymbolId, table.workspaceId],
    foreignColumns: [codeSymbols.id, codeSymbols.workspaceId],
    name: "code_edges_source_symbol_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.targetSymbolId, table.workspaceId],
    foreignColumns: [codeSymbols.id, codeSymbols.workspaceId],
    name: "code_edges_target_symbol_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.snapshotId, table.workspaceId],
    foreignColumns: [sourceSnapshots.id, sourceSnapshots.workspaceId],
    name: "code_edges_snapshot_workspace_fk"
  }).onDelete("cascade")
]);

export const buildJobs = pgTable("build_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  repositoryId: uuid("repository_id").notNull(),
  snapshotId: uuid("snapshot_id"),
  snapshotPath: text("snapshot_path").notNull().default(""),
  commitSha: text("commit_sha").notNull().default(""),
  status: buildJobStatus("status").notNull().default("queued"),
  errorMessage: text("error_message"),
  warnings: jsonb("warnings").notNull().default([]),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  purpose: text("purpose").notNull().default("standard"),
  feedbackIds: uuid("feedback_ids").array().notNull().default(sql`'{}'::uuid[]`),
  feedbackContext: jsonb("feedback_context").$type<FeedbackGenerationContext[]>()
    .notNull().default([]),
  remediationContext: jsonb("remediation_context").$type<RemediationGenerationContext[]>()
    .notNull().default([]),
  allowLlm: boolean("allow_llm").notNull().default(false),
  ...timestamps
}, (table) => [
  uniqueIndex("build_jobs_id_workspace_idx").on(table.id, table.workspaceId),
  index("build_jobs_workspace_status_idx").on(table.workspaceId, table.status),
  foreignKey({
    columns: [table.repositoryId, table.workspaceId],
    foreignColumns: [repositories.id, repositories.workspaceId],
    name: "build_jobs_repository_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.snapshotId, table.workspaceId],
    foreignColumns: [sourceSnapshots.id, sourceSnapshots.workspaceId],
    name: "build_jobs_snapshot_workspace_fk"
  })
]);

export const buildStageRuns = pgTable("build_stage_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull(),
  snapshotId: uuid("snapshot_id").notNull(),
  buildJobId: uuid("build_job_id").notNull(),
  stage: text("stage").notNull(),
  attempt: integer("attempt").notNull(),
  status: text("status").notNull().default("queued"),
  inputDigest: text("input_digest").notNull(),
  outputManifestIds: uuid("output_manifest_ids").array().notNull().default(sql`ARRAY[]::uuid[]`),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  errorCode: text("error_code"),
  errorDetail: text("error_detail"),
  ...timestamps
}, (table) => [
  uniqueIndex("build_stage_runs_build_stage_attempt_idx").on(table.buildJobId, table.stage, table.attempt),
  index("build_stage_runs_claim_idx").on(table.workspaceId, table.projectId, table.status, table.createdAt, table.id),
  index("build_stage_runs_build_idx").on(table.workspaceId, table.buildJobId, table.stage, table.attempt),
  foreignKey({
    columns: [table.projectId, table.workspaceId],
    foreignColumns: [projects.id, projects.workspaceId],
    name: "build_stage_runs_project_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.snapshotId, table.workspaceId],
    foreignColumns: [sourceSnapshots.id, sourceSnapshots.workspaceId],
    name: "build_stage_runs_snapshot_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.buildJobId, table.workspaceId],
    foreignColumns: [buildJobs.id, buildJobs.workspaceId],
    name: "build_stage_runs_build_workspace_fk"
  }).onDelete("cascade")
]);

export const knowledgeArtifacts = pgTable("knowledge_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull(),
  snapshotId: uuid("snapshot_id").notNull(),
  buildJobId: uuid("build_job_id").notNull(),
  stage: text("stage").notNull(),
  kind: text("kind").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  inputDigest: text("input_digest").notNull(),
  contentDigest: text("content_digest").notNull(),
  storageKey: text("storage_key").notNull(),
  sourceRefs: jsonb("source_refs").$type<SourceRef[]>().notNull().default([]),
  producer: text("producer").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  uniqueIndex("knowledge_artifacts_cache_unique_idx").on(
    table.projectId, table.snapshotId, table.stage, table.kind, table.inputDigest
  ),
  uniqueIndex("knowledge_artifacts_storage_key_idx").on(table.storageKey),
  index("knowledge_artifacts_build_idx").on(
    table.workspaceId, table.projectId, table.buildJobId, table.stage, table.createdAt
  ),
  index("knowledge_artifacts_cache_idx").on(
    table.workspaceId, table.projectId, table.snapshotId, table.stage, table.kind, table.inputDigest
  ),
  foreignKey({
    columns: [table.projectId, table.workspaceId],
    foreignColumns: [projects.id, projects.workspaceId],
    name: "knowledge_artifacts_project_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.snapshotId, table.workspaceId],
    foreignColumns: [sourceSnapshots.id, sourceSnapshots.workspaceId],
    name: "knowledge_artifacts_snapshot_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.buildJobId, table.workspaceId],
    foreignColumns: [buildJobs.id, buildJobs.workspaceId],
    name: "knowledge_artifacts_build_workspace_fk"
  }).onDelete("restrict")
]);

export const knowledgePages = pgTable("knowledge_pages", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  repositoryId: uuid("repository_id").notNull(),
  buildJobId: uuid("build_job_id").notNull(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  ...timestamps
}, (table) => [
  uniqueIndex("knowledge_pages_id_workspace_idx").on(table.id, table.workspaceId),
  uniqueIndex("knowledge_pages_build_slug_idx").on(table.buildJobId, table.slug),
  foreignKey({
    columns: [table.repositoryId, table.workspaceId],
    foreignColumns: [repositories.id, repositories.workspaceId],
    name: "knowledge_pages_repository_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.buildJobId, table.workspaceId],
    foreignColumns: [buildJobs.id, buildJobs.workspaceId],
    name: "knowledge_pages_build_job_workspace_fk"
  }).onDelete("cascade")
]);

export const knowledgeChunks = pgTable("knowledge_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  pageId: uuid("page_id").notNull(),
  position: integer("position").notNull(),
  heading: text("heading"),
  content: text("content").notNull(),
  citations: jsonb("citations").notNull().default([]),
  ...timestamps
}, (table) => [
  uniqueIndex("knowledge_chunks_id_workspace_idx").on(table.id, table.workspaceId),
  uniqueIndex("knowledge_chunks_page_position_idx").on(table.pageId, table.position),
  index("knowledge_chunks_workspace_page_idx").on(table.workspaceId, table.pageId),
  foreignKey({
    columns: [table.pageId, table.workspaceId],
    foreignColumns: [knowledgePages.id, knowledgePages.workspaceId],
    name: "knowledge_chunks_page_workspace_fk"
  }).onDelete("cascade")
]);

export const pipelineSearchDocuments = pgTable("pipeline_search_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull(),
  snapshotId: uuid("snapshot_id").notNull(),
  buildJobId: uuid("build_job_id").notNull(),
  sourceArtifactId: uuid("source_artifact_id").notNull(),
  documentKey: text("document_key").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  citations: jsonb("citations").$type<SourceRef[]>().notNull().default([]),
  metadata: jsonb("metadata").$type<Record<string, string | number | boolean>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  uniqueIndex("pipeline_search_documents_build_artifact_key_idx").on(
    table.buildJobId, table.sourceArtifactId, table.documentKey
  ),
  index("pipeline_search_documents_scope_idx").on(
    table.workspaceId, table.projectId, table.buildJobId, table.kind, table.documentKey
  ),
  foreignKey({
    columns: [table.projectId, table.workspaceId],
    foreignColumns: [projects.id, projects.workspaceId],
    name: "pipeline_search_documents_project_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.snapshotId, table.workspaceId],
    foreignColumns: [sourceSnapshots.id, sourceSnapshots.workspaceId],
    name: "pipeline_search_documents_snapshot_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.buildJobId, table.workspaceId],
    foreignColumns: [buildJobs.id, buildJobs.workspaceId],
    name: "pipeline_search_documents_build_workspace_fk"
  }).onDelete("cascade")
]);

export const releases = pgTable("releases", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  repositoryId: uuid("repository_id").notNull(),
  buildJobId: uuid("build_job_id").notNull(),
  snapshotId: uuid("snapshot_id").notNull(),
  version: text("version").notNull(),
  kernelMode: text("kernel_mode").notNull().default("legacy"),
  packageArtifactId: uuid("package_artifact_id").references(() => knowledgeArtifacts.id, { onDelete: "restrict" }),
  releaseArtifactFamily: text("release_artifact_family").notNull().default("knowledge-v1"),
  packageStageRunId: uuid("package_stage_run_id").references(() => buildStageRuns.id, { onDelete: "restrict" }),
  frontendIrSchemaVersion: integer("frontend_ir_schema_version"),
  frontendGraphSchemaVersion: integer("frontend_graph_schema_version"),
  analyzerManifestDigest: text("analyzer_manifest_digest"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  ...timestamps
}, (table) => [
  uniqueIndex("releases_id_workspace_idx").on(table.id, table.workspaceId),
  uniqueIndex("releases_repository_version_idx").on(table.repositoryId, table.version),
  foreignKey({
    columns: [table.repositoryId, table.workspaceId],
    foreignColumns: [repositories.id, repositories.workspaceId],
    name: "releases_repository_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.buildJobId, table.workspaceId],
    foreignColumns: [buildJobs.id, buildJobs.workspaceId],
    name: "releases_build_job_workspace_fk"
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.snapshotId, table.workspaceId],
    foreignColumns: [sourceSnapshots.id, sourceSnapshots.workspaceId],
    name: "releases_snapshot_workspace_fk"
  }).onDelete("restrict"),
  check("releases_artifact_family_check", sql`${table.releaseArtifactFamily} IN ('knowledge-v1', 'frontend-v2')`),
  check("releases_frontend_provenance_shape_check", sql`
    (${table.releaseArtifactFamily} = 'knowledge-v1'
      AND ${table.packageStageRunId} IS NULL
      AND ${table.frontendIrSchemaVersion} IS NULL
      AND ${table.frontendGraphSchemaVersion} IS NULL
      AND ${table.analyzerManifestDigest} IS NULL)
    OR
    (${table.releaseArtifactFamily} = 'frontend-v2'
      AND ${table.packageStageRunId} IS NOT NULL
      AND ${table.packageArtifactId} IS NOT NULL
      AND ${table.frontendIrSchemaVersion} = 2
      AND ${table.frontendGraphSchemaVersion} = 2
      AND ${table.analyzerManifestDigest} ~ '^[0-9a-f]{64}$')
  `)
]);

export const releaseArtifacts = pgTable("release_artifacts", {
  releaseId: uuid("release_id").notNull().references(() => releases.id, { onDelete: "cascade" }),
  artifactId: uuid("artifact_id").notNull().references(() => knowledgeArtifacts.id, { onDelete: "restrict" })
}, (table) => [
  primaryKey({ columns: [table.releaseId, table.artifactId] }),
  index("release_artifacts_artifact_idx").on(table.artifactId, table.releaseId)
]);

export const buildEvents = pgTable("build_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  sequence: bigserial("sequence", { mode: "number" }).notNull(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  buildJobId: uuid("build_job_id").notNull(),
  status: buildJobStatus("status").notNull(),
  payload: jsonb("payload").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  index("build_events_build_created_idx").on(table.buildJobId, table.createdAt),
  foreignKey({
    columns: [table.buildJobId, table.workspaceId],
    foreignColumns: [buildJobs.id, buildJobs.workspaceId],
    name: "build_events_build_workspace_fk"
  }).onDelete("cascade")
]);

export const releaseChannels = pgTable("release_channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  repositoryId: uuid("repository_id").notNull(),
  releaseId: uuid("release_id"),
  name: text("name").notNull(),
  ...timestamps
}, (table) => [
  uniqueIndex("release_channels_id_workspace_idx").on(table.id, table.workspaceId),
  uniqueIndex("release_channels_repository_name_idx").on(table.repositoryId, table.name),
  foreignKey({
    columns: [table.repositoryId, table.workspaceId],
    foreignColumns: [repositories.id, repositories.workspaceId],
    name: "release_channels_repository_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.releaseId, table.workspaceId],
    foreignColumns: [releases.id, releases.workspaceId],
    name: "release_channels_release_workspace_fk"
  })
]);

export const mcpTokens = pgTable("mcp_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id"),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  tokenPrefix: text("token_prefix").notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  ...timestamps
}, (table) => [
  uniqueIndex("mcp_tokens_id_workspace_idx").on(table.id, table.workspaceId),
  uniqueIndex("mcp_tokens_hash_idx").on(table.tokenHash),
  index("mcp_tokens_workspace_idx").on(table.workspaceId),
  index("mcp_tokens_workspace_project_idx").on(table.workspaceId, table.projectId)
]);

export const agentFeedback = pgTable("agent_feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  pageId: uuid("page_id"),
  releaseId: uuid("release_id"),
  status: agentFeedbackStatus("status").notNull().default("open"),
  query: text("query").notNull(),
  reason: text("reason").notNull(),
  expected: text("expected"),
  citations: jsonb("citations").$type<Citation[]>()
    .notNull().default([]),
  rebuildBuildId: uuid("rebuild_build_id"),
  ...timestamps
}, (table) => [
  uniqueIndex("agent_feedback_id_workspace_idx").on(table.id, table.workspaceId),
  index("agent_feedback_workspace_status_idx").on(table.workspaceId, table.status),
  foreignKey({
    columns: [table.pageId, table.workspaceId],
    foreignColumns: [knowledgePages.id, knowledgePages.workspaceId],
    name: "agent_feedback_page_workspace_fk"
  }),
  foreignKey({
    columns: [table.releaseId, table.workspaceId],
    foreignColumns: [releases.id, releases.workspaceId],
    name: "agent_feedback_release_workspace_fk"
  }),
  foreignKey({
    columns: [table.rebuildBuildId, table.workspaceId],
    foreignColumns: [buildJobs.id, buildJobs.workspaceId],
    name: "agent_feedback_rebuild_workspace_fk"
  })
]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  actorId: uuid("actor_id"),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  metadata: jsonb("metadata").notNull().default({}),
  ...timestamps
}, (table) => [
  uniqueIndex("audit_events_id_workspace_idx").on(table.id, table.workspaceId),
  index("audit_events_workspace_created_idx").on(table.workspaceId, table.createdAt),
  foreignKey({
    columns: [table.actorId, table.workspaceId],
    foreignColumns: [adminUsers.id, adminUsers.workspaceId],
    name: "audit_events_actor_workspace_fk"
  })
]);

export const remediationCases = pgTable("remediation_cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull(),
  repositoryId: uuid("repository_id").notNull(),
  sourceBuildId: uuid("source_build_id").notNull(),
  issueId: text("issue_id").notNull(),
  issue: jsonb("issue").$type<LintIssue>().notNull(),
  state: text("state").$type<RemediationState>().notNull().default("open"),
  rebuildBuildId: uuid("rebuild_build_id"),
  ...timestamps
}, (table) => [
  uniqueIndex("remediation_cases_id_workspace_idx").on(table.id, table.workspaceId),
  uniqueIndex("remediation_cases_source_issue_unique").on(table.workspaceId, table.sourceBuildId, table.issueId),
  index("remediation_cases_project_state_idx").on(table.workspaceId, table.projectId, table.state, table.createdAt),
  foreignKey({
    columns: [table.projectId, table.workspaceId],
    foreignColumns: [projects.id, projects.workspaceId],
    name: "remediation_cases_project_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.repositoryId, table.workspaceId],
    foreignColumns: [repositories.id, repositories.workspaceId],
    name: "remediation_cases_repository_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.sourceBuildId, table.workspaceId],
    foreignColumns: [buildJobs.id, buildJobs.workspaceId],
    name: "remediation_cases_source_build_workspace_fk"
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.rebuildBuildId, table.workspaceId],
    foreignColumns: [buildJobs.id, buildJobs.workspaceId],
    name: "remediation_cases_rebuild_build_workspace_fk"
  }).onDelete("restrict")
]);

export const remediationEvents = pgTable("remediation_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  sequence: bigserial("sequence", { mode: "number" }).notNull(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  remediationId: uuid("remediation_id").notNull(),
  fromState: text("from_state").$type<RemediationState>().notNull(),
  toState: text("to_state").$type<RemediationState>().notNull(),
  actorId: uuid("actor_id"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  uniqueIndex("remediation_events_id_workspace_idx").on(table.id, table.workspaceId),
  index("remediation_events_case_idx").on(table.workspaceId, table.remediationId, table.sequence),
  foreignKey({
    columns: [table.remediationId, table.workspaceId],
    foreignColumns: [remediationCases.id, remediationCases.workspaceId],
    name: "remediation_events_case_workspace_fk"
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.actorId, table.workspaceId],
    foreignColumns: [adminUsers.id, adminUsers.workspaceId],
    name: "remediation_events_actor_workspace_fk"
  }).onDelete("restrict")
]);
