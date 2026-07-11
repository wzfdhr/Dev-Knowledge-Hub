import { randomUUID } from "node:crypto";

import type {
  AdminRecord,
  AppStore,
  AuditEventInput,
  AuditEventRecord,
  CreateSnapshotInput,
  EncryptedCredentialRecord,
  KnowledgePageRecord,
  KnowledgeSearchResult,
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
  readonly encryptedCredentials: EncryptedCredentialRecord[] = [];
  readonly sourceSnapshots: SourceSnapshotRecord[] = [];
  readonly sourceFiles: SourceFileRecord[] = [];
  readonly builds: BuildRecord[] = [];
  readonly buildEvents: BuildEvent[] = [];
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

  async transitionBuild(
    buildId: string,
    status: BuildRecord["status"],
    details?: { errorMessage?: string; warnings?: BuildRecord["warnings"] }
  ): Promise<BuildRecord> {
    const build = this.builds.find((candidate) => candidate.id === buildId);
    if (!build) throw new Error("Build not found");
    build.status = status;
    if (details?.errorMessage) build.errorMessage = details.errorMessage;
    if (details?.warnings) build.warnings = details.warnings;
    this.buildEvents.push({
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
    release.publishedAt = new Date();
    this.releaseChannels.set(`${workspaceId}:${release.repositoryId}:${channel}`, release.id);
    build.status = "published";
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
      targetPage?: KnowledgePageRecord
    ) => {
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
      if (edge.target.toLowerCase() === normalized) add("dependency-neighbor", edge.source, 60, [edge.citation]);
      else if (edge.source.toLowerCase() === normalized) add("dependency-neighbor", edge.target, 60, [edge.citation]);
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
    return [...unique.values()].sort((left, right) =>
      right.score - left.score || left.title.localeCompare(right.title) || left.pageId.localeCompare(right.pageId)
    );
  }
}
