import type {
  BuildPersistence,
  BuildRecord,
  PersistedKnowledge
} from "../knowledge/build-service.js";
import type { Citation } from "../knowledge/intelligence.js";

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
