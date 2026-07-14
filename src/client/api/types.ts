import type { AgentFeedbackStatus } from "../../server/persistence/store";
import type { BuildStatus } from "../../server/knowledge/build-service";

export interface Admin { id: string; email: string; role?: "admin" | "member" | "reader" }
export interface Session { authenticated: true; admin: Admin }
export interface MfaStatus { enabled: boolean; pending: boolean; lockedUntil: string | null }
export interface TeamMember {
  id: string;
  email: string;
  role: "admin" | "member" | "reader";
  createdAt?: string;
  disabledAt?: string | null;
}
export type ProjectMember = TeamMember;
export interface Project {
  id: string;
  name: string;
  slug: string;
  archivedAt: string | null;
  createdAt: string;
}
export interface ProjectSummary {
  project: Project;
  repository: Repository | null;
  latestSnapshot: RepositoryStatus["latestSnapshot"];
  currentRelease: Release | null;
  latestBuild: Build | null;
  memberCount: number;
  indexedTextBytes?: number;
  pendingFeedbackCount?: number;
}
export interface ProjectKnowledgeQuality {
  repository: Repository | null;
  latestSnapshot: RepositoryStatus["latestSnapshot"];
  currentRelease: Release | null;
  latestBuild: Build | null;
  pendingFeedbackCount: number;
  indexedTextBytes: number;
  knowledge: { pageCount: number; chunkCount: number; citationCount: number };
  change: SnapshotChangeSummary | null;
  diagnostics: Array<{ code: "SOURCE_MISSING" | "SNAPSHOT_MISSING" | "BUILD_FAILED" | "RELEASE_MISSING" | "REBUILD_RECOMMENDED" | "PUBLISHED" }>;
}
export interface WorkspaceOverview {
  projects: ProjectSummary[];
  totals: { projects: number; connected: number; published: number; members: number };
}
export interface ProjectActivity {
  id: string;
  projectId: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}
export interface Repository {
  id: string;
  projectId: string;
  kind: "local" | "git" | "upload";
  name: string;
  path?: string | null;
  url?: string | null;
  hasCredential?: boolean;
  defaultBranch: string;
}
export interface ArchivedRepository {
  id: string;
  name: string;
  kind: Repository["kind"];
  archivedAt: string;
}
export interface UploadSnapshotSummary {
  snapshotId: string;
  sourceVersion: string;
  fileCount: number;
  unchanged: boolean;
  ignored: { total: number; reasons: Record<string, number> };
}
export interface ImportReport {
  id: string;
  projectId: string;
  repositoryId: string | null;
  sourceKind: Repository["kind"];
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string | null;
  collectedFileCount: number;
  collectedTextBytes: number;
  ignored: { total: number; reasons: Record<string, number> };
  snapshotId: string | null;
  failureCode: string | null;
}
export type ImportPhase = "reading" | "filtering" | "packaging" | "uploading" | "validating" | "snapshot";
export type ImportRunStatus = "idle" | "running" | "paused" | "failed" | "completed" | "cancelled";
export interface ImportProgress {
  phase: ImportPhase;
  status: ImportRunStatus;
  percent: number;
  processedFiles?: number;
  totalFiles?: number;
  processedBytes?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  estimatedSeconds?: number;
  detail?: string;
}
export interface SnapshotSummary {
  snapshotId: string;
  commitSha: string;
  ref: string;
  fileCount: number;
  textBytes?: number;
  ignored?: { total: number; reasons: Record<string, number> };
  unchanged: boolean;
}
export interface SnapshotChangeSummary {
  snapshotId: string;
  previousSnapshotId: string | null;
  added: string[];
  modified: string[];
  deleted: string[];
  requiresBuild: boolean;
  affectedModules: string[];
  suggestedTests: string[];
}
export interface Build {
  id: string;
  snapshotId: string;
  commitSha: string;
  status: BuildStatus;
  warnings: Array<{ code?: string; message?: string }>;
  cancelRequested: boolean;
  errorMessage?: string;
}
export interface Release {
  id: string;
  buildId: string;
  snapshotId: string;
  version: string;
  createdAt: string;
  publishedAt: string | null;
  commitSha?: string | null;
}
export interface RepositoryStatus {
  repository: Repository | null;
  latestSnapshot: null | {
    id: string; commitSha: string; ref: string; commitTimestamp: string; fileCount?: number;
  };
}
export interface KnowledgeMetadata {
  symbols: Array<{
    name: string; kind: string; path: string; startLine: number; endLine: number; exported: boolean;
  }>;
  dependencies: Array<{
    source: string; target: string; kind: string; path: string; targetPath: string | null; startLine: number; endLine: number;
  }>;
}
export interface Citation {
  path: string;
  startLine: number;
  endLine: number;
  commitSha: string;
  blobHash: string;
  symbol?: string;
  kind?: string;
}
export interface KnowledgeChunk {
  id: string;
  heading: string | null;
  content: string;
  citations: Citation[];
}
export interface KnowledgePageRecord {
  id: string;
  slug: string;
  title: string;
  body: string;
  chunks: KnowledgeChunk[];
}
export interface SearchResult {
  kind: string;
  title: string;
  excerpt: string;
  matchReason: string;
  score: number;
  pageId: string;
  releaseId: string;
  citations: Citation[];
}
export interface WorkspaceSearchResult extends SearchResult {
  projectId: string;
  projectName: string;
  projectSlug: string;
}
export interface SourceExcerpt extends Citation { content: string }
export interface Feedback {
  id: string;
  releaseId: string | null;
  query: string;
  reason: string;
  expected: string | null;
  citations: Citation[];
  status: AgentFeedbackStatus;
  rebuildBuildId: string | null;
  createdAt: string;
  updatedAt: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  releaseVersion: string;
}
export interface McpToken {
  id: string;
  projectId: string;
  name: string;
  tokenPrefix: string;
  scopes: Array<"search" | "source.read">;
  expiresAt: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export interface McpConnection {
  endpoint: string;
  transport: string;
  authorization: string;
  stdioCommand: string;
  tools: string[];
}
export interface CodexConnectionPack {
  projectId: string;
  endpoint: string;
  environmentVariable: string;
  configToml: string;
  agentsMarkdown: string;
  checkCommand: string;
}
export type ModelProvider = "openai" | "anthropic";
export interface ModelConfig {
  provider: ModelProvider;
  model: string;
  hasApiKey: boolean;
}
export interface ApiErrorShape { error: { code: string; message: string; changedPaths?: string[] } }
