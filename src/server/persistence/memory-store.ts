import { randomUUID } from "node:crypto";

import type {
  AdminRecord,
  AppStore,
  AuditEventInput,
  AuditEventRecord,
  CreateSnapshotInput,
  EncryptedCredentialRecord,
  RepositoryConnectionInput,
  RepositoryRecord,
  SourceFileRecord,
  SourceSnapshotRecord,
  SetupResult,
  WorkspaceRecord
} from "./store.js";

export class MemoryAppStore implements AppStore {
  private workspace: WorkspaceRecord | null = null;
  private admin: AdminRecord | null = null;
  private repository: RepositoryRecord | null = null;
  readonly auditEvents: AuditEventRecord[] = [];
  readonly encryptedCredentials: EncryptedCredentialRecord[] = [];
  readonly sourceSnapshots: SourceSnapshotRecord[] = [];
  readonly sourceFiles: SourceFileRecord[] = [];

  async isSetupComplete(): Promise<boolean> {
    return this.admin !== null;
  }

  async createInitialSetup(email: string, passwordHash: string): Promise<SetupResult | null> {
    if (this.admin) return null;
    this.workspace = {
      id: randomUUID(),
      name: "Default Workspace",
      slug: "default"
    };
    this.admin = {
      id: randomUUID(),
      workspaceId: this.workspace.id,
      email,
      passwordHash
    };
    return { workspace: this.workspace, admin: this.admin };
  }

  async findAdminByEmail(email: string): Promise<AdminRecord | null> {
    return this.admin?.email === email ? this.admin : null;
  }

  async findAdminById(id: string, workspaceId: string): Promise<AdminRecord | null> {
    return this.admin?.id === id && this.admin.workspaceId === workspaceId ? this.admin : null;
  }

  async defaultWorkspace(): Promise<WorkspaceRecord | null> {
    return this.workspace;
  }

  async recordAudit(event: AuditEventInput): Promise<void> {
    this.auditEvents.push({ id: randomUUID(), metadata: {}, ...event });
  }

  async createRepository(
    workspaceId: string,
    input: RepositoryConnectionInput
  ): Promise<RepositoryRecord | null> {
    if (this.repository?.workspaceId === workspaceId) return null;
    const repositoryId = randomUUID();
    this.repository = {
      id: repositoryId,
      workspaceId,
      kind: input.kind,
      name: input.name,
      localPath: input.kind === "local" ? input.path : null,
      cloneUrl: input.kind === "git" ? input.url : null,
      defaultBranch: "main",
      hasCredential: input.kind === "git" && Boolean(input.encryptedToken)
    };
    if (input.kind === "git" && input.encryptedToken) {
      this.encryptedCredentials.push({
        id: randomUUID(),
        workspaceId,
        repositoryId,
        name: "repository-pat",
        ciphertext: input.encryptedToken
      });
    }
    return this.repository;
  }

  async currentRepository(workspaceId: string): Promise<RepositoryRecord | null> {
    return this.repository?.workspaceId === workspaceId ? this.repository : null;
  }

  async findSnapshotByCommit(
    workspaceId: string,
    repositoryId: string,
    commitSha: string
  ): Promise<SourceSnapshotRecord | null> {
    return this.sourceSnapshots.find((snapshot) =>
      snapshot.workspaceId === workspaceId
      && snapshot.repositoryId === repositoryId
      && snapshot.commitSha === commitSha
    ) ?? null;
  }

  async createSnapshot({ snapshot, files }: CreateSnapshotInput): Promise<void> {
    this.sourceSnapshots.push(snapshot);
    this.sourceFiles.push(...files);
  }

  async countSnapshotFiles(snapshotId: string): Promise<number> {
    return this.sourceFiles.filter((file) => file.snapshotId === snapshotId).length;
  }

  async repositoryCredential(workspaceId: string, repositoryId: string): Promise<string | null> {
    return this.encryptedCredentials.find((credential) =>
      credential.workspaceId === workspaceId && credential.repositoryId === repositoryId
    )?.ciphertext ?? null;
  }
}
