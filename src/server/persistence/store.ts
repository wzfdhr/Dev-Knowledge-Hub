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

export interface AppStore {
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
  createSnapshot(input: CreateSnapshotInput): Promise<SourceSnapshotRecord>;
  countSnapshotFiles(snapshotId: string): Promise<number>;
  repositoryCredential(workspaceId: string, repositoryId: string): Promise<string | null>;
}
