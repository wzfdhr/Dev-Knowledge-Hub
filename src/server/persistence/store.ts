import type {
  BuildPersistence,
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
}

export interface McpTokenRecord {
  id: string;
  workspaceId: string;
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
  build: Omit<BuildRecord, "id" | "status" | "warnings" | "cancelRequested">;
}

export type RepositoryKind = "local" | "git";

export interface RepositoryRecord {
  id: string;
  workspaceId: string;
  kind: RepositoryKind;
  name: string;
  localPath: string | null;
  cloneUrl: string | null;
  defaultBranch: string;
  hasCredential: boolean;
}

export interface EncryptedCredentialRecord {
  id: string;
  workspaceId: string;
  repositoryId: string;
  name: string;
  ciphertext: string;
}

export type RepositoryConnectionInput =
  | { kind: "local"; name: string; path: string }
  | { kind: "git"; name: string; url: string; encryptedToken?: string };

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
  score: number;
  pageId: string;
  releaseId: string;
  citations: Citation[];
}

export interface KnowledgeStore {
  saveKnowledge(value: PersistedKnowledge): Promise<void>;
  listKnowledgePages(workspaceId: string, releaseId?: string): Promise<KnowledgePageRecord[]>;
  getKnowledgePage(workspaceId: string, pageId: string): Promise<KnowledgePageRecord | null>;
  searchKnowledge(
    workspaceId: string,
    repositoryId: string,
    query: string,
    releaseId?: string
  ): Promise<KnowledgeSearchResult[]>;
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
  listReleases(workspaceId: string, repositoryId: string): Promise<ReleaseRecord[]>;
}

export interface AppStore extends BuildPersistence, KnowledgeStore {
  isSetupComplete(): Promise<boolean>;
  createInitialSetup(email: string, passwordHash: string): Promise<SetupResult | null>;
  findAdminByEmail(email: string): Promise<AdminRecord | null>;
  findAdminById(id: string, workspaceId: string): Promise<AdminRecord | null>;
  defaultWorkspace(): Promise<WorkspaceRecord | null>;
  recordAudit(event: AuditEventInput): Promise<void>;
  createMcpToken(input: Omit<McpTokenRecord, "id" | "createdAt" | "lastUsedAt" | "revokedAt">):
    Promise<McpTokenRecord>;
  createMcpTokenWithAudit(
    input: Omit<McpTokenRecord, "id" | "createdAt" | "lastUsedAt" | "revokedAt">,
    actorId: string
  ): Promise<McpTokenRecord>;
  listMcpTokens(workspaceId: string): Promise<McpTokenRecord[]>;
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
  listFeedback(workspaceId: string, status?: AgentFeedbackStatus): Promise<AgentFeedbackRecord[]>;
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
    input: RepositoryConnectionInput
  ): Promise<RepositoryRecord | null>;
  currentRepository(workspaceId: string): Promise<RepositoryRecord | null>;
  findSnapshotByCommit(
    workspaceId: string,
    repositoryId: string,
    commitSha: string
  ): Promise<SourceSnapshotRecord | null>;
  findSnapshotById(workspaceId: string, snapshotId: string): Promise<SourceSnapshotRecord | null>;
  findSourceFile(
    workspaceId: string,
    snapshotId: string,
    path: string
  ): Promise<SourceFileRecord | null>;
  createSnapshot(input: CreateSnapshotInput): Promise<SourceSnapshotRecord>;
  countSnapshotFiles(snapshotId: string): Promise<number>;
  repositoryCredential(workspaceId: string, repositoryId: string): Promise<string | null>;
}

export type { BuildRecord };
