import type {
  BuildInput,
  BuildPersistence,
  BuildPurpose,
  BuildRecord,
  PersistedKnowledge
} from "../knowledge/build-service.js";
import type { Citation } from "../knowledge/intelligence.js";
import type { AGENT_FEEDBACK_STATUSES } from "../../shared/contracts.js";

export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
}

export interface AdminRecord {
  id: string;
  workspaceId: string;
  email: string;
  passwordHash: string;
  role: TeamRole;
  disabledAt: Date | null;
  sessionVersion: number;
}

export const TEAM_ROLES = ["admin", "member", "reader"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export interface TeamMemberRecord {
  id: string;
  workspaceId: string;
  email: string;
  passwordHash: string;
  role: TeamRole;
  createdAt: Date;
  disabledAt: Date | null;
  sessionVersion: number;
}

export interface ProjectRecord {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  archivedAt: Date | null;
  createdAt: Date;
}

export type ProjectRole = TeamRole;

export interface ProjectMemberRecord {
  id: string;
  projectId: string;
  workspaceId: string;
  email: string;
  role: ProjectRole;
  createdAt: Date;
}

export interface ProjectAccess {
  project: ProjectRecord;
  role: ProjectRole | null;
}

export interface WorkspaceProjectOverviewRecord {
  project: ProjectRecord;
  repository: RepositoryRecord | null;
  latestSnapshot: (SourceSnapshotRecord & { fileCount: number }) | null;
  indexedTextBytes: number;
  currentRelease: ReleaseRecord | null;
  latestBuild: BuildRecord | null;
  memberCount: number;
  pendingFeedbackCount: number;
}

export interface WorkspaceKnowledgeSearchRecord extends KnowledgeSearchResult {
  project: ProjectRecord;
}

export class LastProjectAdminError extends Error {
  constructor() {
    super("A project must retain at least one administrator");
    this.name = "LastProjectAdminError";
  }
}

export class LastWorkspaceAdminError extends Error {
  constructor() {
    super("A workspace must retain at least one active administrator");
    this.name = "LastWorkspaceAdminError";
  }
}

export interface AuditEventInput {
  workspaceId: string;
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditEventRecord extends AuditEventInput {
  id: string;
  createdAt: Date;
}

export interface McpTokenRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export type AgentFeedbackStatus = (typeof AGENT_FEEDBACK_STATUSES)[number];

export interface AgentFeedbackRecord {
  id: string;
  workspaceId: string;
  releaseId: string | null;
  query: string;
  reason: string;
  expected: string | null;
  citations: Citation[];
  status: AgentFeedbackStatus;
  rebuildBuildId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateFeedbackInput {
  workspaceId: string;
  releaseId?: string;
  query: string;
  reason: string;
  expected?: string;
  citations?: Citation[];
}

export class InvalidFeedbackTransitionError extends Error {
  constructor() {
    super("Invalid feedback transition");
    this.name = "InvalidFeedbackTransitionError";
  }
}

export class FeedbackNotAcknowledgedError extends Error {
  constructor() {
    super("Feedback must be acknowledged first");
    this.name = "FeedbackNotAcknowledgedError";
  }
}

export interface FeedbackRebuildInput {
  workspaceId: string;
  feedbackId: string;
  releaseId: string;
  actorId: string;
  build: BuildInput;
}

export type RepositoryKind = "local" | "git" | "upload";

export interface RepositoryRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  kind: RepositoryKind;
  name: string;
  localPath: string | null;
  cloneUrl: string | null;
  defaultBranch: string;
  archivedAt: Date | null;
  hasCredential: boolean;
}

export interface EncryptedCredentialRecord {
  id: string;
  workspaceId: string;
  repositoryId: string | null;
  name: string;
  ciphertext: string;
  metadata: Record<string, string>;
}

export type ModelProvider = "openai" | "anthropic";

export interface ModelConfigRecord {
  workspaceId: string;
  provider: ModelProvider;
  model: string;
  encryptedApiKey: string;
}

export type RepositoryConnectionInput =
  | { kind: "local"; name: string; path: string }
  | { kind: "git"; name: string; url: string; encryptedToken?: string }
  | { kind: "upload"; name: string };

export interface SourceSnapshotRecord {
  id: string;
  workspaceId: string;
  repositoryId: string;
  commitSha: string;
  ref: string;
  remoteUrl: string | null;
  commitTimestamp: Date;
  storagePath: string;
}

export interface SourceFileRecord {
  id: string;
  workspaceId: string;
  snapshotId: string;
  path: string;
  byteSize: number;
  contentHash: string;
  language: string | null;
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

export type ImportReportStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface ImportReportRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  repositoryId: string | null;
  actorId: string | null;
  sourceKind: RepositoryKind;
  status: ImportReportStatus;
  startedAt: Date;
  finishedAt: Date | null;
  collectedFileCount: number;
  collectedTextBytes: number;
  ignored: { total: number; reasons: Record<string, number> };
  snapshotId: string | null;
  failureCode: string | null;
}

export interface CreateSnapshotInput {
  snapshot: SourceSnapshotRecord;
  files: SourceFileRecord[];
}

export interface SetupResult {
  workspace: WorkspaceRecord;
  admin: AdminRecord;
}

export interface KnowledgeChunkRecord {
  id: string;
  heading: string | null;
  content: string;
  citations: Citation[];
}

export interface KnowledgePageRecord {
  id: string;
  workspaceId: string;
  repositoryId: string;
  buildId: string;
  slug: string;
  title: string;
  body: string;
  chunks: KnowledgeChunkRecord[];
}

export const MAX_KNOWLEDGE_PAGE_BODY_CHARACTERS = 20_000;
export const MAX_KNOWLEDGE_CHUNK_CONTENT_CHARACTERS = 8_000;
export const MAX_KNOWLEDGE_PAGE_CHUNKS = 50;
export const MAX_KNOWLEDGE_CHUNK_CITATIONS = 8;

export function boundedKnowledgePage(page: KnowledgePageRecord): KnowledgePageRecord {
  return {
    ...page,
    body: page.body.slice(0, MAX_KNOWLEDGE_PAGE_BODY_CHARACTERS),
    chunks: page.chunks.slice(0, MAX_KNOWLEDGE_PAGE_CHUNKS).map((chunk) => ({
      ...chunk,
      content: chunk.content.slice(0, MAX_KNOWLEDGE_CHUNK_CONTENT_CHARACTERS),
      citations: chunk.citations.slice(0, MAX_KNOWLEDGE_CHUNK_CITATIONS)
    }))
  };
}

export interface ReleaseRecord {
  id: string;
  workspaceId: string;
  repositoryId: string;
  buildId: string;
  snapshotId: string;
  version: string;
  createdAt: Date;
  publishedAt: Date | null;
}

export type SearchResultKind = "symbol" | "module" | "path" | "dependency-neighbor" | "page";

export interface KnowledgeSearchResult {
  kind: SearchResultKind;
  title: string;
  excerpt: string;
  matchReason: string;
  score: number;
  pageId: string;
  releaseId: string;
  citations: Citation[];
}

export function knowledgeMatchReason(kind: SearchResultKind, title: string, query: string): string {
  const normalizedTitle = title.trim().toLocaleLowerCase();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const pathLike = kind === "path" || (kind === "module" && title.includes("/"));
  if (pathLike && normalizedTitle === normalizedQuery) return "精确路径匹配";
  if (kind === "symbol" && normalizedTitle === normalizedQuery) return "精确符号匹配";
  if (pathLike && normalizedTitle.startsWith(normalizedQuery)) return "路径前缀匹配";
  if (kind === "symbol" && normalizedTitle.startsWith(normalizedQuery)) return "符号前缀匹配";
  if (kind === "dependency-neighbor") return "依赖邻居匹配";
  return "知识正文匹配";
}

export interface KnowledgeMetadata {
  symbols: Array<{
    name: string; kind: string; path: string; startLine: number; endLine: number; exported: boolean;
  }>;
  dependencies: Array<{
    source: string; target: string; kind: string; path: string; targetPath: string | null; startLine: number; endLine: number;
  }>;
}

export interface Pagination {
  limit?: number;
  offset?: number;
}

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;

export function normalizePagination(pagination: Pagination = {}): Required<Pagination> {
  return {
    limit: Math.min(MAX_LIST_LIMIT, Math.max(1, pagination.limit ?? DEFAULT_LIST_LIMIT)),
    offset: Math.max(0, pagination.offset ?? 0)
  };
}

export interface KnowledgeReleaseSummary {
  pageCount: number;
  chunkCount: number;
  citationCount: number;
}

export interface KnowledgeStore {
  saveKnowledge(value: PersistedKnowledge): Promise<void>;
  listKnowledgePages(
    workspaceId: string,
    releaseId?: string,
    pagination?: Pagination
  ): Promise<KnowledgePageRecord[]>;
  getKnowledgePage(workspaceId: string, pageId: string): Promise<KnowledgePageRecord | null>;
  findKnowledgePageBySlug(
    workspaceId: string,
    releaseId: string,
    slug: string
  ): Promise<KnowledgePageRecord | null>;
  findKnowledgePageByModule(
    workspaceId: string,
    releaseId: string,
    moduleId: string
  ): Promise<KnowledgePageRecord | null>;
  findKnowledgePageBySymbol(
    workspaceId: string,
    releaseId: string,
    name: string,
    path?: string
  ): Promise<KnowledgePageRecord | null>;
  knowledgeReleaseSummary(
    workspaceId: string,
    releaseId: string
  ): Promise<KnowledgeReleaseSummary>;
  searchKnowledge(
    workspaceId: string,
    repositoryId: string,
    query: string,
    releaseId?: string
  ): Promise<KnowledgeSearchResult[]>;
  knowledgeMetadata(workspaceId: string, releaseId: string): Promise<KnowledgeMetadata>;
  createReleaseDraft(
    workspaceId: string,
    repositoryId: string,
    buildId: string,
    version: string
  ): Promise<ReleaseRecord>;
  publishRelease(workspaceId: string, releaseId: string, channel?: string): Promise<ReleaseRecord>;
  currentRelease(
    workspaceId: string,
    repositoryId: string,
    channel?: string
  ): Promise<ReleaseRecord | null>;
  getRelease(workspaceId: string, releaseId: string): Promise<ReleaseRecord | null>;
  listReleases(
    workspaceId: string,
    repositoryId: string,
    pagination?: Pagination
  ): Promise<ReleaseRecord[]>;
}

export interface AppStore extends BuildPersistence, KnowledgeStore {
  isSetupComplete(): Promise<boolean>;
  createInitialSetup(email: string, passwordHash: string): Promise<SetupResult | null>;
  findAdminByEmail(email: string): Promise<AdminRecord | null>;
  findAdminById(id: string, workspaceId: string): Promise<AdminRecord | null>;
  listTeamMembers(workspaceId: string, pagination?: Pagination): Promise<TeamMemberRecord[]>;
  countTeamMembers(workspaceId: string): Promise<number>;
  createTeamMember(
    workspaceId: string,
    input: { email: string; passwordHash: string; role: TeamRole },
    actorId: string
  ): Promise<TeamMemberRecord | null>;
  resetTeamMemberPassword(
    workspaceId: string,
    userId: string,
    passwordHash: string,
    actorId: string
  ): Promise<TeamMemberRecord | null>;
  setTeamMemberDisabled(
    workspaceId: string,
    userId: string,
    disabled: boolean,
    actorId: string
  ): Promise<TeamMemberRecord | null>;
  listProjects(workspaceId: string, pagination?: Pagination): Promise<ProjectRecord[]>;
  createProject(
    workspaceId: string,
    input: { name: string; slug: string },
    actorId: string
  ): Promise<ProjectRecord | null>;
  listAccessibleProjects(
    workspaceId: string,
    userId: string,
    pagination?: Pagination
  ): Promise<ProjectRecord[]>;
  workspaceOverview(workspaceId: string, userId: string): Promise<WorkspaceProjectOverviewRecord[]>;
  searchWorkspaceKnowledge(
    workspaceId: string,
    userId: string,
    query: string
  ): Promise<WorkspaceKnowledgeSearchRecord[]>;
  listProjectMembers(
    workspaceId: string,
    projectId: string,
    pagination?: Pagination
  ): Promise<ProjectMemberRecord[]>;
  addProjectMember(
    workspaceId: string,
    projectId: string,
    userId: string,
    role: ProjectRole,
    actorId: string
  ): Promise<ProjectMemberRecord | null>;
  updateProjectMemberRole(
    workspaceId: string,
    projectId: string,
    userId: string,
    role: ProjectRole,
    actorId: string
  ): Promise<ProjectMemberRecord | null>;
  removeProjectMember(
    workspaceId: string,
    projectId: string,
    userId: string,
    actorId: string
  ): Promise<ProjectMemberRecord | null>;
  projectAccess(
    workspaceId: string,
    projectId: string,
    userId: string
  ): Promise<ProjectAccess | null>;
  defaultWorkspace(): Promise<WorkspaceRecord | null>;
  recordAudit(event: AuditEventInput): Promise<void>;
  listProjectActivity(
    workspaceId: string,
    projectId: string,
    pagination?: Pagination
  ): Promise<AuditEventRecord[]>;
  countProjectActivity(workspaceId: string, projectId: string): Promise<number>;
  createImportReport(input: Omit<ImportReportRecord, "id" | "startedAt" | "finishedAt" | "status" | "collectedFileCount" | "collectedTextBytes" | "ignored" | "snapshotId" | "failureCode">): Promise<ImportReportRecord>;
  finishImportReport(
    workspaceId: string,
    reportId: string,
    input: Pick<ImportReportRecord, "status" | "collectedFileCount" | "collectedTextBytes" | "ignored" | "snapshotId" | "failureCode">
  ): Promise<ImportReportRecord | null>;
  listImportReports(workspaceId: string, projectId: string, pagination?: Pagination): Promise<ImportReportRecord[]>;
  countImportReports(workspaceId: string, projectId: string): Promise<number>;
  deleteExpiredImportReports(cutoff: Date): Promise<number>;
  createMcpToken(input: Omit<McpTokenRecord, "id" | "createdAt" | "lastUsedAt" | "revokedAt">):
    Promise<McpTokenRecord>;
  createMcpTokenWithAudit(
    input: Omit<McpTokenRecord, "id" | "createdAt" | "lastUsedAt" | "revokedAt">,
    actorId: string
  ): Promise<McpTokenRecord>;
  listMcpTokens(workspaceId: string, pagination?: Pagination, projectId?: string): Promise<McpTokenRecord[]>;
  countMcpTokens(workspaceId: string, projectId?: string): Promise<number>;
  findActiveMcpToken(tokenHash: string): Promise<McpTokenRecord | null>;
  touchMcpToken(tokenId: string): Promise<void>;
  revokeMcpToken(workspaceId: string, tokenId: string): Promise<McpTokenRecord | null>;
  revokeMcpTokenWithAudit(
    workspaceId: string,
    tokenId: string,
    actorId: string
  ): Promise<McpTokenRecord | null>;
  createFeedback(input: CreateFeedbackInput): Promise<AgentFeedbackRecord>;
  reportFeedbackWithAudit(input: CreateFeedbackInput): Promise<AgentFeedbackRecord>;
  listFeedback(
    workspaceId: string,
    status?: AgentFeedbackStatus,
    pagination?: Pagination
  ): Promise<AgentFeedbackRecord[]>;
  countFeedback(workspaceId: string, status?: AgentFeedbackStatus): Promise<number>;
  getFeedback(workspaceId: string, feedbackId: string): Promise<AgentFeedbackRecord | null>;
  transitionFeedback(
    workspaceId: string,
    feedbackId: string,
    status: AgentFeedbackStatus
  ): Promise<AgentFeedbackRecord | null>;
  transitionFeedbackWithAudit(
    workspaceId: string,
    feedbackId: string,
    status: AgentFeedbackStatus,
    actorId: string
  ): Promise<AgentFeedbackRecord | null>;
  markFeedbackRebuild(
    workspaceId: string,
    feedbackId: string,
    buildId: string
  ): Promise<AgentFeedbackRecord | null>;
  requestFeedbackRebuildWithAudit(
    input: FeedbackRebuildInput
  ): Promise<{ build: BuildRecord; created: boolean }>;
  createRepository(
    workspaceId: string,
    input: RepositoryConnectionInput,
    projectId?: string
  ): Promise<RepositoryRecord | null>;
  createRepositoryWithAudit(
    workspaceId: string,
    input: RepositoryConnectionInput,
    actorId: string,
    projectId?: string
  ): Promise<RepositoryRecord | null>;
  currentRepository(workspaceId: string, projectId?: string): Promise<RepositoryRecord | null>;
  listActiveGitRepositories(): Promise<RepositoryRecord[]>;
  getRepository(workspaceId: string, repositoryId: string): Promise<RepositoryRecord | null>;
  listArchivedRepositories(workspaceId: string): Promise<RepositoryRecord[]>;
  switchRepositoryWithAudit(
    workspaceId: string,
    input: RepositoryConnectionInput,
    actorId: string
  ): Promise<RepositoryRecord | null>;
  prepareUploadReplacementWithAudit(
    workspaceId: string,
    name: string,
    actorId: string
  ): Promise<RepositoryRecord | null>;
  activateUploadReplacementWithAudit(
    workspaceId: string,
    repositoryId: string,
    actorId: string
  ): Promise<RepositoryRecord | null>;
  discardPendingUploadReplacement(workspaceId: string, repositoryId: string): Promise<void>;
  findSnapshotByCommit(
    workspaceId: string,
    repositoryId: string,
    commitSha: string
  ): Promise<SourceSnapshotRecord | null>;
  findSnapshotById(workspaceId: string, snapshotId: string): Promise<SourceSnapshotRecord | null>;
  latestSnapshot(workspaceId: string, repositoryId: string): Promise<SourceSnapshotRecord | null>;
  snapshotChangeSummary(workspaceId: string, repositoryId: string, snapshotId: string): Promise<SnapshotChangeSummary | null>;
  findSourceFile(
    workspaceId: string,
    snapshotId: string,
    path: string
  ): Promise<SourceFileRecord | null>;
  createSnapshot(input: CreateSnapshotInput): Promise<SourceSnapshotRecord>;
  createSnapshotWithAudit(input: CreateSnapshotInput, actorId: string): Promise<SourceSnapshotRecord>;
  countSnapshotFiles(snapshotId: string): Promise<number>;
  snapshotTextBytes(snapshotId: string): Promise<number>;
  repositoryCredential(workspaceId: string, repositoryId: string): Promise<string | null>;
  getModelConfig(workspaceId: string): Promise<ModelConfigRecord | null>;
  upsertModelConfig(
    workspaceId: string,
    input: { provider: ModelProvider; model: string; encryptedApiKey?: string },
    actorId: string
  ): Promise<ModelConfigRecord>;
  countBuilds(workspaceId: string, repositoryId: string): Promise<number>;
  countReleases(workspaceId: string, repositoryId: string): Promise<number>;
  countKnowledgePages(workspaceId: string, releaseId?: string): Promise<number>;
}

export type { BuildPurpose, BuildRecord };
