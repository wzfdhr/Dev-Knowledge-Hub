import { randomUUID } from "node:crypto";

import {
  FeedbackNotAcknowledgedError,
  InvalidFeedbackTransitionError
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
  KnowledgeSearchResult,
  McpTokenRecord,
  ReleaseRecord,
  RepositoryConnectionInput,
  RepositoryRecord,
  SourceFileRecord,
  SourceSnapshotRecord,
  SetupResult,
  WorkspaceRecord
} from "./store.js";
import type {
  BuildEvent,
  BuildRecord,
  PersistedKnowledge
} from "../knowledge/build-service.js";
import type { CodeIndex } from "../knowledge/intelligence.js";

export class MemoryAppStore implements AppStore {
  private workspace: WorkspaceRecord | null = null;
  private admin: AdminRecord | null = null;
  private repository: RepositoryRecord | null = null;
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

  async listMcpTokens(workspaceId: string): Promise<McpTokenRecord[]> {
    return this.mcpTokens.filter((token) => token.workspaceId === workspaceId);
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
    status?: AgentFeedbackStatus
  ): Promise<AgentFeedbackRecord[]> {
    return this.feedback.filter((record) =>
      record.workspaceId === workspaceId && (!status || record.status === status)
    );
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
      const result = await this.createBuild(input.build);
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

  async findSnapshotById(workspaceId: string, snapshotId: string): Promise<SourceSnapshotRecord | null> {
    return this.sourceSnapshots.find((snapshot) =>
      snapshot.workspaceId === workspaceId && snapshot.id === snapshotId
    ) ?? null;
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

  async repositoryCredential(workspaceId: string, repositoryId: string): Promise<string | null> {
    return this.encryptedCredentials.find((credential) =>
      credential.workspaceId === workspaceId && credential.repositoryId === repositoryId
    )?.ciphertext ?? null;
  }

  async createBuild(
    input: Omit<BuildRecord, "id" | "status" | "warnings" | "cancelRequested">
  ): Promise<{ build: BuildRecord; created: boolean }> {
    const active = this.builds.find((build) =>
      build.workspaceId === input.workspaceId
      && build.repositoryId === input.repositoryId
      && !["ready", "published", "failed"].includes(build.status)
    );
    if (active) return { build: active, created: false };
    const build: BuildRecord = {
      ...input,
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
    return this.transitionBuild(buildId, "queued", "syncing");
  }

  async transitionBuild(
    buildId: string,
    expectedStatus: BuildRecord["status"],
    status: BuildRecord["status"],
    details?: { errorMessage?: string; warnings?: BuildRecord["warnings"] }
  ): Promise<BuildRecord | null> {
    const build = this.builds.find((candidate) => candidate.id === buildId);
    if (!build) throw new Error("Build not found");
    if (build.status !== expectedStatus) return null;
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

  async listBuilds(workspaceId: string, repositoryId: string): Promise<BuildRecord[]> {
    return this.builds.filter((build) =>
      build.workspaceId === workspaceId && build.repositoryId === repositoryId
    );
  }

  async listBuildEvents(workspaceId: string, buildId: string): Promise<BuildEvent[]> {
    const build = await this.getBuild(workspaceId, buildId);
    return build ? this.buildEvents.filter((event) => event.buildId === buildId) : [];
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

  async listReleases(workspaceId: string, repositoryId: string): Promise<ReleaseRecord[]> {
    return this.releases.filter((release) =>
      release.workspaceId === workspaceId && release.repositoryId === repositoryId
    ).sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  private releaseById(workspaceId: string, releaseId: string): ReleaseRecord | null {
    return this.releases.find((release) =>
      release.workspaceId === workspaceId && release.id === releaseId
    ) ?? null;
  }

  async listKnowledgePages(workspaceId: string, releaseId?: string): Promise<KnowledgePageRecord[]> {
    let release = releaseId ? this.releaseById(workspaceId, releaseId) : null;
    if (!release && !releaseId) {
      const repository = this.repository?.workspaceId === workspaceId ? this.repository : null;
      if (repository) release = await this.currentRelease(workspaceId, repository.id);
    }
    if (!release) return [];
    return this.knowledgePages.filter((page) =>
      page.workspaceId === workspaceId && page.buildId === release.buildId
    ).sort((left, right) => left.slug.localeCompare(right.slug));
  }

  async getKnowledgePage(workspaceId: string, pageId: string): Promise<KnowledgePageRecord | null> {
    return this.knowledgePages.find((page) =>
      page.workspaceId === workspaceId && page.id === pageId
    ) ?? null;
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
          page.title === `Module: ${neighbor}`
          || page.title === `Module: ${neighborPath}`
          || (page.title === neighbor && page.chunks.some((chunk) =>
            chunk.citations.some((citation) => citation.path === neighborPath)
          ))
        );
        const title = targetPage?.title.startsWith("Module: ")
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
}
