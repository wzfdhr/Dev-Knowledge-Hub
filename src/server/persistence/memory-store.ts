import { randomUUID } from "node:crypto";

import {
  boundedKnowledgePage,
  FeedbackNotAcknowledgedError,
  InvalidFeedbackTransitionError,
  normalizePagination
} from "./store.js";

import type {
  AdminRecord,
  AgentFeedbackRecord,
  AgentFeedbackStatus,
  AppStore,
  AuditEventInput,
  AuditEventRecord,
  CreateSnapshotInput,
  CreateFeedbackInput,
  EncryptedCredentialRecord,
  FeedbackRebuildInput,
  KnowledgePageRecord,
  KnowledgeMetadata,
  KnowledgeSearchResult,
  ModelConfigRecord,
  ModelProvider,
  McpTokenRecord,
  Pagination,
  ReleaseRecord,
  RepositoryConnectionInput,
  RepositoryRecord,
  SourceFileRecord,
  SourceSnapshotRecord,
  SetupResult,
  TeamMemberRecord,
  TeamRole,
  ProjectRecord,
  WorkspaceRecord
} from "./store.js";
import type {
  BuildInput,
  BuildEvent,
  BuildRecord,
  PersistedKnowledge
} from "../knowledge/build-service.js";
import { standardBuildPurpose } from "../knowledge/build-service.js";
import type { CodeIndex } from "../knowledge/intelligence.js";

export class MemoryAppStore implements AppStore {
  private workspace: WorkspaceRecord | null = null;
  private admin: AdminRecord | null = null;
  private readonly members: TeamMemberRecord[] = [];
  private readonly projects: ProjectRecord[] = [];
  private readonly repositories: RepositoryRecord[] = [];
  readonly auditEvents: AuditEventRecord[] = [];
  readonly mcpTokens: McpTokenRecord[] = [];
  readonly feedback: AgentFeedbackRecord[] = [];
  readonly encryptedCredentials: EncryptedCredentialRecord[] = [];
  readonly sourceSnapshots: SourceSnapshotRecord[] = [];
  readonly sourceFiles: SourceFileRecord[] = [];
  readonly builds: BuildRecord[] = [];
  readonly buildEvents: BuildEvent[] = [];
  private nextBuildEventSequence = 1;
  readonly knowledgePages: KnowledgePageRecord[] = [];
  readonly releases: ReleaseRecord[] = [];
  private readonly indexes = new Map<string, CodeIndex>();
  private readonly releaseChannels = new Map<string, string>();

  async isSetupComplete(): Promise<boolean> {
    return this.admin !== null;
  }

  async createInitialSetup(email: string, passwordHash: string): Promise<SetupResult | null> {
    if (this.admin) return null;
    const previousWorkspace = this.workspace;
    const previousAdmin = this.admin;
    const auditLength = this.auditEvents.length;
    try {
      this.workspace = {
        id: randomUUID(),
        name: "Default Workspace",
        slug: "default"
      };
      this.admin = {
        id: randomUUID(),
        workspaceId: this.workspace.id,
        email,
        passwordHash,
        role: "admin"
      };
      this.members.push({ ...this.admin, createdAt: new Date() });
      this.projects.push({
        id: randomUUID(),
        workspaceId: this.workspace.id,
        name: "默认项目",
        slug: "default-project",
        archivedAt: null,
        createdAt: new Date()
      });
      await this.recordAudit({
        workspaceId: this.workspace.id,
        actorId: this.admin.id,
        action: "setup.completed",
        resourceType: "workspace",
        resourceId: this.workspace.id
      });
      return { workspace: this.workspace, admin: this.admin };
    } catch (error) {
      this.workspace = previousWorkspace;
      this.admin = previousAdmin;
      this.auditEvents.splice(auditLength);
      throw error;
    }
  }

  async findAdminByEmail(email: string): Promise<AdminRecord | null> {
    const member = this.members.find((candidate) => candidate.email === email);
    return member ? {
      id: member.id,
      workspaceId: member.workspaceId,
      email: member.email,
      passwordHash: member.passwordHash,
      role: member.role
    } : null;
  }

  async findAdminById(id: string, workspaceId: string): Promise<AdminRecord | null> {
    const member = this.members.find((candidate) => candidate.id === id && candidate.workspaceId === workspaceId);
    return member ? {
      id: member.id,
      workspaceId: member.workspaceId,
      email: member.email,
      passwordHash: member.passwordHash,
      role: member.role
    } : null;
  }

  async listTeamMembers(workspaceId: string, pagination?: Pagination): Promise<TeamMemberRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    return this.members.filter((member) => member.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
      .slice(offset, offset + limit);
  }

  async createTeamMember(
    workspaceId: string,
    input: { email: string; passwordHash: string; role: TeamRole },
    actorId: string
  ): Promise<TeamMemberRecord | null> {
    if (this.members.some((member) => member.workspaceId === workspaceId && member.email === input.email)) {
      return null;
    }
    const member: TeamMemberRecord = {
      id: randomUUID(),
      workspaceId,
      email: input.email,
      passwordHash: input.passwordHash,
      role: input.role,
      createdAt: new Date()
    };
    this.members.push(member);
    await this.recordAudit({
      workspaceId,
      actorId,
      action: "member.created",
      resourceType: "workspace_member",
      resourceId: member.id,
      metadata: { role: member.role }
    });
    return member;
  }

  async listProjects(workspaceId: string, pagination?: Pagination): Promise<ProjectRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    return this.projects.filter((project) => project.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
      .slice(offset, offset + limit);
  }

  async createProject(
    workspaceId: string,
    input: { name: string; slug: string },
    actorId: string
  ): Promise<ProjectRecord | null> {
    if (this.projects.some((project) => project.workspaceId === workspaceId && project.slug === input.slug)) {
      return null;
    }
    const project: ProjectRecord = {
      id: randomUUID(),
      workspaceId,
      name: input.name,
      slug: input.slug,
      archivedAt: null,
      createdAt: new Date()
    };
    this.projects.push(project);
    await this.recordAudit({
      workspaceId,
      actorId,
      action: "project.created",
      resourceType: "project",
      resourceId: project.id
    });
    return project;
  }

  async defaultWorkspace(): Promise<WorkspaceRecord | null> {
    return this.workspace;
  }

  async recordAudit(event: AuditEventInput): Promise<void> {
    this.auditEvents.push({ id: randomUUID(), metadata: {}, ...event });
  }

  async createMcpToken(
    input: Omit<McpTokenRecord, "id" | "createdAt" | "lastUsedAt" | "revokedAt">
  ): Promise<McpTokenRecord> {
    const record: McpTokenRecord = {
      ...input,
      id: randomUUID(),
      createdAt: new Date(),
      lastUsedAt: null,
      revokedAt: null
    };
    this.mcpTokens.push(record);
    return record;
  }

  async createMcpTokenWithAudit(
    input: Omit<McpTokenRecord, "id" | "createdAt" | "lastUsedAt" | "revokedAt">,
    actorId: string
  ): Promise<McpTokenRecord> {
    const tokenLength = this.mcpTokens.length;
    const auditLength = this.auditEvents.length;
    try {
      const token = await this.createMcpToken(input);
      await this.recordAudit({
        workspaceId: input.workspaceId,
        actorId,
        action: "mcp_token.created",
        resourceType: "mcp_token",
        resourceId: token.id
      });
      return token;
    } catch (error) {
      this.mcpTokens.splice(tokenLength);
      this.auditEvents.splice(auditLength);
      throw error;
    }
  }

  async listMcpTokens(workspaceId: string, pagination?: Pagination): Promise<McpTokenRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    return this.mcpTokens.filter((token) => token.workspaceId === workspaceId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()
        || right.id.localeCompare(left.id))
      .slice(offset, offset + limit);
  }

  async countMcpTokens(workspaceId: string): Promise<number> {
    return this.mcpTokens.filter((token) => token.workspaceId === workspaceId).length;
  }

  async findActiveMcpToken(tokenHash: string): Promise<McpTokenRecord | null> {
    return this.mcpTokens.find((token) => token.tokenHash === tokenHash && !token.revokedAt) ?? null;
  }

  async touchMcpToken(tokenId: string): Promise<void> {
    const token = this.mcpTokens.find((candidate) => candidate.id === tokenId);
    if (token) token.lastUsedAt = new Date();
  }

  async revokeMcpToken(workspaceId: string, tokenId: string): Promise<McpTokenRecord | null> {
    const token = this.mcpTokens.find((candidate) =>
      candidate.id === tokenId && candidate.workspaceId === workspaceId
    );
    if (!token) return null;
    token.revokedAt ??= new Date();
    return token;
  }

  async revokeMcpTokenWithAudit(
    workspaceId: string,
    tokenId: string,
    actorId: string
  ): Promise<McpTokenRecord | null> {
    const token = this.mcpTokens.find((candidate) =>
      candidate.id === tokenId && candidate.workspaceId === workspaceId
    );
    if (!token) return null;
    const previousRevokedAt = token.revokedAt;
    const auditLength = this.auditEvents.length;
    try {
      await this.revokeMcpToken(workspaceId, tokenId);
      await this.recordAudit({
        workspaceId,
        actorId,
        action: "mcp_token.revoked",
        resourceType: "mcp_token",
        resourceId: tokenId
      });
      return token;
    } catch (error) {
      token.revokedAt = previousRevokedAt;
      this.auditEvents.splice(auditLength);
      throw error;
    }
  }

  async createFeedback(input: CreateFeedbackInput): Promise<AgentFeedbackRecord> {
    const now = new Date();
    const record: AgentFeedbackRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      releaseId: input.releaseId ?? null,
      query: input.query,
      reason: input.reason,
      expected: input.expected ?? null,
      citations: input.citations ?? [],
      status: "open",
      rebuildBuildId: null,
      createdAt: now,
      updatedAt: now
    };
    this.feedback.push(record);
    return record;
  }

  async reportFeedbackWithAudit(input: CreateFeedbackInput): Promise<AgentFeedbackRecord> {
    const feedbackLength = this.feedback.length;
    const auditLength = this.auditEvents.length;
    try {
      const feedback = await this.createFeedback(input);
      await this.recordAudit({
        workspaceId: input.workspaceId,
        action: "feedback.reported",
        resourceType: "agent_feedback",
        resourceId: feedback.id,
        metadata: { releaseId: input.releaseId }
      });
      return feedback;
    } catch (error) {
      this.feedback.splice(feedbackLength);
      this.auditEvents.splice(auditLength);
      throw error;
    }
  }

  async listFeedback(
    workspaceId: string,
    status?: AgentFeedbackStatus,
    pagination?: Pagination
  ): Promise<AgentFeedbackRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    return this.feedback.filter((record) =>
      record.workspaceId === workspaceId && (!status || record.status === status)
    ).sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()
      || right.id.localeCompare(left.id)).slice(offset, offset + limit);
  }

  async countFeedback(workspaceId: string, status?: AgentFeedbackStatus): Promise<number> {
    return this.feedback.filter((record) =>
      record.workspaceId === workspaceId && (!status || record.status === status)
    ).length;
  }

  async getFeedback(workspaceId: string, feedbackId: string): Promise<AgentFeedbackRecord | null> {
    return this.feedback.find((record) =>
      record.workspaceId === workspaceId && record.id === feedbackId
    ) ?? null;
  }

  async transitionFeedback(
    workspaceId: string,
    feedbackId: string,
    status: AgentFeedbackStatus
  ): Promise<AgentFeedbackRecord | null> {
    const record = this.feedback.find((candidate) =>
      candidate.workspaceId === workspaceId && candidate.id === feedbackId
    );
    if (!record) return null;
    const allowed: Record<AgentFeedbackStatus, AgentFeedbackStatus[]> = {
      open: ["acknowledged", "dismissed"],
      acknowledged: ["fixed", "dismissed"],
      fixed: [],
      dismissed: []
    };
    if (!allowed[record.status].includes(status)) throw new InvalidFeedbackTransitionError();
    record.status = status;
    record.updatedAt = new Date();
    return record;
  }

  async transitionFeedbackWithAudit(
    workspaceId: string,
    feedbackId: string,
    status: AgentFeedbackStatus,
    actorId: string
  ): Promise<AgentFeedbackRecord | null> {
    const record = this.feedback.find((candidate) =>
      candidate.workspaceId === workspaceId && candidate.id === feedbackId
    );
    if (!record) return null;
    const previous = { status: record.status, updatedAt: record.updatedAt };
    const auditLength = this.auditEvents.length;
    try {
      await this.transitionFeedback(workspaceId, feedbackId, status);
      await this.recordAudit({
        workspaceId,
        actorId,
        action: "feedback.transitioned",
        resourceType: "agent_feedback",
        resourceId: feedbackId,
        metadata: { status }
      });
      return record;
    } catch (error) {
      record.status = previous.status;
      record.updatedAt = previous.updatedAt;
      this.auditEvents.splice(auditLength);
      throw error;
    }
  }

  async markFeedbackRebuild(
    workspaceId: string,
    feedbackId: string,
    buildId: string
  ): Promise<AgentFeedbackRecord | null> {
    const record = this.feedback.find((candidate) =>
      candidate.workspaceId === workspaceId && candidate.id === feedbackId
    );
    if (!record) return null;
    record.rebuildBuildId = buildId;
    record.updatedAt = new Date();
    return record;
  }

  async requestFeedbackRebuildWithAudit(
    input: FeedbackRebuildInput
  ): Promise<{ build: BuildRecord; created: boolean }> {
    const feedback = this.feedback.find((candidate) =>
      candidate.workspaceId === input.workspaceId && candidate.id === input.feedbackId
    );
    if (!feedback || feedback.status !== "acknowledged") {
      throw new FeedbackNotAcknowledgedError();
    }
    const buildLength = this.builds.length;
    const eventLength = this.buildEvents.length;
    const auditLength = this.auditEvents.length;
    const previousSequence = this.nextBuildEventSequence;
    const previousFeedback = {
      rebuildBuildId: feedback.rebuildBuildId,
      updatedAt: feedback.updatedAt
    };
    try {
      const purpose = {
        kind: "feedback" as const,
        feedbackIds: [feedback.id],
        feedbackContext: [{
          feedbackId: feedback.id,
          releaseId: input.releaseId,
          query: feedback.query,
          reason: feedback.reason,
          expected: feedback.expected,
          citations: feedback.citations
        }]
      };
      const result = await this.createBuild({ ...input.build, purpose });
      await this.markFeedbackRebuild(input.workspaceId, input.feedbackId, result.build.id);
      await this.recordAudit({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        action: "feedback.rebuild_requested",
        resourceType: "agent_feedback",
        resourceId: input.feedbackId,
        metadata: { buildId: result.build.id, releaseId: input.releaseId }
      });
      return result;
    } catch (error) {
      this.builds.splice(buildLength);
      this.buildEvents.splice(eventLength);
      this.auditEvents.splice(auditLength);
      this.nextBuildEventSequence = previousSequence;
      feedback.rebuildBuildId = previousFeedback.rebuildBuildId;
      feedback.updatedAt = previousFeedback.updatedAt;
      throw error;
    }
  }

  async createRepository(
    workspaceId: string,
    input: RepositoryConnectionInput,
    projectId?: string
  ): Promise<RepositoryRecord | null> {
    const repositoryLength = this.repositories.length;
    const credentialLength = this.encryptedCredentials.length;
    try {
      return await this.insertRepository(workspaceId, input, null, true, projectId);
    } catch (error) {
      this.repositories.splice(repositoryLength);
      this.encryptedCredentials.splice(credentialLength);
      throw error;
    }
  }

  private async insertRepository(
    workspaceId: string,
    input: RepositoryConnectionInput,
    archivedAt: Date | null,
    requiresNoCurrentRepository: boolean,
    projectId?: string
  ): Promise<RepositoryRecord | null> {
    if (requiresNoCurrentRepository && await this.currentRepository(workspaceId, projectId)) return null;
    const project = this.projects.find((candidate) =>
      candidate.workspaceId === workspaceId
      && candidate.archivedAt === null
      && (projectId ? candidate.id === projectId : true)
    );
    if (!project) return null;
    const repository: RepositoryRecord = {
      id: randomUUID(),
      workspaceId,
      projectId: project.id,
      kind: input.kind,
      name: input.name,
      localPath: input.kind === "local" ? input.path : null,
      cloneUrl: input.kind === "git" ? input.url : null,
      defaultBranch: input.kind === "upload" ? "upload" : "main",
      archivedAt,
      hasCredential: input.kind === "git" && Boolean(input.encryptedToken)
    };
    this.repositories.push(repository);
    if (input.kind === "git" && input.encryptedToken) {
      await this.createRepositoryCredential({
        id: randomUUID(),
        workspaceId,
        repositoryId: repository.id,
        name: "repository-pat",
        ciphertext: input.encryptedToken,
        metadata: {}
      });
    }
    return repository;
  }

  protected async createRepositoryCredential(credential: EncryptedCredentialRecord): Promise<void> {
    this.encryptedCredentials.push(credential);
  }

  async createRepositoryWithAudit(
    workspaceId: string,
    input: RepositoryConnectionInput,
    actorId: string,
    projectId?: string
  ): Promise<RepositoryRecord | null> {
    const repositoryLength = this.repositories.length;
    const credentialLength = this.encryptedCredentials.length;
    const auditLength = this.auditEvents.length;
    try {
      const repository = await this.createRepository(workspaceId, input, projectId);
      if (!repository) return null;
      await this.recordAudit({
        workspaceId,
        actorId,
        action: "repository.connected",
        resourceType: "repository",
        resourceId: repository.id,
        metadata: { kind: repository.kind }
      });
      return repository;
    } catch (error) {
      this.repositories.splice(repositoryLength);
      this.encryptedCredentials.splice(credentialLength);
      this.auditEvents.splice(auditLength);
      throw error;
    }
  }

  async currentRepository(workspaceId: string, projectId?: string): Promise<RepositoryRecord | null> {
    return this.repositories.find((repository) =>
      repository.workspaceId === workspaceId
      && repository.archivedAt === null
      && (projectId ? repository.projectId === projectId : true)
    ) ?? null;
  }

  async listArchivedRepositories(workspaceId: string): Promise<RepositoryRecord[]> {
    return this.repositories.filter((repository) =>
      repository.workspaceId === workspaceId && repository.archivedAt !== null
    ).sort((left, right) => right.archivedAt!.getTime() - left.archivedAt!.getTime()
      || right.id.localeCompare(left.id));
  }

  async switchRepositoryWithAudit(
    workspaceId: string,
    input: RepositoryConnectionInput,
    actorId: string
  ): Promise<RepositoryRecord | null> {
    const repositorySnapshot = this.repositories.map((repository) => ({ ...repository }));
    const credentialLength = this.encryptedCredentials.length;
    const auditLength = this.auditEvents.length;
    try {
      const current = await this.currentRepository(workspaceId);
      if (!current) return null;
      const replacement = await this.insertRepository(workspaceId, input, new Date(), false);
      if (!replacement) return null;
      const archivedCurrent = { ...current, archivedAt: new Date() };
      const promotedReplacement = { ...replacement, archivedAt: null };
      this.repositories[this.repositories.indexOf(current)] = archivedCurrent;
      this.repositories[this.repositories.indexOf(replacement)] = promotedReplacement;
      await this.recordAudit({
        workspaceId,
        actorId,
        action: "repository.switched",
        resourceType: "repository",
        resourceId: promotedReplacement.id,
        metadata: { oldRepositoryId: archivedCurrent.id, newRepositoryId: promotedReplacement.id }
      });
      return promotedReplacement;
    } catch (error) {
      this.repositories.splice(0, this.repositories.length, ...repositorySnapshot);
      this.encryptedCredentials.splice(credentialLength);
      this.auditEvents.splice(auditLength);
      throw error;
    }
  }

  async prepareUploadReplacementWithAudit(
    workspaceId: string,
    name: string,
    actorId: string
  ): Promise<RepositoryRecord | null> {
    const repositoryLength = this.repositories.length;
    const auditLength = this.auditEvents.length;
    try {
      if (!await this.currentRepository(workspaceId)) return null;
      const candidate = await this.insertRepository(
        workspaceId,
        { kind: "upload", name },
        new Date(),
        false
      );
      if (!candidate) return null;
      await this.recordAudit({
        workspaceId,
        actorId,
        action: "repository.upload_replacement_prepared",
        resourceType: "repository",
        resourceId: candidate.id,
        metadata: { kind: "upload" }
      });
      return candidate;
    } catch (error) {
      this.repositories.splice(repositoryLength);
      this.auditEvents.splice(auditLength);
      throw error;
    }
  }

  async activateUploadReplacementWithAudit(
    workspaceId: string,
    repositoryId: string,
    actorId: string
  ): Promise<RepositoryRecord | null> {
    const repositorySnapshot = this.repositories.map((repository) => ({ ...repository }));
    const auditLength = this.auditEvents.length;
    try {
      const current = await this.currentRepository(workspaceId);
      const candidate = this.repositories.find((repository) =>
        repository.workspaceId === workspaceId
        && repository.id === repositoryId
        && repository.kind === "upload"
        && repository.archivedAt !== null
      );
      if (!current || !candidate) return null;
      const archivedCurrent = { ...current, archivedAt: new Date() };
      const activated = { ...candidate, archivedAt: null };
      this.repositories[this.repositories.indexOf(current)] = archivedCurrent;
      this.repositories[this.repositories.indexOf(candidate)] = activated;
      await this.recordAudit({
        workspaceId,
        actorId,
        action: "repository.switched",
        resourceType: "repository",
        resourceId: activated.id,
        metadata: { oldRepositoryId: archivedCurrent.id, newRepositoryId: activated.id }
      });
      return activated;
    } catch (error) {
      this.repositories.splice(0, this.repositories.length, ...repositorySnapshot);
      this.auditEvents.splice(auditLength);
      throw error;
    }
  }

  async discardPendingUploadReplacement(workspaceId: string, repositoryId: string): Promise<void> {
    const candidate = this.repositories.find((repository) =>
      repository.workspaceId === workspaceId
      && repository.id === repositoryId
      && repository.kind === "upload"
      && repository.archivedAt !== null
    );
    if (!candidate || this.sourceSnapshots.some((snapshot) => snapshot.repositoryId === repositoryId)) return;
    this.repositories.splice(this.repositories.indexOf(candidate), 1);
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

  async createSnapshot({ snapshot, files }: CreateSnapshotInput): Promise<SourceSnapshotRecord> {
    const existing = await this.findSnapshotByCommit(
      snapshot.workspaceId,
      snapshot.repositoryId,
      snapshot.commitSha
    );
    if (existing) return existing;
    this.sourceSnapshots.push(snapshot);
    this.sourceFiles.push(...files);
    return snapshot;
  }

  async createSnapshotWithAudit(
    input: CreateSnapshotInput,
    actorId: string
  ): Promise<SourceSnapshotRecord> {
    const snapshotLength = this.sourceSnapshots.length;
    const fileLength = this.sourceFiles.length;
    const auditLength = this.auditEvents.length;
    try {
      const persisted = await this.createSnapshot(input);
      await this.recordAudit({
        workspaceId: input.snapshot.workspaceId,
        actorId,
        action: "repository.sync_succeeded",
        resourceType: "repository",
        resourceId: input.snapshot.repositoryId,
        metadata: {
          commitSha: persisted.commitSha,
          unchanged: persisted.id !== input.snapshot.id
        }
      });
      return persisted;
    } catch (error) {
      this.sourceSnapshots.splice(snapshotLength);
      this.sourceFiles.splice(fileLength);
      this.auditEvents.splice(auditLength);
      throw error;
    }
  }

  async findSnapshotById(workspaceId: string, snapshotId: string): Promise<SourceSnapshotRecord | null> {
    return this.sourceSnapshots.find((snapshot) =>
      snapshot.workspaceId === workspaceId && snapshot.id === snapshotId
    ) ?? null;
  }

  async latestSnapshot(workspaceId: string, repositoryId: string): Promise<SourceSnapshotRecord | null> {
    return this.sourceSnapshots.filter((snapshot) =>
      snapshot.workspaceId === workspaceId && snapshot.repositoryId === repositoryId
    ).sort((left, right) => right.commitTimestamp.getTime() - left.commitTimestamp.getTime())[0] ?? null;
  }

  async findSourceFile(
    workspaceId: string,
    snapshotId: string,
    filePath: string
  ): Promise<SourceFileRecord | null> {
    return this.sourceFiles.find((file) =>
      file.workspaceId === workspaceId && file.snapshotId === snapshotId && file.path === filePath
    ) ?? null;
  }

  async countSnapshotFiles(snapshotId: string): Promise<number> {
    return this.sourceFiles.filter((file) => file.snapshotId === snapshotId).length;
  }

  async sourceFileHashes(workspaceId: string, snapshotId: string): Promise<ReadonlyMap<string, string>> {
    return new Map(this.sourceFiles.filter((file) =>
      file.workspaceId === workspaceId && file.snapshotId === snapshotId
    ).map((file) => [file.path, file.contentHash]));
  }

  async repositoryCredential(workspaceId: string, repositoryId: string): Promise<string | null> {
    return this.encryptedCredentials.find((credential) =>
      credential.workspaceId === workspaceId && credential.repositoryId === repositoryId
    )?.ciphertext ?? null;
  }

  async getModelConfig(workspaceId: string): Promise<ModelConfigRecord | null> {
    const credential = this.encryptedCredentials.find((candidate) =>
      candidate.workspaceId === workspaceId
      && candidate.repositoryId === null
      && candidate.name === "model-provider"
    );
    if (!credential) return null;
    return {
      workspaceId,
      provider: credential.metadata.provider as ModelProvider,
      model: credential.metadata.model,
      encryptedApiKey: credential.ciphertext
    };
  }

  async upsertModelConfig(
    workspaceId: string,
    input: { provider: ModelProvider; model: string; encryptedApiKey?: string },
    actorId: string
  ): Promise<ModelConfigRecord> {
    const existing = this.encryptedCredentials.find((candidate) =>
      candidate.workspaceId === workspaceId
      && candidate.repositoryId === null
      && candidate.name === "model-provider"
    );
    if (!existing && !input.encryptedApiKey) throw new Error("An API key is required");
    if (existing) {
      existing.metadata = { provider: input.provider, model: input.model };
      if (input.encryptedApiKey) existing.ciphertext = input.encryptedApiKey;
    } else {
      this.encryptedCredentials.push({
        id: randomUUID(), workspaceId, repositoryId: null, name: "model-provider",
        ciphertext: input.encryptedApiKey!, metadata: { provider: input.provider, model: input.model }
      });
    }
    await this.recordAudit({
      workspaceId, actorId, action: "model_config.updated",
      resourceType: "model_config", metadata: { provider: input.provider, model: input.model }
    });
    return (await this.getModelConfig(workspaceId))!;
  }

  async createBuild(
    input: BuildInput
  ): Promise<{ build: BuildRecord; created: boolean }> {
    const purpose = input.purpose ?? standardBuildPurpose();
    const active = this.builds.find((build) =>
      build.workspaceId === input.workspaceId
      && build.repositoryId === input.repositoryId
      && build.snapshotId === input.snapshotId
      && build.purpose.kind === purpose.kind
      && JSON.stringify(build.purpose.feedbackIds) === JSON.stringify(purpose.feedbackIds)
      && !["ready", "published", "failed"].includes(build.status)
    );
    if (active) return { build: active, created: false };
    const build: BuildRecord = {
      ...input,
      purpose,
      id: randomUUID(),
      status: "queued",
      warnings: [],
      cancelRequested: false
    };
    this.builds.push(build);
    this.buildEvents.push({
      sequence: this.nextBuildEventSequence++,
      buildId: build.id,
      status: "queued",
      occurredAt: new Date().toISOString()
    });
    return { build, created: true };
  }

  async getBuild(workspaceId: string, buildId: string): Promise<BuildRecord | null> {
    return this.builds.find((build) =>
      build.workspaceId === workspaceId && build.id === buildId
    ) ?? null;
  }

  async claimBuild(buildId: string): Promise<BuildRecord | null> {
    const candidate = this.builds.find((build) => build.id === buildId);
    if (!candidate) throw new Error("Build not found");
    if (candidate.status !== "queued") return null;
    if (this.builds.some((build) =>
      build.id !== candidate.id
      && build.workspaceId === candidate.workspaceId
      && build.repositoryId === candidate.repositoryId
      && ["syncing", "parsing", "synthesizing", "validating"].includes(build.status)
    )) return null;
    return this.transitionBuild(buildId, "queued", "syncing");
  }

  async transitionBuild(
    buildId: string,
    expectedStatus: BuildRecord["status"],
    status: BuildRecord["status"],
    details?: {
      errorMessage?: string;
      warnings?: BuildRecord["warnings"];
      requireNotCancelled?: boolean;
    }
  ): Promise<BuildRecord | null> {
    const build = this.builds.find((candidate) => candidate.id === buildId);
    if (!build) throw new Error("Build not found");
    if (build.status !== expectedStatus) return null;
    if (details?.requireNotCancelled && build.cancelRequested) return null;
    build.status = status;
    if (details?.errorMessage) build.errorMessage = details.errorMessage;
    if (details?.warnings) build.warnings = details.warnings;
    this.buildEvents.push({
      sequence: this.nextBuildEventSequence++,
      buildId,
      status,
      occurredAt: new Date().toISOString(),
      ...(details?.errorMessage ? { errorMessage: details.errorMessage } : {})
    });
    return build;
  }

  async requestBuildCancellation(workspaceId: string, buildId: string): Promise<BuildRecord | null> {
    const build = await this.getBuild(workspaceId, buildId);
    if (!build) return null;
    if (!["ready", "published", "failed"].includes(build.status)) build.cancelRequested = true;
    return build;
  }

  async listUnfinishedBuilds(): Promise<BuildRecord[]> {
    return this.builds.filter((build) => !["ready", "published", "failed"].includes(build.status));
  }

  async listBuilds(
    workspaceId: string,
    repositoryId: string,
    pagination?: Pagination
  ): Promise<BuildRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    return this.builds.filter((build) =>
      build.workspaceId === workspaceId && build.repositoryId === repositoryId
    ).reverse().slice(offset, offset + limit);
  }

  async countBuilds(workspaceId: string, repositoryId: string): Promise<number> {
    return this.builds.filter((build) =>
      build.workspaceId === workspaceId && build.repositoryId === repositoryId
    ).length;
  }

  async listBuildEvents(
    workspaceId: string,
    buildId: string,
    pagination?: Pagination
  ): Promise<BuildEvent[]> {
    const build = await this.getBuild(workspaceId, buildId);
    const { limit, offset } = normalizePagination(pagination);
    return build ? this.buildEvents.filter((event) => event.buildId === buildId)
      .slice(offset, offset + limit) : [];
  }

  async saveKnowledge({ build, index, output }: PersistedKnowledge): Promise<void> {
    if (this.knowledgePages.some((page) => page.buildId === build.id)) {
      throw new Error("Knowledge for this build is immutable");
    }
    this.indexes.set(build.id, index);
    for (const draft of output.pages) {
      this.knowledgePages.push({
        id: `${build.id}:${draft.id}`,
        workspaceId: build.workspaceId,
        repositoryId: build.repositoryId,
        buildId: build.id,
        slug: draft.slug,
        title: draft.title,
        body: draft.body,
        chunks: draft.chunks.map((chunk) => ({
          ...chunk,
          id: `${build.id}:${chunk.id}`
        }))
      });
    }
  }

  async createReleaseDraft(
    workspaceId: string,
    repositoryId: string,
    buildId: string,
    version: string
  ): Promise<ReleaseRecord> {
    const build = await this.getBuild(workspaceId, buildId);
    if (!build || build.repositoryId !== repositoryId || build.status !== "ready") {
      throw new Error("Only a ready build can create a release draft");
    }
    if (this.releases.some((release) =>
      release.repositoryId === repositoryId && release.version === version
    )) throw new Error("Release version already exists");
    const release: ReleaseRecord = {
      id: randomUUID(),
      workspaceId,
      repositoryId,
      buildId,
      snapshotId: build.snapshotId,
      version,
      createdAt: new Date(),
      publishedAt: null
    };
    this.releases.push(release);
    return release;
  }

  async publishRelease(
    workspaceId: string,
    releaseId: string,
    channel = "current"
  ): Promise<ReleaseRecord> {
    const release = this.releases.find((candidate) =>
      candidate.workspaceId === workspaceId && candidate.id === releaseId
    );
    if (!release) throw new Error("Release not found");
    const build = await this.getBuild(workspaceId, release.buildId);
    if (!build || build.status !== "ready") throw new Error("Release build is not ready");
    const published = await this.transitionBuild(build.id, "ready", "published");
    if (!published) throw new Error("Release build is no longer ready");
    release.publishedAt = new Date();
    this.releaseChannels.set(`${workspaceId}:${release.repositoryId}:${channel}`, release.id);
    return release;
  }

  async currentRelease(
    workspaceId: string,
    repositoryId: string,
    channel = "current"
  ): Promise<ReleaseRecord | null> {
    const releaseId = this.releaseChannels.get(`${workspaceId}:${repositoryId}:${channel}`);
    return this.releases.find((release) => release.id === releaseId) ?? null;
  }

  async getRelease(workspaceId: string, releaseId: string): Promise<ReleaseRecord | null> {
    return this.releaseById(workspaceId, releaseId);
  }

  async listReleases(
    workspaceId: string,
    repositoryId: string,
    pagination?: Pagination
  ): Promise<ReleaseRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    return this.releases.filter((release) =>
      release.workspaceId === workspaceId && release.repositoryId === repositoryId
    ).sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()
      || right.id.localeCompare(left.id)).slice(offset, offset + limit);
  }

  async countReleases(workspaceId: string, repositoryId: string): Promise<number> {
    return this.releases.filter((release) =>
      release.workspaceId === workspaceId && release.repositoryId === repositoryId
    ).length;
  }

  private releaseById(workspaceId: string, releaseId: string): ReleaseRecord | null {
    return this.releases.find((release) =>
      release.workspaceId === workspaceId && release.id === releaseId
    ) ?? null;
  }

  async listKnowledgePages(
    workspaceId: string,
    releaseId?: string,
    pagination?: Pagination
  ): Promise<KnowledgePageRecord[]> {
    let release = releaseId ? this.releaseById(workspaceId, releaseId) : null;
    if (!release && !releaseId) {
      const repository = await this.currentRepository(workspaceId);
      if (repository) release = await this.currentRelease(workspaceId, repository.id);
    }
    if (!release) return [];
    const { limit, offset } = normalizePagination(pagination);
    return this.knowledgePages.filter((page) =>
      page.workspaceId === workspaceId && page.buildId === release.buildId
    ).sort((left, right) => left.slug.localeCompare(right.slug) || left.id.localeCompare(right.id))
      .slice(offset, offset + limit).map(boundedKnowledgePage);
  }

  async countKnowledgePages(workspaceId: string, releaseId?: string): Promise<number> {
    let release = releaseId ? this.releaseById(workspaceId, releaseId) : null;
    if (!release && !releaseId) {
      const repository = await this.currentRepository(workspaceId);
      if (repository) release = await this.currentRelease(workspaceId, repository.id);
    }
    return release ? this.knowledgePages.filter((page) =>
      page.workspaceId === workspaceId && page.buildId === release.buildId
    ).length : 0;
  }

  async getKnowledgePage(workspaceId: string, pageId: string): Promise<KnowledgePageRecord | null> {
    const page = this.knowledgePages.find((page) =>
      page.workspaceId === workspaceId && page.id === pageId
    );
    return page ? boundedKnowledgePage(page) : null;
  }

  async findKnowledgePageBySlug(
    workspaceId: string,
    releaseId: string,
    slug: string
  ): Promise<KnowledgePageRecord | null> {
    const release = this.releaseById(workspaceId, releaseId);
    const page = release ? this.knowledgePages.find((page) =>
      page.workspaceId === workspaceId && page.buildId === release.buildId && page.slug === slug
    ) ?? null : null;
    return page ? boundedKnowledgePage(page) : null;
  }

  async findKnowledgePageByModule(
    workspaceId: string,
    releaseId: string,
    moduleId: string
  ): Promise<KnowledgePageRecord | null> {
    const release = this.releaseById(workspaceId, releaseId);
    const page = release ? this.knowledgePages.find((page) =>
      page.workspaceId === workspaceId && page.buildId === release.buildId
      && (page.title === `模块：${moduleId}` || page.title === `Module: ${moduleId}` || page.slug === moduleId)
    ) ?? null : null;
    return page ? boundedKnowledgePage(page) : null;
  }

  async findKnowledgePageBySymbol(
    workspaceId: string,
    releaseId: string,
    name: string,
    sourcePath?: string
  ): Promise<KnowledgePageRecord | null> {
    const release = this.releaseById(workspaceId, releaseId);
    const page = release ? this.knowledgePages.find((page) =>
      page.workspaceId === workspaceId && page.buildId === release.buildId
      && page.title === name
      && (!sourcePath || page.chunks.some((chunk) =>
        chunk.citations.some((citation) => citation.path === sourcePath)
      ))
    ) ?? null : null;
    return page ? boundedKnowledgePage(page) : null;
  }

  async knowledgeReleaseSummary(workspaceId: string, releaseId: string) {
    const release = this.releaseById(workspaceId, releaseId);
    const pages = release ? this.knowledgePages.filter((page) =>
      page.workspaceId === workspaceId && page.buildId === release.buildId
    ) : [];
    const chunks = pages.flatMap((page) => page.chunks);
    return {
      pageCount: pages.length,
      chunkCount: chunks.length,
      citationCount: chunks.reduce((total, chunk) => total + chunk.citations.length, 0)
    };
  }

  async searchKnowledge(
    workspaceId: string,
    repositoryId: string,
    query: string,
    releaseId?: string
  ): Promise<KnowledgeSearchResult[]> {
    const release = releaseId
      ? this.releaseById(workspaceId, releaseId)
      : await this.currentRelease(workspaceId, repositoryId);
    if (!release || release.repositoryId !== repositoryId) return [];
    const pages = await this.listKnowledgePages(workspaceId, release.id);
    const index = this.indexes.get(release.buildId);
    if (!index) return [];
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    const results: KnowledgeSearchResult[] = [];
    const add = (
      kind: KnowledgeSearchResult["kind"],
      title: string,
      score: number,
      citations: KnowledgeSearchResult["citations"],
      targetPage?: KnowledgePageRecord,
      requireTargetPage = false
    ) => {
      if (requireTargetPage && !targetPage) return;
      const foundPage = targetPage ?? pages.find((page) =>
        page.title.toLowerCase() === title.toLowerCase()
        || page.slug.endsWith(title.toLowerCase().replace(/[^a-z0-9]+/g, "-"))
      ) ?? pages[0];
      if (!foundPage) return;
      results.push({
        kind,
        title,
        score,
        excerpt: foundPage.body.slice(0, 240),
        pageId: foundPage.id,
        releaseId: release.id,
        citations
      });
    };
    for (const symbol of index.symbols) {
      const name = symbol.name.toLowerCase();
      const pathName = symbol.path.toLowerCase();
      if (name === normalized) add(symbol.kind === "module" ? "module" : "symbol", symbol.name, 100, [symbol]);
      else if (pathName === normalized) add("path", symbol.path, 90, [symbol]);
      else if (name.startsWith(normalized)) add(symbol.kind === "module" ? "module" : "symbol", symbol.name, 75, [symbol]);
      else if (pathName.startsWith(normalized)) add("path", symbol.path, 70, [symbol]);
    }
    for (const edge of index.edges) {
      const neighbor = edge.target.toLowerCase() === normalized
        ? edge.source
        : edge.source.toLowerCase() === normalized ? edge.target : null;
      if (neighbor) {
        const neighborPath = edge.target.toLowerCase() === normalized
          ? edge.citation.path
          : edge.targetPath;
        const targetPage = pages.find((page) =>
          page.title === `模块：${neighbor}`
          || page.title === `模块：${neighborPath}`
          || page.title === `Module: ${neighbor}`
          || page.title === `Module: ${neighborPath}`
          || (page.title === neighbor && page.chunks.some((chunk) =>
            chunk.citations.some((citation) => citation.path === neighborPath)
          ))
        );
        const title = targetPage?.title.startsWith("模块：")
          ? targetPage.title.slice("模块：".length)
          : targetPage?.title.startsWith("Module: ")
            ? targetPage.title.slice("Module: ".length)
            : neighbor;
        add("dependency-neighbor", title, 60, [edge.citation], targetPage, true);
      }
    }
    for (const candidate of pages) {
      if (`${candidate.title}\n${candidate.body}`.toLowerCase().includes(normalized)) {
        add("page", candidate.title, 20, candidate.chunks.flatMap((chunk) => chunk.citations), candidate);
      }
    }
    const unique = new Map<string, KnowledgeSearchResult>();
    for (const result of results) {
      const key = `${result.kind}:${result.title}:${result.pageId}`;
      const existing = unique.get(key);
      if (!existing || existing.score < result.score) unique.set(key, result);
    }
    const sorted = [...unique.values()].sort((left, right) =>
      right.score - left.score || left.title.localeCompare(right.title) || left.pageId.localeCompare(right.pageId)
    );
    const primary = sorted.filter((result) =>
      result.kind !== "dependency-neighbor" && result.kind !== "page"
    ).slice(0, 15);
    const neighbors = sorted.filter((result) => result.kind === "dependency-neighbor").slice(0, 15);
    const text = sorted.filter((result) => result.kind === "page").slice(0, 20);
    return [...primary, ...neighbors, ...text].sort((left, right) =>
      right.score - left.score || left.title.localeCompare(right.title) || left.pageId.localeCompare(right.pageId)
    ).slice(0, 50);
  }

  async knowledgeMetadata(workspaceId: string, releaseId: string): Promise<KnowledgeMetadata> {
    const release = this.releaseById(workspaceId, releaseId);
    const index = release ? this.indexes.get(release.buildId) : undefined;
    if (!index) return { symbols: [], dependencies: [] };
    return {
      symbols: index.symbols.map((symbol) => ({
        name: symbol.name, kind: symbol.kind, path: symbol.path,
        startLine: symbol.startLine, endLine: symbol.endLine, exported: symbol.exported
      })),
      dependencies: index.edges.map((edge) => ({
        source: edge.source, target: edge.target, kind: edge.kind, path: edge.citation.path,
        startLine: edge.citation.startLine, endLine: edge.citation.endLine
      }))
    };
  }
}
