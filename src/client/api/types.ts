import type { AgentFeedbackStatus } from "../../server/persistence/store";
import type { BuildStatus } from "../../server/knowledge/build-service";

export interface Admin { id: string; email: string }
export interface Session { authenticated: true; admin: Admin }
export interface Repository {
  id: string;
  kind: "local" | "git";
  name: string;
  path?: string | null;
  url?: string | null;
  hasCredential?: boolean;
  defaultBranch: string;
}
export interface SnapshotSummary {
  snapshotId: string;
  commitSha: string;
  ref: string;
  fileCount: number;
  unchanged: boolean;
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
  score: number;
  pageId: string;
  releaseId: string;
  citations: Citation[];
}
export interface SourceExcerpt extends Citation { content: string }
export interface Feedback {
  id: string;
  releaseId: string | null;
  query: string;
  reason: string;
  expected: string | null;
  status: AgentFeedbackStatus;
  rebuildBuildId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface McpToken {
  id: string;
  name: string;
  tokenPrefix: string;
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
export interface ApiErrorShape { error: { code: string; message: string; changedPaths?: string[] } }
