import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

export const BUILD_JOB_STATUSES = [
  "queued",
  "syncing",
  "parsing",
  "synthesizing",
  "validating",
  "ready",
  "published",
  "failed"
] as const;

export const AGENT_FEEDBACK_STATUSES = [
  "open",
  "acknowledged",
  "fixed",
  "dismissed"
] as const;

export const buildJobStatus = pgEnum("build_job_status", BUILD_JOB_STATUSES);
export const agentFeedbackStatus = pgEnum("agent_feedback_status", AGENT_FEEDBACK_STATUSES);

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
}, (table) => [uniqueIndex("admin_users_workspace_email_idx").on(table.workspaceId, table.email)]);

export const repositories = pgTable("repositories", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  cloneUrl: text("clone_url").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  ...timestamps
}, (table) => [index("repositories_workspace_idx").on(table.workspaceId)]);

export const encryptedCredentials = pgTable("encrypted_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  ciphertext: text("ciphertext").notNull(),
  ...timestamps
}, (table) => [index("encrypted_credentials_workspace_idx").on(table.workspaceId)]);

export const sourceSnapshots = pgTable("source_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  commitSha: text("commit_sha").notNull(),
  ref: text("ref").notNull(),
  ...timestamps
}, (table) => [index("source_snapshots_workspace_repo_idx").on(table.workspaceId, table.repositoryId)]);

export const sourceFiles = pgTable("source_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  snapshotId: uuid("snapshot_id").notNull().references(() => sourceSnapshots.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  language: text("language"),
  contentHash: text("content_hash").notNull(),
  ...timestamps
}, (table) => [uniqueIndex("source_files_snapshot_path_idx").on(table.snapshotId, table.path)]);

export const codeSymbols = pgTable("code_symbols", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sourceFileId: uuid("source_file_id").notNull().references(() => sourceFiles.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  signature: text("signature"),
  ...timestamps
}, (table) => [index("code_symbols_workspace_file_idx").on(table.workspaceId, table.sourceFileId)]);

export const codeEdges = pgTable("code_edges", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sourceSymbolId: uuid("source_symbol_id").notNull().references(() => codeSymbols.id, { onDelete: "cascade" }),
  targetSymbolId: uuid("target_symbol_id").notNull().references(() => codeSymbols.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  ...timestamps
}, (table) => [index("code_edges_workspace_source_idx").on(table.workspaceId, table.sourceSymbolId)]);

export const buildJobs = pgTable("build_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  snapshotId: uuid("snapshot_id").references(() => sourceSnapshots.id, { onDelete: "set null" }),
  status: buildJobStatus("status").notNull().default("queued"),
  errorMessage: text("error_message"),
  ...timestamps
}, (table) => [index("build_jobs_workspace_status_idx").on(table.workspaceId, table.status)]);

export const knowledgePages = pgTable("knowledge_pages", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  ...timestamps
}, (table) => [uniqueIndex("knowledge_pages_repository_slug_idx").on(table.repositoryId, table.slug)]);

export const knowledgeChunks = pgTable("knowledge_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  pageId: uuid("page_id").notNull().references(() => knowledgePages.id, { onDelete: "cascade" }),
  heading: text("heading"),
  content: text("content").notNull(),
  ...timestamps
}, (table) => [index("knowledge_chunks_workspace_page_idx").on(table.workspaceId, table.pageId)]);

export const releases = pgTable("releases", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  buildJobId: uuid("build_job_id").notNull().references(() => buildJobs.id, { onDelete: "restrict" }),
  version: text("version").notNull(),
  ...timestamps
}, (table) => [uniqueIndex("releases_repository_version_idx").on(table.repositoryId, table.version)]);

export const releaseChannels = pgTable("release_channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  releaseId: uuid("release_id").references(() => releases.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  ...timestamps
}, (table) => [uniqueIndex("release_channels_repository_name_idx").on(table.repositoryId, table.name)]);

export const mcpTokens = pgTable("mcp_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  ...timestamps
}, (table) => [index("mcp_tokens_workspace_idx").on(table.workspaceId)]);

export const agentFeedback = pgTable("agent_feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  pageId: uuid("page_id").references(() => knowledgePages.id, { onDelete: "set null" }),
  status: agentFeedbackStatus("status").notNull().default("open"),
  message: text("message").notNull(),
  ...timestamps
}, (table) => [index("agent_feedback_workspace_status_idx").on(table.workspaceId, table.status)]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  actorId: uuid("actor_id").references(() => adminUsers.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  metadata: jsonb("metadata").notNull().default({}),
  ...timestamps
}, (table) => [index("audit_events_workspace_created_idx").on(table.workspaceId, table.createdAt)]);
