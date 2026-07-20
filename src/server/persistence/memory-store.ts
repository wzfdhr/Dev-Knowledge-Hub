import { randomUUID } from "node:crypto";

import { calculateSearchResultTrust, MIN_SEARCH_RESULT_TRUST } from "../knowledge/trust.js";

import {
  boundedKnowledgePage,
  compareSourceBlobGcCursors,
  FeedbackNotAcknowledgedError,
  InvalidLegacyReleaseRollbackError,
  InvalidFeedbackTransitionError,
  LastProjectAdminError,
  LastWorkspaceAdminError,
  knowledgeMatchReason,
  normalizeSourceBlobGcCandidateLimit,
  normalizePagination,
  sourceBlobGcCursor
} from "./store.js";

import type {
  AdminRecord,
  AdminMfaRecord,
  AdminMfaRecoveryCodeRecord,
  AgentFeedbackRecord,
  AgentFeedbackStatus,
  AppStore,
  AuditEventInput,
  AuditEventRecord,
  CompleteStageRunInput,
  CompleteStageRunResult,
  FailStageRunAndCreateRetryInput,
  FailStageRunAndCreateRetryResult,
  CreateSnapshotInput,
  CreateStageRunInput,
  CreateFeedbackInput,
  CreateRemediationInput,
  EncryptedCredentialRecord,
  FeedbackRebuildInput,
  FrontendReleaseDraftProvenance,
  FinishGitSynchronizationInput,
  GitSynchronizationClaim,
  GitSynchronizationLease,
  ImportReportRecord,
  KnowledgePageRecord,
  KnowledgeMetadata,
  KnowledgeGraphRecord,
  KnowledgeSearchResult,
  ModelConfigRecord,
  ModelProvider,
  McpTokenRecord,
  CreateMcpTokenInput,
  Pagination,
  PipelineSearchDocumentInput,
  PipelineSearchDocumentRecord,
  ReleaseRecord,
  RepositoryConnectionInput,
  RepositoryRecord,
  SourceFileRecord,
  SourceAnalysisArtifactKey,
  SourceAnalysisArtifactRecord,
  SourceSnapshotRecord,
  SourceBlobRecord,
  SourceBlobGcCursor,
  SourceBlobGcPageInput,
  SourceBlobGcRunBoundary,
  LockedSourceBlobCatalog,
  SaveKnowledgeGraphInput,
  SetupResult,
  TeamMemberRecord,
  TeamRole,
  CreateUploadSessionInput,
  CompleteUploadSessionInput,
  CompleteFolderImportInput,
  CancelUploadSessionInput,
  UploadIdempotencyRecord,
  UploadManifestEntryInput,
  UploadManifestEntryRecord,
  UploadSessionMutationIdentity,
  UploadSessionRecord,
  ProjectAccess,
  ProjectMemberRecord,
  ProjectRole,
  ProjectRecord,
  ProjectFrontendRolloutRecord,
  RemediationBuildInput,
  RemediationEventRecord,
  RemediationRecord,
  RemediationListOptions,
  WorkspaceKnowledgeSearchRecord,
  WorkspaceProjectOverviewRecord,
  WorkspaceRecord
} from "./store.js";
import {
  GIT_SYNC_FAILURE_BACKOFF_MS,
  GIT_SYNC_INTERVAL_MS,
  MAX_UPLOAD_ACCEPTED_BYTES,
  MAX_UPLOAD_ACCEPTED_FILES
} from "./store.js";
import { MAX_UPLOAD_MANIFEST_METADATA_BYTES } from "../../shared/import-filter.js";
import type { PipelineStageRunRecord } from "./store.js";
import type { PipelineStageEvent } from "../knowledge/pipeline/events.js";
import {
  artifactManifestSchema,
  type ArtifactManifest,
  type BuildStage,
  type StageStatus
} from "../knowledge/pipeline/contracts.js";
import type {
  BuildInput,
  BuildEvent,
  BuildRecord,
  InitialPipelineStage,
  PersistedKnowledge
} from "../knowledge/build-service.js";
import { standardBuildPurpose } from "../knowledge/build-service.js";

function matchesKnowledgeTextQuery(value: string, query: string): boolean {
  const normalizedValue = value.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedValue.includes(normalizedQuery)) return true;
  const queryTerms = normalizedQuery.match(/[a-z0-9]+/g);
  if (!queryTerms?.length) return false;
  const words: string[] = value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return queryTerms.every((term) => words.includes(term));
}
import { transitionRemediation } from "../knowledge/remediation.js";
import type { RemediationState } from "../knowledge/remediation.js";
import type { CodeIndex } from "../knowledge/intelligence.js";
import { validateKnowledgeGraph } from "../knowledge/pipeline/graph.js";

export class MemoryAppStore implements AppStore {
  private workspace: WorkspaceRecord | null = null;
  private admin: AdminRecord | null = null;
  private readonly members: TeamMemberRecord[] = [];
  readonly adminMfa: AdminMfaRecord[] = [];
  readonly adminMfaRecoveryCodes: Array<AdminMfaRecoveryCodeRecord & { workspaceId: string; userId: string }> = [];
  private readonly projects: ProjectRecord[] = [];
  private readonly projectMembers: Array<ProjectMemberRecord & { userId: string }> = [];
  private readonly projectFrontendRollouts = new Map<string, ProjectFrontendRolloutRecord>();
  private readonly projectFrontendRolloutWrites = new Map<string, Promise<void>>();
  private readonly repositories: RepositoryRecord[] = [];
  private readonly gitSynchronizationSchedules = new Map<string, {
    nextAttemptAt: Date;
    failureCount: number;
    leaseToken: string | null;
    leaseExpiresAt: Date | null;
    lastFailureCode: string | null;
  }>();
  readonly auditEvents: AuditEventRecord[] = [];
  readonly mcpTokens: McpTokenRecord[] = [];
  readonly feedback: AgentFeedbackRecord[] = [];
  readonly remediations: RemediationRecord[] = [];
  readonly remediationEvents: RemediationEventRecord[] = [];
  readonly encryptedCredentials: EncryptedCredentialRecord[] = [];
  readonly sourceSnapshots: SourceSnapshotRecord[] = [];
  readonly sourceFiles: SourceFileRecord[] = [];
  readonly sourceBlobs: SourceBlobRecord[] = [];
  readonly sourceAnalysisArtifacts: SourceAnalysisArtifactRecord[] = [];
  readonly importReports: ImportReportRecord[] = [];
  readonly uploadSessions: UploadSessionRecord[] = [];
  readonly uploadManifestEntries: UploadManifestEntryRecord[] = [];
  readonly uploadIdempotencyKeys: UploadIdempotencyRecord[] = [];
  private readonly uploadSessionImportReports = new Map<string, string>();
  private readonly pendingSnapshotUploadSessions = new Map<string, string>();
  private readonly pendingSnapshotImportReports = new Map<string, string>();
  private readonly uploadSessionLocks = new Map<string, Promise<void>>();
  private readonly uploadIdempotencyLocks = new Map<string, Promise<void>>();
  private readonly sourceBlobLocks = new Map<string, Promise<void>>();
  private sourceBlobGcLeaseActive = false;
  private activeSourceBlobWriters = 0;
  private readonly sourceBlobWriterWaiters: Array<() => void> = [];
  private readonly sourceBlobCreationSequences = new Map<string, number>();
  private nextSourceBlobCreationSequence = 1;
  readonly builds: BuildRecord[] = [];
  readonly buildEvents: BuildEvent[] = [];
  private nextBuildEventSequence = 1;
  readonly pipelineStageRuns: PipelineStageRunRecord[] = [];
  private readonly pipelineStageAvailableAt = new Map<string, Date>();
  readonly pipelineStageEvents: PipelineStageEvent[] = [];
  readonly knowledgeArtifacts: ArtifactManifest[] = [];
  readonly pipelineSearchDocuments: PipelineSearchDocumentRecord[] = [];
  private nextPipelineStageEventSequence = 1;
  readonly knowledgePages: KnowledgePageRecord[] = [];
  readonly releases: ReleaseRecord[] = [];
  private readonly indexes = new Map<string, CodeIndex>();
  private readonly knowledgeGraphs = new Map<string, KnowledgeGraphRecord>();
  private readonly releaseChannels = new Map<string, string>();

  async isSetupComplete(): Promise<boolean> {
    return this.admin !== null;
  }

  private isSourceBlobGcCandidate(record: SourceBlobRecord): boolean {
    return record.status === "tombstoned"
      || record.status === "trash"
      || record.status === "active" && !this.sourceFiles.some((file) =>
        file.workspaceId === record.workspaceId && file.sourceBlobId === record.id
      );
  }

  private sourceBlobCreationSequence(record: SourceBlobRecord): number {
    const existing = this.sourceBlobCreationSequences.get(record.id);
    if (existing !== undefined) return existing;
    const sequence = this.nextSourceBlobCreationSequence;
    this.nextSourceBlobCreationSequence += 1;
    this.sourceBlobCreationSequences.set(record.id, sequence);
    return sequence;
  }

  async findSourceBlobGcRunBoundary(): Promise<SourceBlobGcRunBoundary | null> {
    for (const record of this.sourceBlobs) this.sourceBlobCreationSequence(record);
    const creationCutoff = this.nextSourceBlobCreationSequence - 1;
    let tail: SourceBlobGcCursor | null = null;
    for (const record of this.sourceBlobs) {
      if (!this.isSourceBlobGcCandidate(record)) continue;
      const cursor = sourceBlobGcCursor(record);
      if (!tail || compareSourceBlobGcCursors(cursor, tail) > 0) tail = cursor;
    }
    return tail ? {
      through: tail,
      creationCutoff: String(creationCutoff)
    } : null;
  }

  async listSourceBlobGcCandidates(input: SourceBlobGcPageInput): Promise<SourceBlobRecord[]> {
    const candidateLimit = normalizeSourceBlobGcCandidateLimit(input.limit);
    const creationCutoff = Number(input.creationCutoff);
    if (!Number.isSafeInteger(creationCutoff) || creationCutoff < 0) {
      throw new RangeError("Source blob GC creation cutoff is invalid");
    }
    const page: SourceBlobRecord[] = [];
    for (const record of this.sourceBlobs) {
      if (this.sourceBlobCreationSequence(record) > creationCutoff) continue;
      if (!this.isSourceBlobGcCandidate(record)) continue;
      const cursor = sourceBlobGcCursor(record);
      if (input.after && compareSourceBlobGcCursors(cursor, input.after) <= 0
        || compareSourceBlobGcCursors(cursor, input.through) > 0) continue;
      page.push(record);
      page.sort((left, right) => compareSourceBlobGcCursors(
        sourceBlobGcCursor(left), sourceBlobGcCursor(right)
      ));
      if (page.length > candidateLimit) page.pop();
    }
    return page.map((record) => ({ ...record }));
  }

  async withSourceBlobGcLease<T>(operation: () => Promise<T>): Promise<
    { acquired: true; value: T } | { acquired: false }
  > {
    if (this.sourceBlobGcLeaseActive || this.activeSourceBlobWriters > 0) return { acquired: false };
    this.sourceBlobGcLeaseActive = true;
    try {
      return { acquired: true, value: await operation() };
    } finally {
      this.sourceBlobGcLeaseActive = false;
      for (const resolve of this.sourceBlobWriterWaiters.splice(0)) resolve();
    }
  }

  async withSourceBlobWriterLock<T>(
    workspaceId: string,
    contentHash: string,
    operation: (catalog: LockedSourceBlobCatalog) => Promise<T>
  ): Promise<T> {
    while (this.sourceBlobGcLeaseActive) {
      await new Promise<void>((resolve) => this.sourceBlobWriterWaiters.push(resolve));
    }
    this.activeSourceBlobWriters += 1;
    try {
      return await this.withSourceBlobHashLock(workspaceId, contentHash, true, operation);
    } finally {
      this.activeSourceBlobWriters -= 1;
    }
  }

  async withSourceBlobLock<T>(
    workspaceId: string,
    contentHash: string,
    operation: (catalog: LockedSourceBlobCatalog) => Promise<T>
  ): Promise<T> {
    return this.withSourceBlobHashLock(workspaceId, contentHash, false, operation);
  }

  private async withSourceBlobHashLock<T>(
    workspaceId: string,
    contentHash: string,
    writer: boolean,
    operation: (catalog: LockedSourceBlobCatalog) => Promise<T>
  ): Promise<T> {
    const key = `${workspaceId}:${contentHash}`;
    const previous = this.sourceBlobLocks.get(key) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    this.sourceBlobLocks.set(key, queued);
    await previous;
    try {
      return await operation({
        findActive: async () => {
          const record = this.sourceBlobs.find((candidate) => candidate.workspaceId === workspaceId
            && candidate.contentHash === contentHash && candidate.status === "active");
          return record ? { ...record } : null;
        },
        findTombstoned: async () => {
          const record = this.sourceBlobs.find((candidate) => candidate.workspaceId === workspaceId
            && candidate.contentHash === contentHash && candidate.status === "tombstoned");
          return record ? { ...record } : null;
        },
        findById: async (sourceBlobId) => {
          const record = this.sourceBlobs.find((candidate) => candidate.workspaceId === workspaceId
            && candidate.contentHash === contentHash && candidate.id === sourceBlobId);
          return record ? { ...record } : null;
        },
        countReferences: async (sourceBlobId) => this.sourceFiles.filter((file) =>
          file.workspaceId === workspaceId && file.sourceBlobId === sourceBlobId
        ).length,
        nextGeneration: async () => Math.max(0, ...this.sourceBlobs.filter((candidate) =>
          candidate.workspaceId === workspaceId && candidate.contentHash === contentHash
        ).map((candidate) => candidate.generation)) + 1,
        create: async (input) => {
          if (!writer) throw new Error("SOURCE_BLOB_WRITER_LOCK_REQUIRED");
          if (this.workspace?.id !== workspaceId || input.workspaceId !== workspaceId
            || input.contentHash !== contentHash
            || this.sourceBlobs.some((candidate) => candidate.workspaceId === workspaceId
              && candidate.contentHash === contentHash
              && (candidate.status === "active" || candidate.status === "tombstoned"))
            || this.sourceBlobs.some((candidate) => candidate.workspaceId === workspaceId
              && candidate.contentHash === contentHash && candidate.generation === input.generation)) {
            throw new Error("SOURCE_BLOB_CONFLICT");
          }
          const record: SourceBlobRecord = {
            id: randomUUID(), ...input, status: "active", fencingToken: null,
            tombstonedAt: null, trashedAt: null, deletedAt: null
          };
          this.sourceBlobs.push(record);
          this.sourceBlobCreationSequence(record);
          return { ...record };
        },
        tombstoneIfUnreferenced: async (sourceBlobId, fencingToken, at) => {
          const record = this.sourceBlobs.find((candidate) => candidate.workspaceId === workspaceId
            && candidate.contentHash === contentHash && candidate.id === sourceBlobId
            && candidate.status === "active");
          if (!record || this.sourceFiles.some((file) =>
            file.workspaceId === workspaceId && file.sourceBlobId === sourceBlobId
          )) return null;
          Object.assign(record, {
            status: "tombstoned" as const,
            fencingToken,
            tombstonedAt: at,
            trashedAt: null,
            deletedAt: null
          });
          return { ...record };
        },
        restoreTombstoned: async (sourceBlobId, fencingToken) => {
          const record = this.sourceBlobs.find((candidate) => candidate.workspaceId === workspaceId
            && candidate.contentHash === contentHash && candidate.id === sourceBlobId
            && candidate.status === "tombstoned" && candidate.fencingToken === fencingToken);
          if (!record) return null;
          Object.assign(record, {
            status: "active" as const,
            fencingToken: null,
            tombstonedAt: null,
            trashedAt: null,
            deletedAt: null
          });
          return { ...record };
        },
        markTrash: async (sourceBlobId, fencingToken, at) => {
          const record = this.sourceBlobs.find((candidate) => candidate.workspaceId === workspaceId
            && candidate.contentHash === contentHash && candidate.id === sourceBlobId
            && candidate.status === "tombstoned" && candidate.fencingToken === fencingToken);
          if (!record) return null;
          Object.assign(record, { status: "trash" as const, trashedAt: at });
          return { ...record };
        },
        markDeletedIfUnreferenced: async (sourceBlobId, fencingToken, at) => {
          const record = this.sourceBlobs.find((candidate) => candidate.workspaceId === workspaceId
            && candidate.contentHash === contentHash && candidate.id === sourceBlobId
            && candidate.status === "trash" && candidate.fencingToken === fencingToken);
          if (!record || this.sourceFiles.some((file) =>
            file.workspaceId === workspaceId && file.sourceBlobId === sourceBlobId
          )) return null;
          Object.assign(record, { status: "deleted" as const, deletedAt: at });
          return { ...record };
        },
        recordGcInconsistency: async (sourceBlobId, reason) => {
          const record = this.sourceBlobs.find((candidate) => candidate.workspaceId === workspaceId
            && candidate.contentHash === contentHash && candidate.id === sourceBlobId);
          if (!record) return;
          await this.recordAudit({
            workspaceId,
            action: "source_blob.gc_inconsistent",
            resourceType: "source_blob",
            resourceId: record.id,
            metadata: { reason, status: record.status, generation: record.generation }
          });
        }
      });
    } finally {
      release();
      if (this.sourceBlobLocks.get(key) === queued) this.sourceBlobLocks.delete(key);
    }
  }

  async findSourceBlobById(workspaceId: string, sourceBlobId: string): Promise<SourceBlobRecord | null> {
    const record = this.sourceBlobs.find((candidate) =>
      candidate.workspaceId === workspaceId && candidate.id === sourceBlobId
    );
    return record ? { ...record } : null;
  }

  private assertActiveSourceBlobBindings(files: SourceFileRecord[]): void {
    for (const file of files) {
      if (!file.sourceBlobId) continue;
      const blob = this.sourceBlobs.find((candidate) => candidate.id === file.sourceBlobId
        && candidate.workspaceId === file.workspaceId && candidate.status === "active"
        && candidate.contentHash === file.contentHash && candidate.byteSize === file.byteSize);
      if (!blob) throw new Error("SOURCE_BLOB_NOT_ACTIVE");
    }
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
        role: "admin",
        disabledAt: null,
        sessionVersion: 1
      };
      this.members.push({ ...this.admin, createdAt: new Date() });
      const project = {
        id: randomUUID(),
        workspaceId: this.workspace.id,
        name: "默认项目",
        slug: "default-project",
        archivedAt: null,
        createdAt: new Date()
      };
      this.projects.push(project);
      this.projectMembers.push({
        id: this.admin.id,
        userId: this.admin.id,
        projectId: project.id,
        workspaceId: this.workspace.id,
        email: this.admin.email,
        role: "admin",
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
      role: member.role,
      disabledAt: member.disabledAt,
      sessionVersion: member.sessionVersion
    } : null;
  }

  async findAdminById(id: string, workspaceId: string): Promise<AdminRecord | null> {
    const member = this.members.find((candidate) => candidate.id === id && candidate.workspaceId === workspaceId);
    return member ? {
      id: member.id,
      workspaceId: member.workspaceId,
      email: member.email,
      passwordHash: member.passwordHash,
      role: member.role,
      disabledAt: member.disabledAt,
      sessionVersion: member.sessionVersion
    } : null;
  }

  async getAdminMfa(workspaceId: string, userId: string): Promise<AdminMfaRecord | null> {
    const record = this.adminMfa.find((candidate) => candidate.workspaceId === workspaceId && candidate.userId === userId);
    return record ? { ...record } : null;
  }

  async savePendingAdminMfa(workspaceId: string, userId: string, encryptedSecret: string): Promise<AdminMfaRecord> {
    const previous = this.adminMfa.find((candidate) => candidate.workspaceId === workspaceId && candidate.userId === userId);
    const record: AdminMfaRecord = {
      userId, workspaceId, encryptedSecret, enabledAt: null, failedAttempts: 0, lockedUntil: null
    };
    if (previous) this.adminMfa[this.adminMfa.indexOf(previous)] = record;
    else this.adminMfa.push(record);
    for (const candidate of this.adminMfaRecoveryCodes.filter((candidate) => candidate.workspaceId === workspaceId && candidate.userId === userId)) {
      this.adminMfaRecoveryCodes.splice(this.adminMfaRecoveryCodes.indexOf(candidate), 1);
    }
    return { ...record };
  }

  async enableAdminMfa(
    workspaceId: string, userId: string, recoveryCodeHashes: string[], actorId: string
  ): Promise<AdminMfaRecord | null> {
    const record = this.adminMfa.find((candidate) => candidate.workspaceId === workspaceId && candidate.userId === userId);
    if (!record) return null;
    record.enabledAt = new Date();
    record.failedAttempts = 0;
    record.lockedUntil = null;
    const member = this.members.find((candidate) => candidate.workspaceId === workspaceId && candidate.id === userId);
    if (!member) return null;
    member.sessionVersion += 1;
    this.adminMfaRecoveryCodes.push(...recoveryCodeHashes.map((codeHash) => ({
      id: randomUUID(), workspaceId, userId, codeHash, usedAt: null
    })));
    await this.recordAudit({ workspaceId, actorId, action: "mfa.enabled", resourceType: "admin_mfa", resourceId: userId });
    return { ...record };
  }

  async clearAdminMfaFailures(workspaceId: string, userId: string): Promise<void> {
    const record = this.adminMfa.find((candidate) => candidate.workspaceId === workspaceId && candidate.userId === userId);
    if (!record) return;
    record.failedAttempts = 0;
    record.lockedUntil = null;
  }

  async recordAdminMfaFailure(workspaceId: string, userId: string, now = new Date()): Promise<AdminMfaRecord | null> {
    const record = this.adminMfa.find((candidate) => candidate.workspaceId === workspaceId && candidate.userId === userId);
    if (!record) return null;
    if (record.lockedUntil && record.lockedUntil > now) return { ...record };
    record.failedAttempts += 1;
    if (record.failedAttempts >= 5) record.lockedUntil = new Date(now.getTime() + 15 * 60 * 1_000);
    return { ...record };
  }

  async listActiveAdminMfaRecoveryCodes(workspaceId: string, userId: string): Promise<AdminMfaRecoveryCodeRecord[]> {
    return this.adminMfaRecoveryCodes.filter((candidate) =>
      candidate.workspaceId === workspaceId && candidate.userId === userId && !candidate.usedAt
    ).map(({ id, codeHash, usedAt }) => ({ id, codeHash, usedAt }));
  }

  async consumeAdminMfaRecoveryCode(workspaceId: string, userId: string, id: string): Promise<boolean> {
    const record = this.adminMfaRecoveryCodes.find((candidate) =>
      candidate.id === id && candidate.workspaceId === workspaceId && candidate.userId === userId && !candidate.usedAt
    );
    if (!record) return false;
    record.usedAt = new Date();
    return true;
  }

  async disableAdminMfa(workspaceId: string, userId: string, actorId: string): Promise<boolean> {
    const record = this.adminMfa.find((candidate) => candidate.workspaceId === workspaceId && candidate.userId === userId);
    const member = this.members.find((candidate) => candidate.workspaceId === workspaceId && candidate.id === userId);
    if (!record || !record.enabledAt || !member) return false;
    this.adminMfa.splice(this.adminMfa.indexOf(record), 1);
    for (const candidate of this.adminMfaRecoveryCodes.filter((candidate) => candidate.workspaceId === workspaceId && candidate.userId === userId)) {
      this.adminMfaRecoveryCodes.splice(this.adminMfaRecoveryCodes.indexOf(candidate), 1);
    }
    member.sessionVersion += 1;
    await this.recordAudit({ workspaceId, actorId, action: "mfa.disabled", resourceType: "admin_mfa", resourceId: userId });
    return true;
  }

  async listTeamMembers(workspaceId: string, pagination?: Pagination): Promise<TeamMemberRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    return this.members.filter((member) => member.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
      .slice(offset, offset + limit);
  }

  async countTeamMembers(workspaceId: string): Promise<number> {
    return this.members.filter((member) => member.workspaceId === workspaceId).length;
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
      createdAt: new Date(),
      disabledAt: null,
      sessionVersion: 1
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

  async resetTeamMemberPassword(
    workspaceId: string, userId: string, passwordHash: string, actorId: string
  ): Promise<TeamMemberRecord | null> {
    const member = this.members.find((candidate) => candidate.workspaceId === workspaceId && candidate.id === userId);
    if (!member) return null;
    member.passwordHash = passwordHash;
    member.sessionVersion += 1;
    await this.recordAudit({
      workspaceId, actorId, action: "member.password_reset", resourceType: "workspace_member", resourceId: member.id
    });
    return member;
  }

  async setTeamMemberDisabled(
    workspaceId: string, userId: string, disabled: boolean, actorId: string
  ): Promise<TeamMemberRecord | null> {
    const member = this.members.find((candidate) => candidate.workspaceId === workspaceId && candidate.id === userId);
    if (!member) return null;
    if (disabled && !member.disabledAt && member.role === "admin") {
      const activeAdministrators = this.members.filter((candidate) =>
        candidate.workspaceId === workspaceId && candidate.role === "admin" && !candidate.disabledAt
      );
      if (activeAdministrators.length <= 1) throw new LastWorkspaceAdminError();
    }
    member.disabledAt = disabled ? new Date() : null;
    member.sessionVersion += 1;
    await this.recordAudit({
      workspaceId,
      actorId,
      action: disabled ? "member.disabled" : "member.enabled",
      resourceType: "workspace_member",
      resourceId: member.id
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
    const actor = this.members.find((member) => member.id === actorId && member.workspaceId === workspaceId);
    if (!actor) return null;
    const project: ProjectRecord = {
      id: randomUUID(),
      workspaceId,
      name: input.name,
      slug: input.slug,
      archivedAt: null,
      createdAt: new Date()
    };
    this.projects.push(project);
    this.projectMembers.push({
      id: actor.id,
      userId: actor.id,
      projectId: project.id,
      workspaceId,
      email: actor.email,
      role: "admin",
      createdAt: new Date()
    });
    await this.recordAudit({
      workspaceId,
      actorId,
      action: "project.created",
      resourceType: "project",
      resourceId: project.id
    });
    return project;
  }

  async getProjectFrontendRollout(
    workspaceId: string,
    projectId: string
  ): Promise<ProjectFrontendRolloutRecord | null> {
    const rollout = this.projectFrontendRollouts.get(projectId);
    return rollout?.workspaceId === workspaceId ? structuredClone(rollout) : null;
  }

  async setProjectFrontendRollout(input: {
    workspaceId: string;
    projectId: string;
    mode: ProjectFrontendRolloutRecord["mode"];
    reason: string;
    actorId: string;
  }): Promise<ProjectFrontendRolloutRecord | null> {
    const project = this.projects.find((candidate) =>
      candidate.id === input.projectId && candidate.workspaceId === input.workspaceId
    );
    const actor = this.members.find((candidate) =>
      candidate.id === input.actorId && candidate.workspaceId === input.workspaceId
        && candidate.role === "admin" && candidate.disabledAt === null
    );
    if (!project || !actor) return null;
    const previousWrite = this.projectFrontendRolloutWrites.get(project.id) ?? Promise.resolve();
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const queuedWrite = previousWrite.catch(() => undefined).then(() => writeGate);
    this.projectFrontendRolloutWrites.set(project.id, queuedWrite);
    await previousWrite.catch(() => undefined);
    try {
      const previous = this.projectFrontendRollouts.get(project.id);
      const now = new Date();
      const rollout: ProjectFrontendRolloutRecord = {
        projectId: project.id,
        workspaceId: input.workspaceId,
        mode: input.mode,
        reason: input.reason,
        updatedBy: input.actorId,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      };
      await this.recordAudit({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        action: "frontend_rollout.changed",
        resourceType: "project",
        resourceId: project.id,
        metadata: {
          projectId: project.id,
          fromMode: previous?.mode ?? "legacy",
          toMode: rollout.mode,
          reason: rollout.reason
        }
      });
      this.projectFrontendRollouts.set(project.id, rollout);
      return structuredClone(rollout);
    } finally {
      releaseWrite();
      if (this.projectFrontendRolloutWrites.get(project.id) === queuedWrite) {
        this.projectFrontendRolloutWrites.delete(project.id);
      }
    }
  }

  async listAccessibleProjects(
    workspaceId: string,
    userId: string,
    pagination?: Pagination
  ): Promise<ProjectRecord[]> {
    const member = this.members.find((candidate) => candidate.workspaceId === workspaceId && candidate.id === userId);
    if (!member) return [];
    if (member.role === "admin") return this.listProjects(workspaceId, pagination);
    const accessible = new Set(this.projectMembers
      .filter((candidate) => candidate.workspaceId === workspaceId && candidate.userId === userId)
      .map((candidate) => candidate.projectId));
    const { limit, offset } = normalizePagination(pagination);
    return this.projects.filter((project) => project.workspaceId === workspaceId && accessible.has(project.id))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
      .slice(offset, offset + limit);
  }

  async workspaceOverview(workspaceId: string, userId: string): Promise<WorkspaceProjectOverviewRecord[]> {
    const projects = await this.listAccessibleProjects(workspaceId, userId, { limit: 100 });
    return Promise.all(projects.map(async (project) => {
      const repository = await this.currentRepository(workspaceId, project.id);
      const latestSnapshot = repository ? await this.latestSnapshot(workspaceId, repository.id) : null;
      const currentRelease = repository ? await this.currentRelease(workspaceId, repository.id) : null;
      const builds = repository ? await this.listBuilds(workspaceId, repository.id, { limit: 1 }) : [];
      const snapshotFiles = latestSnapshot
        ? this.sourceFiles.filter((file) => file.snapshotId === latestSnapshot.id)
        : [];
      const feedback = repository
        ? this.feedback.filter((item) => item.workspaceId === workspaceId && item.status === "open"
          && this.releases.some((release) => release.id === item.releaseId && release.repositoryId === repository.id))
        : [];
      return {
        project,
        repository,
        latestSnapshot: latestSnapshot ? { ...latestSnapshot, fileCount: snapshotFiles.length } : null,
        indexedTextBytes: snapshotFiles.reduce((total, file) => total + file.byteSize, 0),
        currentRelease,
        latestBuild: builds[0] ?? null,
        memberCount: this.projectMembers.filter((member) => member.projectId === project.id).length,
        pendingFeedbackCount: feedback.length
      };
    }));
  }

  async searchWorkspaceKnowledge(
    workspaceId: string,
    userId: string,
    query: string
  ): Promise<WorkspaceKnowledgeSearchRecord[]> {
    const projects = await this.listAccessibleProjects(workspaceId, userId, { limit: 100 });
    const resultSets = await Promise.all(projects.map(async (project) => {
      const repository = await this.currentRepository(workspaceId, project.id);
      if (!repository || !(await this.currentRelease(workspaceId, repository.id))) return [];
      return (await this.searchKnowledge(workspaceId, repository.id, query)).map((result) => ({ ...result, project }));
    }));
    return resultSets.flat().sort((left, right) => right.score - left.score || left.title.localeCompare(right.title)).slice(0, 50);
  }

  async listProjectMembers(
    workspaceId: string,
    projectId: string,
    pagination?: Pagination
  ): Promise<ProjectMemberRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    return this.projectMembers.filter((member) =>
      member.workspaceId === workspaceId && member.projectId === projectId
    ).sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
      .slice(offset, offset + limit).map((member) => this.projectMemberRecord(member));
  }

  private projectMemberRecord(member: ProjectMemberRecord & { userId: string }): ProjectMemberRecord {
    return {
      id: member.id,
      projectId: member.projectId,
      workspaceId: member.workspaceId,
      email: member.email,
      role: member.role,
      createdAt: member.createdAt
    };
  }

  private projectMember(workspaceId: string, projectId: string, userId: string) {
    return this.projectMembers.find((member) =>
      member.workspaceId === workspaceId && member.projectId === projectId && member.userId === userId
    );
  }

  private assertProjectAdminSurvives(workspaceId: string, projectId: string, userId: string, nextRole?: ProjectRole) {
    const current = this.projectMember(workspaceId, projectId, userId);
    if (!current || current.role !== "admin" || nextRole === "admin") return;
    const otherAdmin = this.projectMembers.some((member) =>
      member.workspaceId === workspaceId && member.projectId === projectId
      && member.userId !== userId && member.role === "admin"
    );
    if (!otherAdmin) throw new LastProjectAdminError();
  }

  private canAssignProjectRole(workspaceId: string, userId: string, role: ProjectRole): boolean {
    const member = this.members.find((candidate) => candidate.workspaceId === workspaceId && candidate.id === userId);
    return Boolean(member && (member.role !== "reader" || role === "reader"));
  }

  async addProjectMember(
    workspaceId: string, projectId: string, userId: string, role: ProjectRole, actorId: string
  ): Promise<ProjectMemberRecord | null> {
    const project = this.projects.find((candidate) => candidate.workspaceId === workspaceId && candidate.id === projectId);
    const user = this.members.find((candidate) => candidate.workspaceId === workspaceId && candidate.id === userId);
    if (!project || !user || !this.canAssignProjectRole(workspaceId, userId, role) || this.projectMember(workspaceId, projectId, userId)) {
      return null;
    }
    const member = { id: user.id, userId: user.id, projectId, workspaceId, email: user.email, role, createdAt: new Date() };
    this.projectMembers.push(member);
    await this.recordAudit({ workspaceId, actorId, action: "project_member.added", resourceType: "project_member", resourceId: user.id, metadata: { projectId, userId, role } });
    return this.projectMemberRecord(member);
  }

  async updateProjectMemberRole(
    workspaceId: string, projectId: string, userId: string, role: ProjectRole, actorId: string
  ): Promise<ProjectMemberRecord | null> {
    const member = this.projectMember(workspaceId, projectId, userId);
    if (!member || !this.canAssignProjectRole(workspaceId, userId, role)) return null;
    this.assertProjectAdminSurvives(workspaceId, projectId, userId, role);
    member.role = role;
    await this.recordAudit({ workspaceId, actorId, action: "project_member.role_changed", resourceType: "project_member", resourceId: userId, metadata: { projectId, userId, role } });
    return this.projectMemberRecord(member);
  }

  async removeProjectMember(
    workspaceId: string, projectId: string, userId: string, actorId: string
  ): Promise<ProjectMemberRecord | null> {
    const member = this.projectMember(workspaceId, projectId, userId);
    if (!member) return null;
    this.assertProjectAdminSurvives(workspaceId, projectId, userId);
    const index = this.projectMembers.indexOf(member);
    this.projectMembers.splice(index, 1);
    await this.recordAudit({ workspaceId, actorId, action: "project_member.removed", resourceType: "project_member", resourceId: userId, metadata: { projectId, userId, role: member.role } });
    return this.projectMemberRecord(member);
  }

  async projectAccess(workspaceId: string, projectId: string, userId: string): Promise<ProjectAccess | null> {
    const project = this.projects.find((candidate) => candidate.workspaceId === workspaceId && candidate.id === projectId);
    const workspaceMember = this.members.find((candidate) => candidate.workspaceId === workspaceId && candidate.id === userId);
    if (!project || !workspaceMember) return null;
    if (workspaceMember.role === "admin") return { project, role: "admin" };
    const membership = this.projectMember(workspaceId, projectId, userId);
    return membership ? { project, role: membership.role } : null;
  }

  async defaultWorkspace(): Promise<WorkspaceRecord | null> {
    return this.workspace;
  }

  async recordAudit(event: AuditEventInput): Promise<void> {
    this.auditEvents.push({ id: randomUUID(), createdAt: new Date(), metadata: {}, ...event });
  }

  private projectOwnsAuditEvent(projectId: string, event: AuditEventRecord): boolean {
    if (event.resourceType === "project" && event.resourceId === projectId) return true;
    if (event.resourceType === "repository") {
      return this.repositories.some((repository) =>
        repository.id === event.resourceId && repository.projectId === projectId
      );
    }
    if (event.resourceType === "mcp_token") {
      return this.mcpTokens.some((token) => token.id === event.resourceId && token.projectId === projectId);
    }
    return event.metadata?.projectId === projectId;
  }

  async listProjectActivity(
    workspaceId: string,
    projectId: string,
    pagination?: Pagination
  ): Promise<AuditEventRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    return this.auditEvents
      .filter((event) => event.workspaceId === workspaceId && this.projectOwnsAuditEvent(projectId, event))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()
        || right.id.localeCompare(left.id))
      .slice(offset, offset + limit);
  }

  async countProjectActivity(workspaceId: string, projectId: string): Promise<number> {
    return this.auditEvents.filter((event) =>
      event.workspaceId === workspaceId && this.projectOwnsAuditEvent(projectId, event)
    ).length;
  }

  async createImportReport(
    input: Omit<ImportReportRecord, "id" | "startedAt" | "finishedAt" | "status" | "collectedFileCount" | "collectedTextBytes" | "ignored" | "snapshotId" | "failureCode">
  ): Promise<ImportReportRecord> {
    const report: ImportReportRecord = {
      ...input,
      id: randomUUID(),
      status: "running",
      startedAt: new Date(),
      finishedAt: null,
      collectedFileCount: 0,
      collectedTextBytes: 0,
      ignored: { total: 0, reasons: {} },
      snapshotId: null,
      failureCode: null
    };
    this.importReports.push(report);
    return report;
  }

  async createUploadSessionImportReport(
    input: Omit<ImportReportRecord, "id" | "startedAt" | "finishedAt" | "status" | "collectedFileCount" | "collectedTextBytes" | "ignored" | "snapshotId" | "failureCode">,
    sessionId: string
  ): Promise<ImportReportRecord> {
    const existingId = this.uploadSessionImportReports.get(sessionId);
    const existing = existingId ? this.importReports.find((report) => report.id === existingId) : undefined;
    if (existing) {
      if (existing.status !== "running") {
        Object.assign(existing, {
          status: "running", startedAt: new Date(), finishedAt: null,
          collectedFileCount: 0, collectedTextBytes: 0,
          ignored: { total: 0, reasons: {} }, snapshotId: null, failureCode: null
        });
      }
      return { ...existing };
    }
    const report = await this.createImportReport(input);
    this.uploadSessionImportReports.set(sessionId, report.id);
    return report;
  }

  async finishImportReport(
    workspaceId: string,
    reportId: string,
    input: Pick<ImportReportRecord, "status" | "collectedFileCount" | "collectedTextBytes" | "ignored" | "snapshotId" | "failureCode">
  ): Promise<ImportReportRecord | null> {
    const report = this.importReports.find((candidate) => candidate.workspaceId === workspaceId && candidate.id === reportId);
    if (!report || report.status !== "running") return null;
    Object.assign(report, input, { finishedAt: new Date() });
    return report;
  }

  async completeFolderImport(input: CompleteFolderImportInput): Promise<ImportReportRecord | null> {
    const repositorySnapshot = this.repositories.map((repository) => ({ ...repository }));
    const reportSnapshot = this.importReports.map((report) => ({ ...report }));
    const pendingImportSnapshot = new Map(this.pendingSnapshotImportReports);
    const auditLength = this.auditEvents.length;
    try {
      const report = this.importReports.find((candidate) =>
        candidate.workspaceId === input.workspaceId && candidate.id === input.reportId
        && candidate.projectId === input.projectId && candidate.repositoryId === input.repositoryId
        && candidate.actorId === input.actorId && candidate.status === "running"
      );
      if (!report) return null;
      const actor = await this.findAdminById(input.actorId, input.workspaceId);
      const access = actor ? await this.projectAccess(input.workspaceId, input.projectId, input.actorId) : null;
      const current = await this.currentRepository(input.workspaceId, input.projectId);
      if (!actor || actor.disabledAt || actor.sessionVersion !== input.actorSessionVersion
        || !access || current?.id !== input.expectedCurrentRepositoryId
        || (input.activateReplacement ? access.role !== "admin" : access.role === "reader")) return null;
      if (input.activateReplacement) {
        if (current?.id !== input.repositoryId) {
          const activated = await this.activateUploadReplacementWithAudit(
            input.workspaceId, input.projectId, input.repositoryId, input.actorId
          );
          if (!activated) return null;
        }
      } else if (current.id !== input.repositoryId) {
        return null;
      }
      const snapshot = input.report.snapshotId
        ? this.sourceSnapshots.find((candidate) =>
            candidate.id === input.report.snapshotId
            && candidate.workspaceId === input.workspaceId
            && candidate.repositoryId === input.repositoryId)
        : null;
      if (input.report.snapshotId && !snapshot) throw new Error("Folder import snapshot activation failed");
      const wasPending = snapshot
        ? this.pendingSnapshotImportReports.get(snapshot.id) === input.reportId
        : false;
      if (snapshot && this.pendingSnapshotImportReports.has(snapshot.id) && !wasPending) return null;
      if (snapshot) this.pendingSnapshotImportReports.delete(snapshot.id);
      if (snapshot) {
        await this.recordAudit({
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: "repository.sync_succeeded",
          resourceType: "repository",
          resourceId: input.repositoryId,
          metadata: { commitSha: snapshot.commitSha, unchanged: !wasPending }
        });
      }
      Object.assign(report, input.report, { finishedAt: new Date() });
      return { ...report };
    } catch (error) {
      this.repositories.splice(0, this.repositories.length, ...repositorySnapshot);
      this.importReports.splice(0, this.importReports.length, ...reportSnapshot);
      this.pendingSnapshotImportReports.clear();
      for (const [snapshotId, reportId] of pendingImportSnapshot) {
        this.pendingSnapshotImportReports.set(snapshotId, reportId);
      }
      this.auditEvents.splice(auditLength);
      throw error;
    }
  }

  async listImportReports(workspaceId: string, projectId: string, pagination?: Pagination): Promise<ImportReportRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    return this.importReports.filter((report) => report.workspaceId === workspaceId && report.projectId === projectId)
      .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime() || right.id.localeCompare(left.id))
      .slice(offset, offset + limit);
  }

  async countImportReports(workspaceId: string, projectId: string): Promise<number> {
    return this.importReports.filter((report) => report.workspaceId === workspaceId && report.projectId === projectId).length;
  }

  async deleteExpiredImportReports(cutoff: Date): Promise<number> {
    const before = this.importReports.length;
    const retained = this.importReports.filter((report) => report.status !== "failed"
      && report.status !== "cancelled"
      || !report.finishedAt
      || report.finishedAt >= cutoff);
    this.importReports.splice(0, this.importReports.length, ...retained);
    return before - retained.length;
  }

  async failStaleRunningImportReports(cutoff: Date): Promise<number> {
    let updated = 0;
    for (const report of this.importReports) {
      if (report.sourceKind !== "upload" || report.status !== "running" || report.startedAt >= cutoff) continue;
      Object.assign(report, {
        status: "failed",
        finishedAt: new Date(),
        snapshotId: null,
        failureCode: "UPLOAD_INTERRUPTED"
      });
      updated += 1;
    }
    return updated;
  }

  async createUploadSession(input: CreateUploadSessionInput): Promise<UploadSessionRecord> {
    const existing = this.uploadSessions.find((item) => item.workspaceId === input.workspaceId && item.id === input.id);
    if (existing) {
      if (existing.projectId !== input.projectId || existing.repositoryId !== input.repositoryId
        || existing.actorId !== input.actorId || existing.sessionVersion !== input.sessionVersion
        || existing.isReplacement !== input.isReplacement
        || existing.expectedCurrentRepositoryId !== input.expectedCurrentRepositoryId
        || existing.entryCount !== input.entryCount) {
        throw new Error("Upload session identity conflicts with an existing record");
      }
      return { ...existing };
    }
    const repository = this.repositories.find((candidate) => candidate.workspaceId === input.workspaceId
      && candidate.id === input.repositoryId);
    const current = this.repositories.find((candidate) => candidate.workspaceId === input.workspaceId
      && candidate.projectId === input.projectId && candidate.archivedAt === null);
    if (!repository || repository.projectId !== input.projectId
      || current?.id !== input.expectedCurrentRepositoryId) throw new Error("UPLOAD_SESSION_INVALIDATED");
    const actor = await this.findAdminById(input.actorId, input.workspaceId);
    const access = actor ? await this.projectAccess(input.workspaceId, input.projectId, input.actorId) : null;
    if (!actor || actor.disabledAt || actor.sessionVersion !== input.sessionVersion || !access
      || (input.isReplacement ? access.role !== "admin" : access.role === "reader")) {
      throw new Error("UPLOAD_SESSION_INVALIDATED");
    }
    const latest = this.sourceSnapshots.filter((snapshot) =>
      snapshot.workspaceId === input.workspaceId && snapshot.repositoryId === input.repositoryId
      && !this.pendingSnapshotUploadSessions.has(snapshot.id)
      && !this.pendingSnapshotImportReports.has(snapshot.id)
    ).sort((left, right) => right.commitTimestamp.getTime() - left.commitTimestamp.getTime())[0] ?? null;
    const now = new Date();
    const session: UploadSessionRecord = {
      ...input,
      expectedLatestSnapshotId: latest?.id ?? null,
      status: "open",
      manifestDigest: null,
      snapshotId: null,
      commitResponse: null,
      committedAt: null,
      cancelledAt: null,
      createdAt: now,
      updatedAt: now
    };
    this.uploadSessions.push(session);
    return { ...session };
  }

  async getUploadSession(workspaceId: string, sessionId: string): Promise<UploadSessionRecord | null> {
    const session = this.uploadSessions.find((item) => item.workspaceId === workspaceId && item.id === sessionId);
    return session ? { ...session } : null;
  }

  async repositoryHasActiveUploadSession(workspaceId: string, repositoryId: string): Promise<boolean> {
    return this.uploadSessions.some((session) => session.workspaceId === workspaceId
      && session.repositoryId === repositoryId && ["open", "committing"].includes(session.status));
  }

  async getUploadSessionStagingOwner(sessionId: string) {
    const session = this.uploadSessions.find((candidate) => candidate.id === sessionId);
    return session ? {
      workspaceId: session.workspaceId,
      active: ["open", "committing"].includes(session.status)
    } : null;
  }

  async saveUploadManifestPage(
    identity: UploadSessionMutationIdentity,
    entries: UploadManifestEntryInput[]
  ): Promise<UploadManifestEntryRecord[]> {
    const { workspaceId, sessionId } = identity;
    const session = this.uploadSessions.find((item) => item.workspaceId === workspaceId && item.id === sessionId);
    if (!session || session.status !== "open") return [];
    const actor = await this.findAdminById(identity.actorId, workspaceId);
    const access = actor ? await this.projectAccess(workspaceId, identity.projectId, identity.actorId) : null;
    if (session.projectId !== identity.projectId || session.actorId !== identity.actorId
      || session.sessionVersion !== identity.sessionVersion || !actor || actor.disabledAt
      || actor.sessionVersion !== identity.sessionVersion || !access
      || (session.isReplacement ? access.role !== "admin" : access.role === "reader")) return [];
    const originalLength = this.uploadManifestEntries.length;
    const now = new Date();
    try {
      const manifest = this.uploadManifestEntries.filter((item) =>
        item.workspaceId === workspaceId && item.sessionId === sessionId
      );
      const byOrdinal = new Map(manifest.map((item) => [item.ordinal, item]));
      const byPath = new Map(manifest.map((item) => [item.path, item]));
      for (const input of entries) {
        const ordinalEntry = byOrdinal.get(input.ordinal);
        const pathEntry = byPath.get(input.path);
        if (ordinalEntry || pathEntry) {
          if ((ordinalEntry && ordinalEntry.path !== input.path) || (pathEntry && pathEntry.ordinal !== input.ordinal)) {
            throw new Error("UPLOAD_MANIFEST_CONFLICT");
          }
          const existing = ordinalEntry ?? pathEntry!;
          if (existing.path !== input.path || existing.kind !== input.kind
            || existing.byteSize !== input.byteSize || existing.contentHash !== input.contentHash
            || existing.mediaType !== input.mediaType) throw new Error("UPLOAD_MANIFEST_CONFLICT");
          continue;
        }
        const record: UploadManifestEntryRecord = {
          ...input,
          sessionId,
          workspaceId,
          uploadedAt: null,
          createdAt: now,
          updatedAt: now
        };
        this.uploadManifestEntries.push(record);
        byOrdinal.set(record.ordinal, record);
        byPath.set(record.path, record);
      }
      const accepted = this.uploadManifestEntries.filter((item) => item.workspaceId === workspaceId
        && item.sessionId === sessionId && item.disposition === "upload_required");
      const persistedManifest = this.uploadManifestEntries.filter((item) => item.workspaceId === workspaceId
        && item.sessionId === sessionId);
      if (accepted.length > MAX_UPLOAD_ACCEPTED_FILES
        || accepted.reduce((total, item) => total + item.byteSize, 0) > MAX_UPLOAD_ACCEPTED_BYTES) {
        throw new Error(accepted.length > MAX_UPLOAD_ACCEPTED_FILES ? "TOO_MANY_FILES" : "FOLDER_SIZE_LIMIT");
      }
      if (persistedManifest.reduce((total, item) => total + item.metadataByteSize, 0) + persistedManifest.length + 1
        > MAX_UPLOAD_MANIFEST_METADATA_BYTES) throw new Error("MANIFEST_METADATA_LIMIT");
    } catch (error) {
      this.uploadManifestEntries.splice(originalLength);
      throw error;
    }
    const ordinals = new Set(entries.map((entry) => entry.ordinal));
    return this.uploadManifestEntries.filter((item) => item.workspaceId === workspaceId
      && item.sessionId === sessionId && ordinals.has(item.ordinal)).sort((left, right) => left.ordinal - right.ordinal)
      .map((item) => ({ ...item }));
  }

  async listUploadManifestEntries(workspaceId: string, sessionId: string, pagination?: Pagination): Promise<UploadManifestEntryRecord[]> {
    const limit = Math.min(500, Math.max(1, pagination?.limit ?? 500));
    const offset = Math.max(0, pagination?.offset ?? 0);
    return this.uploadManifestEntries
      .filter((item) => item.workspaceId === workspaceId && item.sessionId === sessionId
        && item.ordinal >= offset && item.ordinal < offset + limit)
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((item) => ({ ...item }));
  }

  async getUploadManifestEntry(workspaceId: string, sessionId: string, ordinal: number) {
    const entry = this.uploadManifestEntries.find((item) => item.workspaceId === workspaceId
      && item.sessionId === sessionId && item.ordinal === ordinal);
    return entry ? { ...entry } : null;
  }

  async verifyUploadManifestEntry(
    identity: UploadSessionMutationIdentity,
    ordinal: number,
    input: { disposition: "upload_required" | "ignored"; trust: "server_verified"; ignoreReason: string | null }
  ): Promise<UploadManifestEntryRecord | null> {
    const { workspaceId, sessionId } = identity;
    const session = this.uploadSessions.find((item) => item.workspaceId === workspaceId && item.id === sessionId);
    const actor = await this.findAdminById(identity.actorId, workspaceId);
    const access = actor ? await this.projectAccess(workspaceId, identity.projectId, identity.actorId) : null;
    if (!session || session.status !== "open" || session.projectId !== identity.projectId
      || session.actorId !== identity.actorId || session.sessionVersion !== identity.sessionVersion
      || !actor || actor.disabledAt || actor.sessionVersion !== identity.sessionVersion || !access
      || (session.isReplacement ? access.role !== "admin" : access.role === "reader")) return null;
    const entry = this.uploadManifestEntries.find((item) =>
      item.workspaceId === workspaceId && item.sessionId === sessionId && item.ordinal === ordinal
    );
    if (!entry || entry.kind !== "source" || entry.disposition === "metadata_only") return null;
    Object.assign(entry, input, { uploadedAt: new Date(), updatedAt: new Date() });
    return { ...entry };
  }

  async acquireUploadSessionLock(workspaceId: string, sessionId: string): Promise<() => Promise<void>> {
    const key = `${workspaceId}:${sessionId}`;
    const previous = this.uploadSessionLocks.get(key) ?? Promise.resolve();
    let resolveCurrent!: () => void;
    const current = new Promise<void>((resolve) => { resolveCurrent = resolve; });
    const tail = previous.then(() => current);
    this.uploadSessionLocks.set(key, tail);
    await previous;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      resolveCurrent();
      if (this.uploadSessionLocks.get(key) === tail) this.uploadSessionLocks.delete(key);
    };
  }

  async acquireUploadIdempotencyLock(workspaceId: string, actorId: string, idempotencyKey: string) {
    const key = `${workspaceId}:${actorId}:${idempotencyKey}`;
    const previous = this.uploadIdempotencyLocks.get(key) ?? Promise.resolve();
    let resolveCurrent!: () => void;
    const current = new Promise<void>((resolve) => { resolveCurrent = resolve; });
    const tail = previous.then(() => current);
    this.uploadIdempotencyLocks.set(key, tail);
    await previous;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      resolveCurrent();
      if (this.uploadIdempotencyLocks.get(key) === tail) this.uploadIdempotencyLocks.delete(key);
    };
  }

  async acquireUploadMutationLock(
    workspaceId: string,
    sessionId: string,
    actorId: string,
    idempotencyKey: string
  ) {
    const releaseIdempotency = await this.acquireUploadIdempotencyLock(workspaceId, actorId, idempotencyKey);
    try {
      const releaseSession = await this.acquireUploadSessionLock(workspaceId, sessionId);
      return async () => {
        await releaseSession();
        await releaseIdempotency();
      };
    } catch (error) {
      await releaseIdempotency();
      throw error;
    }
  }

  async markUploadSessionCommitting(workspaceId: string, sessionId: string): Promise<UploadSessionRecord | null> {
    const session = this.uploadSessions.find((item) => item.workspaceId === workspaceId && item.id === sessionId);
    if (!session || !["open", "committing"].includes(session.status)) return session ? { ...session } : null;
    session.status = "committing";
    session.updatedAt = new Date();
    return { ...session };
  }

  async completeUploadSessionCommit(input: CompleteUploadSessionInput): Promise<UploadSessionRecord | null> {
    const repositorySnapshot = this.repositories.map((repository) => ({ ...repository }));
    const reportSnapshot = this.importReports.map((report) => ({ ...report }));
    const sessionSnapshot = this.uploadSessions.map((session) => ({ ...session }));
    const sourceSnapshot = this.sourceSnapshots.map((snapshot) => ({ ...snapshot }));
    const sourceFileSnapshot = this.sourceFiles.map((file) => ({ ...file }));
    const pendingSnapshot = new Map(this.pendingSnapshotUploadSessions);
    const auditLength = this.auditEvents.length;
    try {
      const session = this.uploadSessions.find((item) =>
        item.workspaceId === input.workspaceId && item.id === input.sessionId
      );
      if (!session || session.projectId !== input.projectId || session.repositoryId !== input.repositoryId
        || session.actorId !== input.actorId || !["committing", "committed"].includes(session.status)) {
        return null;
      }
      if (session.status === "committed") return { ...session };
      if (session.expiresAt <= new Date()) return null;
      const actor = await this.findAdminById(input.actorId, input.workspaceId);
      const access = actor ? await this.projectAccess(input.workspaceId, input.projectId, input.actorId) : null;
      if (!actor || actor.disabledAt || actor.sessionVersion !== session.sessionVersion
        || !access || (session.isReplacement ? access.role !== "admin" : access.role === "reader")) return null;
      const report = this.importReports.find((item) =>
        item.workspaceId === input.workspaceId && item.id === input.reportId && item.status === "running"
      );
      const candidate = this.repositories.find((repository) =>
        repository.workspaceId === input.workspaceId && repository.projectId === input.projectId
        && repository.id === input.repositoryId
      );
      if (!report || !candidate) return null;
      const candidateSnapshot = this.sourceSnapshots.find((snapshot) =>
        snapshot.workspaceId === input.workspaceId && snapshot.repositoryId === input.repositoryId
        && snapshot.id === input.snapshotId
        && (!this.pendingSnapshotUploadSessions.has(snapshot.id)
          || this.pendingSnapshotUploadSessions.get(snapshot.id) === input.sessionId)
      );
      if (!candidateSnapshot) return null;
      const latest = this.sourceSnapshots.filter((snapshot) =>
        snapshot.workspaceId === input.workspaceId && snapshot.repositoryId === input.repositoryId
        && !this.pendingSnapshotUploadSessions.has(snapshot.id)
        && !this.pendingSnapshotImportReports.has(snapshot.id)
      ).sort((left, right) => right.commitTimestamp.getTime() - left.commitTimestamp.getTime())[0] ?? null;
      if ((latest?.id ?? null) !== session.expectedLatestSnapshotId
        && latest?.commitSha !== candidateSnapshot.commitSha) return null;
      const current = this.repositories.find((repository) =>
        repository.workspaceId === input.workspaceId && repository.projectId === input.projectId
        && !repository.archivedAt
      );
      if (!current || current.id !== session.expectedCurrentRepositoryId) return null;
      if (session.isReplacement) {
        if (!candidate.archivedAt) return null;
        current.archivedAt = new Date();
        candidate.archivedAt = null;
        await this.recordAudit({
          workspaceId: input.workspaceId, actorId: input.actorId,
          action: "repository.switched", resourceType: "repository", resourceId: candidate.id,
          metadata: { oldRepositoryId: current.id, newRepositoryId: candidate.id, projectId: input.projectId }
        });
      } else if (candidate.id !== current.id || candidate.archivedAt) {
        return null;
      }
      const duplicate = latest && latest.id !== candidateSnapshot.id
        && latest.commitSha === candidateSnapshot.commitSha ? latest : null;
      const effectiveSnapshot = duplicate ?? candidateSnapshot;
      if (duplicate) {
        this.sourceFiles.splice(0, this.sourceFiles.length,
          ...this.sourceFiles.filter((file) => file.snapshotId !== candidateSnapshot.id));
        this.sourceSnapshots.splice(this.sourceSnapshots.indexOf(candidateSnapshot), 1);
      }
      const wasPending = this.pendingSnapshotUploadSessions.get(candidateSnapshot.id) === input.sessionId;
      this.pendingSnapshotUploadSessions.delete(candidateSnapshot.id);
      const responseBody = duplicate
        ? { ...input.responseBody, snapshotId: duplicate.id, unchanged: true }
        : { ...input.responseBody };
      Object.assign(report, input.report, { snapshotId: effectiveSnapshot.id, finishedAt: new Date() });
      await this.recordAudit({
        workspaceId: input.workspaceId, actorId: input.actorId,
        action: "repository.sync_succeeded", resourceType: "repository", resourceId: input.repositoryId,
        metadata: {
          commitSha: effectiveSnapshot.commitSha,
          unchanged: Boolean(duplicate) || !wasPending
        }
      });
      Object.assign(session, {
        status: "committed", manifestDigest: input.manifestDigest,
        snapshotId: effectiveSnapshot.id, commitResponse: responseBody,
        committedAt: new Date(), updatedAt: new Date()
      });
      return { ...session, commitResponse: { ...responseBody } };
    } catch (error) {
      this.repositories.splice(0, this.repositories.length, ...repositorySnapshot);
      this.importReports.splice(0, this.importReports.length, ...reportSnapshot);
      this.uploadSessions.splice(0, this.uploadSessions.length, ...sessionSnapshot);
      this.sourceSnapshots.splice(0, this.sourceSnapshots.length, ...sourceSnapshot);
      this.sourceFiles.splice(0, this.sourceFiles.length, ...sourceFileSnapshot);
      this.pendingSnapshotUploadSessions.clear();
      for (const [snapshotId, sessionId] of pendingSnapshot) {
        this.pendingSnapshotUploadSessions.set(snapshotId, sessionId);
      }
      this.auditEvents.splice(auditLength);
      throw error;
    }
  }

  async cancelUploadSession(input: CancelUploadSessionInput) {
    const session = this.uploadSessions.find((item) => item.workspaceId === input.workspaceId && item.id === input.sessionId);
    if (!session || session.status === "committed") {
      return session ? { session: { ...session }, storagePaths: [] } : null;
    }
    const actor = await this.findAdminById(input.actorId, input.workspaceId);
    const access = actor ? await this.projectAccess(input.workspaceId, input.projectId, input.actorId) : null;
    if (!actor || actor.disabledAt || actor.sessionVersion !== input.sessionVersion
      || session.actorId !== input.actorId || session.projectId !== input.projectId
      || !access || (session.isReplacement ? access.role !== "admin" : access.role === "reader")) return null;
    const pendingSnapshots = this.sourceSnapshots.filter((snapshot) =>
      this.pendingSnapshotUploadSessions.get(snapshot.id) === input.sessionId
    );
    const pendingIds = new Set(pendingSnapshots.map((snapshot) => snapshot.id));
    this.sourceSnapshots.splice(0, this.sourceSnapshots.length,
      ...this.sourceSnapshots.filter((snapshot) => !pendingIds.has(snapshot.id)));
    this.sourceFiles.splice(0, this.sourceFiles.length,
      ...this.sourceFiles.filter((file) => !pendingIds.has(file.snapshotId)));
    for (const id of pendingIds) this.pendingSnapshotUploadSessions.delete(id);
    if (session.status !== "cancelled") {
      session.status = "cancelled";
      session.cancelledAt = new Date();
      session.updatedAt = new Date();
      const reportId = this.uploadSessionImportReports.get(input.sessionId);
      const report = this.importReports.find((candidate) => candidate.id === reportId && candidate.status === "running");
      if (report) Object.assign(report, { status: "cancelled", finishedAt: new Date(), failureCode: "UPLOAD_CANCELLED" });
    }
    return { session: { ...session }, storagePaths: pendingSnapshots.map((snapshot) => snapshot.storagePath) };
  }

  async uploadSnapshotExists(workspaceId: string, snapshotId: string, sessionId: string): Promise<boolean> {
    return this.sourceSnapshots.some((snapshot) => snapshot.workspaceId === workspaceId
      && snapshot.id === snapshotId && (!this.pendingSnapshotUploadSessions.has(snapshot.id)
        || this.pendingSnapshotUploadSessions.get(snapshot.id) === sessionId));
  }

  async listExpiredUploadSessions(now: Date) {
    return this.uploadSessions.filter((item) =>
      ["open", "committing", "committed", "cancelled"].includes(item.status) && item.expiresAt <= now
    ).map((item) => ({ id: item.id, workspaceId: item.workspaceId }));
  }

  async deleteExpiredUploadSession(workspaceId: string, sessionId: string, now: Date): Promise<string[] | null> {
    const position = this.uploadSessions.findIndex((item) =>
      item.workspaceId === workspaceId && item.id === sessionId
      && ["open", "committing", "committed", "cancelled"].includes(item.status) && item.expiresAt <= now
    );
    if (position < 0) return null;
    const repositoryId = this.uploadSessions[position]!.repositoryId;
    const pendingSnapshots = this.sourceSnapshots.filter((snapshot) =>
      this.pendingSnapshotUploadSessions.get(snapshot.id) === sessionId
    );
    const pendingIds = new Set(pendingSnapshots.map((snapshot) => snapshot.id));
    this.sourceSnapshots.splice(0, this.sourceSnapshots.length,
      ...this.sourceSnapshots.filter((snapshot) => !pendingIds.has(snapshot.id)));
    this.sourceFiles.splice(0, this.sourceFiles.length,
      ...this.sourceFiles.filter((file) => !pendingIds.has(file.snapshotId)));
    for (const id of pendingIds) this.pendingSnapshotUploadSessions.delete(id);
    const reportId = this.uploadSessionImportReports.get(sessionId);
    const report = this.importReports.find((candidate) => candidate.id === reportId && candidate.status === "running");
    if (report) Object.assign(report, { status: "failed", finishedAt: now, failureCode: "UPLOAD_SESSION_EXPIRED" });
    this.uploadSessions.splice(position, 1);
    this.uploadManifestEntries.splice(0, this.uploadManifestEntries.length,
      ...this.uploadManifestEntries.filter((item) => item.sessionId !== sessionId));
    this.uploadIdempotencyKeys.splice(0, this.uploadIdempotencyKeys.length,
      ...this.uploadIdempotencyKeys.filter((item) => item.sessionId !== sessionId));
    this.uploadSessionImportReports.delete(sessionId);
    const repository = this.repositories.find((candidate) => candidate.id === repositoryId);
    if (repository?.archivedAt
      && !this.sourceSnapshots.some((snapshot) => snapshot.repositoryId === repository.id)
      && !this.releases.some((release) => release.repositoryId === repository.id)
      && !this.uploadSessions.some((session) => session.repositoryId === repository.id
        && ["open", "committing"].includes(session.status))) {
      this.repositories.splice(this.repositories.indexOf(repository), 1);
    }
    return pendingSnapshots.map((snapshot) => snapshot.storagePath);
  }

  async findUploadIdempotencyKey(
    workspaceId: string,
    actorId: string,
    idempotencyKey: string,
    now: Date
  ): Promise<UploadIdempotencyRecord | null> {
    const index = this.uploadIdempotencyKeys.findIndex((candidate) => candidate.workspaceId === workspaceId
      && candidate.actorId === actorId && candidate.idempotencyKey === idempotencyKey);
    const item = index >= 0 ? this.uploadIdempotencyKeys[index] : undefined;
    if (item && item.expiresAt <= now) {
      this.uploadIdempotencyKeys.splice(index, 1);
      return null;
    }
    return item ? { ...item, responseBody: { ...item.responseBody } } : null;
  }

  async saveUploadIdempotencyKey(
    input: Omit<UploadIdempotencyRecord, "createdAt">
  ): Promise<UploadIdempotencyRecord> {
    const existing = await this.findUploadIdempotencyKey(
      input.workspaceId, input.actorId, input.idempotencyKey, new Date()
    );
    if (existing) return existing;
    const record = { ...input, responseBody: { ...input.responseBody }, createdAt: new Date() };
    this.uploadIdempotencyKeys.push(record);
    return { ...record, responseBody: { ...record.responseBody } };
  }

  async deleteExpiredUploadIdempotencyKeys(now: Date): Promise<number> {
    const before = this.uploadIdempotencyKeys.length;
    this.uploadIdempotencyKeys.splice(0, before, ...this.uploadIdempotencyKeys.filter((item) => item.expiresAt > now));
    return before - this.uploadIdempotencyKeys.length;
  }

  async createMcpToken(input: CreateMcpTokenInput): Promise<McpTokenRecord> {
    const now = new Date();
    const record: McpTokenRecord = {
      ...input,
      id: randomUUID(),
      scopes: input.scopes ?? ["search", "source.read"],
      expiresAt: input.expiresAt ?? new Date(now.getTime() + 90 * 24 * 60 * 60 * 1_000),
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null
    };
    this.mcpTokens.push(record);
    return record;
  }

  async createMcpTokenWithAudit(
    input: CreateMcpTokenInput,
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

  async listMcpTokens(workspaceId: string, pagination?: Pagination, projectId?: string): Promise<McpTokenRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    return this.mcpTokens.filter((token) =>
      token.workspaceId === workspaceId && (!projectId || token.projectId === projectId)
    )
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()
        || right.id.localeCompare(left.id))
      .slice(offset, offset + limit);
  }

  async countMcpTokens(workspaceId: string, projectId?: string): Promise<number> {
    return this.mcpTokens.filter((token) =>
      token.workspaceId === workspaceId && (!projectId || token.projectId === projectId)
    ).length;
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

  async rotateMcpTokenWithAudit(
    workspaceId: string,
    tokenId: string,
    replacement: Pick<McpTokenRecord, "tokenHash" | "tokenPrefix"> & { scopes?: McpTokenRecord["scopes"] },
    actorId: string
  ): Promise<{ previous: McpTokenRecord; replacement: McpTokenRecord } | null> {
    const previous = this.mcpTokens.find((candidate) =>
      candidate.id === tokenId && candidate.workspaceId === workspaceId && !candidate.revokedAt
    );
    if (!previous) return null;
    const tokenLength = this.mcpTokens.length;
    const auditLength = this.auditEvents.length;
    const previousRevokedAt = previous.revokedAt;
    try {
      const next = await this.createMcpToken({
        workspaceId,
        projectId: previous.projectId,
        name: previous.name,
        tokenHash: replacement.tokenHash,
        tokenPrefix: replacement.tokenPrefix,
        scopes: replacement.scopes ?? previous.scopes
      });
      previous.revokedAt = new Date();
      await this.recordAudit({
        workspaceId,
        actorId,
        action: "mcp_token.rotated",
        resourceType: "mcp_token",
        resourceId: previous.id,
        metadata: { replacementTokenId: next.id }
      });
      return { previous, replacement: next };
    } catch (error) {
      previous.revokedAt = previousRevokedAt;
      this.mcpTokens.splice(tokenLength);
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

  async createRemediation(input: CreateRemediationInput): Promise<RemediationRecord> {
    const repository = this.repositories.find((candidate) =>
      candidate.id === input.repositoryId
      && candidate.workspaceId === input.workspaceId
      && candidate.projectId === input.projectId
    );
    if (!repository) throw new Error("Remediation source does not match project");
    const sourceBuild = this.builds.find((build) =>
      build.id === input.sourceBuildId
      && build.workspaceId === input.workspaceId
      && build.repositoryId === input.repositoryId
    );
    if (!sourceBuild) throw new Error("Remediation source does not match project");
    const existing = this.remediations.find((candidate) =>
      candidate.workspaceId === input.workspaceId
      && candidate.sourceBuildId === input.sourceBuildId
      && candidate.issue.id === input.issue.id
    );
    if (existing) return existing;
    const now = new Date();
    const remediation: RemediationRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      repositoryId: input.repositoryId,
      sourceBuildId: input.sourceBuildId,
      issue: input.issue,
      state: "open",
      rebuildBuildId: null,
      createdAt: now,
      updatedAt: now
    };
    this.remediations.push(remediation);
    return remediation;
  }

  async getRemediation(workspaceId: string, remediationId: string): Promise<RemediationRecord | null> {
    return this.remediations.find((record) =>
      record.workspaceId === workspaceId && record.id === remediationId
    ) ?? null;
  }

  async listRemediations(
    workspaceId: string,
    projectId: string,
    options?: RemediationListOptions
  ): Promise<RemediationRecord[]> {
    const { limit, offset } = normalizePagination(options);
    return this.remediations.filter((record) =>
      record.workspaceId === workspaceId
      && record.projectId === projectId
      && (!options?.state || record.state === options.state)
      && (!options?.severity || record.issue.severity === options.severity)
      && (!options?.rule || record.issue.rule === options.rule)
    ).sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()
      || right.id.localeCompare(left.id)).slice(offset, offset + limit);
  }

  async countRemediations(
    workspaceId: string,
    projectId: string,
    state?: RemediationState
  ): Promise<number> {
    return this.remediations.filter((record) =>
      record.workspaceId === workspaceId
      && record.projectId === projectId
      && (!state || record.state === state)
    ).length;
  }

  async listRemediationEvents(workspaceId: string, remediationId: string): Promise<RemediationEventRecord[]> {
    return this.remediationEvents.filter((event) =>
      event.workspaceId === workspaceId && event.remediationId === remediationId
    );
  }

  private transitionRemediation(
    workspaceId: string,
    remediationId: string,
    state: RemediationState,
    actorId: string | null,
    reason?: string
  ): RemediationRecord | null {
    const remediation = this.remediations.find((record) =>
      record.workspaceId === workspaceId && record.id === remediationId
    );
    if (!remediation) return null;
    const fromState = remediation.state;
    transitionRemediation(fromState, state);
    remediation.state = state;
    remediation.updatedAt = new Date();
    this.remediationEvents.push({
      id: randomUUID(), workspaceId, remediationId, fromState, toState: state, actorId,
      reason: reason ?? null,
      createdAt: remediation.updatedAt
    });
    return remediation;
  }

  async transitionRemediationWithAudit(
    workspaceId: string,
    remediationId: string,
    state: RemediationState,
    actorId: string,
    reason?: string
  ): Promise<RemediationRecord | null> {
    const dismissalReason = reason?.trim();
    if (state === "dismissed" && !dismissalReason) throw new Error("Dismissal reason is required");
    const remediation = await this.getRemediation(workspaceId, remediationId);
    if (!remediation) return null;
    if (remediation.state === state) return remediation;
    const previous = { state: remediation.state, updatedAt: remediation.updatedAt };
    const eventLength = this.remediationEvents.length;
    const auditLength = this.auditEvents.length;
    try {
      const updated = this.transitionRemediation(workspaceId, remediationId, state, actorId, dismissalReason)!;
      await this.recordAudit({
        workspaceId, actorId, action: "remediation.transitioned", resourceType: "remediation",
        resourceId: remediationId, metadata: { fromState: previous.state, toState: state, ...(dismissalReason ? { reason: dismissalReason } : {}) }
      });
      return updated;
    } catch (error) {
      remediation.state = previous.state;
      remediation.updatedAt = previous.updatedAt;
      this.remediationEvents.splice(eventLength);
      this.auditEvents.splice(auditLength);
      throw error;
    }
  }

  async requestRemediationBuildWithAudit(
    input: RemediationBuildInput
  ): Promise<{ build: BuildRecord; created: boolean }> {
    const remediation = await this.getRemediation(input.workspaceId, input.remediationId);
    if (!remediation) throw new Error("Remediation must be accepted first");
    if (remediation.state === "rebuilding" && remediation.rebuildBuildId) {
      const build = await this.getBuild(input.workspaceId, remediation.rebuildBuildId);
      if (build) return { build, created: false };
      throw new Error("Remediation rebuild is unavailable");
    }
    if (remediation.state !== "accepted") throw new Error("Remediation must be accepted first");
    const buildLength = this.builds.length;
    const buildEventLength = this.buildEvents.length;
    const remediationEventLength = this.remediationEvents.length;
    const auditLength = this.auditEvents.length;
    const previousSequence = this.nextBuildEventSequence;
    const previous = { state: remediation.state, rebuildBuildId: remediation.rebuildBuildId, updatedAt: remediation.updatedAt };
    const affectedPaths = [...new Set(input.affectedPaths ?? remediation.issue.sourceRefs.map((reference) => reference.path))].sort();
    try {
      const purpose = {
        kind: "remediation" as const,
        feedbackIds: [] as [],
        feedbackContext: [] as [],
        remediationContext: [{
          remediationId: remediation.id,
          issueId: remediation.issue.id,
          sourceRefs: remediation.issue.sourceRefs,
          affectedPaths
        }]
      };
      const result = await this.createBuild({ ...input.build, purpose });
      remediation.rebuildBuildId = result.build.id;
      this.transitionRemediation(input.workspaceId, remediation.id, "rebuilding", input.actorId);
      await this.recordAudit({
        workspaceId: input.workspaceId, actorId: input.actorId,
        action: "remediation.rebuild_requested", resourceType: "remediation",
        resourceId: remediation.id, metadata: { buildId: result.build.id, issueId: remediation.issue.id, affectedPaths }
      });
      return result;
    } catch (error) {
      this.builds.splice(buildLength);
      this.buildEvents.splice(buildEventLength);
      this.remediationEvents.splice(remediationEventLength);
      this.auditEvents.splice(auditLength);
      this.nextBuildEventSequence = previousSequence;
      remediation.state = previous.state;
      remediation.rebuildBuildId = previous.rebuildBuildId;
      remediation.updatedAt = previous.updatedAt;
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

  async listActiveGitRepositories(): Promise<RepositoryRecord[]> {
    return this.repositories.filter((repository) => repository.kind === "git" && repository.archivedAt === null);
  }

  async claimDueGitSynchronizations(
    now: Date,
    limit: number,
    leaseDurationMs: number
  ): Promise<GitSynchronizationClaim[]> {
    if (!Number.isInteger(limit) || limit < 1) return [];
    if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) return [];
    const claims: GitSynchronizationClaim[] = [];
    const repositories = await this.listActiveGitRepositories();
    for (const repository of repositories) {
      if (claims.length >= limit) break;
      const schedule = this.gitSynchronizationSchedules.get(repository.id) ?? {
        nextAttemptAt: now,
        failureCount: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        lastFailureCode: null
      };
      this.gitSynchronizationSchedules.set(repository.id, schedule);
      const leaseExpired = schedule.leaseExpiresAt === null || schedule.leaseExpiresAt.getTime() <= now.getTime();
      if (schedule.nextAttemptAt.getTime() > now.getTime() || !leaseExpired) continue;
      const leaseToken = randomUUID();
      schedule.leaseToken = leaseToken;
      schedule.leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
      claims.push({ repository, leaseToken });
    }
    return claims;
  }

  async finishGitSynchronization(input: FinishGitSynchronizationInput): Promise<boolean> {
    const schedule = this.gitSynchronizationSchedules.get(input.repositoryId);
    if (!schedule || schedule.leaseToken !== input.leaseToken || !schedule.leaseExpiresAt
      || schedule.leaseExpiresAt.getTime() <= input.now.getTime()) return false;
    schedule.leaseToken = null;
    schedule.leaseExpiresAt = null;
    if (input.status === "succeeded") {
      schedule.failureCount = 0;
      schedule.lastFailureCode = null;
      schedule.nextAttemptAt = new Date(input.now.getTime() + GIT_SYNC_INTERVAL_MS);
      return true;
    }
    schedule.failureCount += 1;
    schedule.lastFailureCode = input.failureCode ?? "SCHEDULED_SYNC_FAILED";
    const delay = schedule.failureCount === 1
      ? GIT_SYNC_FAILURE_BACKOFF_MS
      : Math.min(GIT_SYNC_FAILURE_BACKOFF_MS * 6 * (schedule.failureCount - 1), 2 * GIT_SYNC_INTERVAL_MS);
    schedule.nextAttemptAt = new Date(input.now.getTime() + delay);
    return true;
  }

  async getRepository(workspaceId: string, repositoryId: string): Promise<RepositoryRecord | null> {
    return this.repositories.find((repository) =>
      repository.workspaceId === workspaceId && repository.id === repositoryId
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
    projectId: string,
    input: RepositoryConnectionInput,
    actorId: string
  ): Promise<RepositoryRecord | null> {
    const repositorySnapshot = this.repositories.map((repository) => ({ ...repository }));
    const credentialLength = this.encryptedCredentials.length;
    const auditLength = this.auditEvents.length;
    try {
      const current = await this.currentRepository(workspaceId, projectId);
      if (!current) return null;
      const replacement = await this.insertRepository(workspaceId, input, new Date(), false, projectId);
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
    projectId: string,
    name: string,
    actorId: string
  ): Promise<RepositoryRecord | null> {
    const repositoryLength = this.repositories.length;
    const auditLength = this.auditEvents.length;
    try {
      if (!await this.currentRepository(workspaceId, projectId)) return null;
      const reusable = this.repositories.filter((repository) => repository.workspaceId === workspaceId
        && repository.projectId === projectId && repository.kind === "upload" && repository.archivedAt
        && !this.releases.some((release) => release.repositoryId === repository.id)
        && !this.builds.some((build) => build.repositoryId === repository.id)
        && (this.uploadSessions.some((session) => session.repositoryId === repository.id
          && session.actorId === actorId && ["open", "committing"].includes(session.status))
          || (!this.uploadSessions.some((session) => session.repositoryId === repository.id
            && ["open", "committing"].includes(session.status))
            && !this.sourceSnapshots.some((snapshot) => snapshot.repositoryId === repository.id))))
        .sort((left, right) => right.archivedAt!.getTime() - left.archivedAt!.getTime())[0];
      if (reusable) return reusable;
      const candidate = await this.insertRepository(
        workspaceId,
        { kind: "upload", name },
        new Date(),
        false,
        projectId
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
    projectId: string,
    repositoryId: string,
    actorId: string
  ): Promise<RepositoryRecord | null> {
    const repositorySnapshot = this.repositories.map((repository) => ({ ...repository }));
    const auditLength = this.auditEvents.length;
    try {
      const current = await this.currentRepository(workspaceId, projectId);
      const candidate = this.repositories.find((repository) =>
        repository.workspaceId === workspaceId
        && repository.projectId === projectId
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
    if (!candidate || this.sourceSnapshots.some((snapshot) => snapshot.repositoryId === repositoryId)
      || this.uploadSessions.some((session) => session.repositoryId === repositoryId
        && ["open", "committing"].includes(session.status))) return;
    this.repositories.splice(this.repositories.indexOf(candidate), 1);
  }

  async findSnapshotByCommit(
    workspaceId: string,
    repositoryId: string,
    commitSha: string,
    pendingUploadSessionId?: string,
    pendingImportReportId?: string
  ): Promise<SourceSnapshotRecord | null> {
    return this.sourceSnapshots.find((snapshot) =>
      snapshot.workspaceId === workspaceId
      && snapshot.repositoryId === repositoryId
      && snapshot.commitSha === commitSha
      && (!this.pendingSnapshotUploadSessions.has(snapshot.id)
        || this.pendingSnapshotUploadSessions.get(snapshot.id) === pendingUploadSessionId)
      && (!this.pendingSnapshotImportReports.has(snapshot.id)
        || this.pendingSnapshotImportReports.get(snapshot.id) === pendingImportReportId)
    ) ?? null;
  }

  async discardPendingFolderImport(
    workspaceId: string,
    reportId: string,
    snapshotId: string
  ): Promise<string | null> {
    const snapshot = this.sourceSnapshots.find((candidate) =>
      candidate.workspaceId === workspaceId
      && candidate.id === snapshotId
      && this.pendingSnapshotImportReports.get(candidate.id) === reportId
    );
    if (!snapshot) return null;
    this.sourceFiles.splice(0, this.sourceFiles.length,
      ...this.sourceFiles.filter((file) => file.snapshotId !== snapshot.id));
    this.sourceSnapshots.splice(this.sourceSnapshots.indexOf(snapshot), 1);
    this.pendingSnapshotImportReports.delete(snapshot.id);
    return snapshot.storagePath;
  }

  async discardStalePendingFolderImport(
    workspaceId: string,
    reportId: string,
    snapshotId: string,
    cutoff: Date
  ): Promise<boolean> {
    const report = this.importReports.find((candidate) =>
      candidate.workspaceId === workspaceId && candidate.id === reportId
      && (["failed", "cancelled"].includes(candidate.status)
        || candidate.status === "running" && candidate.startedAt.getTime() <= cutoff.getTime())
    );
    if (!report) return false;
    await this.discardPendingFolderImport(workspaceId, reportId, snapshotId);
    if (report.status === "running") {
      Object.assign(report, {
        status: "failed",
        finishedAt: new Date(),
        snapshotId: null,
        failureCode: "UPLOAD_INTERRUPTED"
      });
    }
    return true;
  }

  async createSnapshot({ snapshot, files }: CreateSnapshotInput): Promise<SourceSnapshotRecord> {
    const existing = await this.findSnapshotByCommit(
      snapshot.workspaceId,
      snapshot.repositoryId,
      snapshot.commitSha
    );
    if (existing) return existing;
    this.assertActiveSourceBlobBindings(files);
    this.sourceSnapshots.push(snapshot);
    this.sourceFiles.push(...files);
    return snapshot;
  }

  async createSnapshotWithGitSynchronizationLease(
    input: CreateSnapshotInput,
    lease: GitSynchronizationLease
  ): Promise<SourceSnapshotRecord | null> {
    const schedule = this.gitSynchronizationSchedules.get(lease.repositoryId);
    const now = lease.now ?? new Date();
    if (input.snapshot.repositoryId !== lease.repositoryId || !schedule
      || schedule.leaseToken !== lease.leaseToken || !schedule.leaseExpiresAt
      || schedule.leaseExpiresAt.getTime() <= now.getTime()) return null;
    return this.createSnapshot(input);
  }

  async createSnapshotWithAudit(
    input: CreateSnapshotInput,
    actorId: string,
    pendingUploadSessionId?: string,
    pendingImportReportId?: string
  ): Promise<SourceSnapshotRecord> {
    const snapshotLength = this.sourceSnapshots.length;
    const fileLength = this.sourceFiles.length;
    const auditLength = this.auditEvents.length;
    try {
      let persisted = await this.findSnapshotByCommit(
        input.snapshot.workspaceId, input.snapshot.repositoryId,
        input.snapshot.commitSha, pendingUploadSessionId, pendingImportReportId
      );
      if (!persisted) {
        this.assertActiveSourceBlobBindings(input.files);
        this.sourceSnapshots.push(input.snapshot);
        this.sourceFiles.push(...input.files);
        persisted = input.snapshot;
        if (pendingUploadSessionId) this.pendingSnapshotUploadSessions.set(persisted.id, pendingUploadSessionId);
        if (pendingImportReportId) this.pendingSnapshotImportReports.set(persisted.id, pendingImportReportId);
      }
      if (!pendingUploadSessionId && !pendingImportReportId) {
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
      }
      return persisted;
    } catch (error) {
      this.sourceSnapshots.splice(snapshotLength);
      this.sourceFiles.splice(fileLength);
      this.auditEvents.splice(auditLength);
      this.pendingSnapshotUploadSessions.delete(input.snapshot.id);
      this.pendingSnapshotImportReports.delete(input.snapshot.id);
      throw error;
    }
  }

  async findSnapshotById(workspaceId: string, snapshotId: string): Promise<SourceSnapshotRecord | null> {
    return this.sourceSnapshots.find((snapshot) =>
      snapshot.workspaceId === workspaceId && snapshot.id === snapshotId
      && !this.pendingSnapshotUploadSessions.has(snapshot.id)
      && !this.pendingSnapshotImportReports.has(snapshot.id)
    ) ?? null;
  }

  async listSnapshotFiles(workspaceId: string, snapshotId: string): Promise<SourceFileRecord[]> {
    return this.sourceFiles.filter((file) => file.workspaceId === workspaceId && file.snapshotId === snapshotId)
      .sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id))
      .map((file) => ({ ...file }));
  }

  async latestSnapshot(workspaceId: string, repositoryId: string): Promise<SourceSnapshotRecord | null> {
    return this.sourceSnapshots.filter((snapshot) =>
      snapshot.workspaceId === workspaceId && snapshot.repositoryId === repositoryId
      && !this.pendingSnapshotUploadSessions.has(snapshot.id)
      && !this.pendingSnapshotImportReports.has(snapshot.id)
    ).sort((left, right) => right.commitTimestamp.getTime() - left.commitTimestamp.getTime())[0] ?? null;
  }

  async snapshotChangeSummary(workspaceId: string, repositoryId: string, snapshotId: string) {
    const snapshots = this.sourceSnapshots.filter((snapshot) => snapshot.workspaceId === workspaceId
      && snapshot.repositoryId === repositoryId && !this.pendingSnapshotUploadSessions.has(snapshot.id))
      .filter((snapshot) => !this.pendingSnapshotImportReports.has(snapshot.id))
      .sort((left, right) => left.commitTimestamp.getTime() - right.commitTimestamp.getTime() || left.id.localeCompare(right.id));
    const position = snapshots.findIndex((snapshot) => snapshot.id === snapshotId);
    if (position < 0) return null;
    const current = new Map(this.sourceFiles.filter((file) => file.snapshotId === snapshotId).map((file) => [file.path, file.contentHash]));
    const previousSnapshot = snapshots[position - 1];
    const previous = new Map(this.sourceFiles.filter((file) => file.snapshotId === previousSnapshot?.id).map((file) => [file.path, file.contentHash]));
    const added = [...current.keys()].filter((path) => !previous.has(path)).sort();
    const deleted = [...previous.keys()].filter((path) => !current.has(path)).sort();
    const modified = [...current.keys()].filter((path) => previous.has(path) && previous.get(path) !== current.get(path)).sort();
    return {
      snapshotId, previousSnapshotId: previousSnapshot?.id ?? null, added, modified, deleted,
      requiresBuild: added.length + modified.length + deleted.length > 0,
      affectedModules: [], suggestedTests: []
    };
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

  async findProjectSourceFile(
    workspaceId: string,
    projectId: string,
    snapshotId: string,
    filePath: string
  ): Promise<SourceFileRecord | null> {
    const snapshot = this.sourceSnapshots.find((candidate) =>
      candidate.workspaceId === workspaceId && candidate.id === snapshotId
    );
    const repository = snapshot
      ? this.repositories.find((candidate) => candidate.id === snapshot.repositoryId)
      : null;
    if (!repository || repository.workspaceId !== workspaceId || repository.projectId !== projectId) return null;
    return this.findSourceFile(workspaceId, snapshotId, filePath);
  }

  async countSnapshotFiles(snapshotId: string): Promise<number> {
    return this.sourceFiles.filter((file) => file.snapshotId === snapshotId).length;
  }

  async snapshotTextBytes(snapshotId: string): Promise<number> {
    return this.sourceFiles
      .filter((file) => file.snapshotId === snapshotId)
      .reduce((total, file) => total + file.byteSize, 0);
  }

  async sourceFileHashes(workspaceId: string, snapshotId: string): Promise<ReadonlyMap<string, string>> {
    return new Map(this.sourceFiles.filter((file) =>
      file.workspaceId === workspaceId && file.snapshotId === snapshotId
    ).map((file) => [file.path, file.contentHash]));
  }

  async snapshotFileMetadata(workspaceId: string, snapshotId: string) {
    return this.sourceFiles
      .filter((file) => file.workspaceId === workspaceId && file.snapshotId === snapshotId)
      .map(({ path, byteSize, contentHash }) => ({ path, byteSize, contentHash }));
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
    const { llmAudit, ...buildInput } = input;
    const purpose = input.purpose ?? standardBuildPurpose();
    const active = this.builds.find((build) =>
      build.workspaceId === input.workspaceId
      && build.repositoryId === input.repositoryId
      && build.snapshotId === input.snapshotId
      && build.purpose.kind === purpose.kind
      && build.allowLlm === (input.allowLlm === true)
      && JSON.stringify(build.purpose.feedbackIds) === JSON.stringify(purpose.feedbackIds)
      && JSON.stringify(build.purpose.remediationContext ?? []) === JSON.stringify(purpose.remediationContext ?? [])
      && !["ready", "published", "failed"].includes(build.status)
    );
    if (active) return { build: active, created: false };
    const build: BuildRecord = {
      ...buildInput,
      purpose,
      allowLlm: input.allowLlm === true,
      id: randomUUID(),
      status: "queued",
      warnings: [],
      cancelRequested: false
    };
    if (llmAudit) {
      await this.recordAudit({
        workspaceId: build.workspaceId,
        actorId: llmAudit.actorId,
        action: "build.llm_opted_in",
        resourceType: "build",
        resourceId: build.id,
        metadata: { projectId: llmAudit.projectId, snapshotId: build.snapshotId }
      });
    }
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

  async transitionBuildAndCreateInitialStage(
    buildId: string,
    expectedStatus: BuildRecord["status"],
    status: BuildRecord["status"],
    details: {
      errorMessage?: string;
      warnings?: BuildRecord["warnings"];
      requireNotCancelled?: boolean;
    },
    stage: InitialPipelineStage
  ): Promise<{ build: BuildRecord; initialStage: { stageRunId: string; projectId: string } } | null> {
    const repository = this.repositories.find((candidate) => candidate.id === this.builds.find((build) => build.id === buildId)?.repositoryId);
    if (!repository) throw new Error("Initial stage run does not match the project build and snapshot");
    const build = await this.transitionBuild(buildId, expectedStatus, status, details);
    if (!build) return null;
    const run = await this.createStageRun({
      workspaceId: build.workspaceId,
      projectId: repository.projectId,
      snapshotId: build.snapshotId,
      buildId: build.id,
      stage: "convert",
      attempt: 1,
      inputDigest: stage.inputDigest
    });
    return { build, initialStage: { stageRunId: run.id, projectId: run.projectId } };
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

  async createStageRun(input: CreateStageRunInput): Promise<PipelineStageRunRecord> {
    const existing = this.pipelineStageRuns.find((run) =>
      run.buildId === input.buildId && run.stage === input.stage && run.attempt === input.attempt
    );
    if (existing) return existing;
    const run: PipelineStageRunRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      buildId: input.buildId,
      stage: input.stage,
      attempt: input.attempt,
      status: "queued",
      inputDigest: input.inputDigest,
      outputManifestIds: [],
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorDetail: null
    };
    this.pipelineStageRuns.push(run);
    this.pipelineStageAvailableAt.set(run.id, input.availableAt ?? new Date());
    this.recordPipelineStageEvent(run);
    return run;
  }

  async claimNextStageRun(
    workspaceId: string,
    projectId: string,
    scope: { buildId?: string; stage?: BuildStage } = {}
  ): Promise<PipelineStageRunRecord | null> {
    const run = this.pipelineStageRuns.find((candidate) =>
      candidate.workspaceId === workspaceId
      && candidate.projectId === projectId
      && candidate.status === "queued"
      && (!scope.buildId || candidate.buildId === scope.buildId)
      && (!scope.stage || candidate.stage === scope.stage)
    );
    if (!run) return null;
    run.status = "running";
    run.startedAt = new Date().toISOString();
    this.recordPipelineStageEvent(run);
    return run;
  }

  async claimStageRun(
    stageRunId: string,
    buildId: string,
    projectId: string
  ): Promise<PipelineStageRunRecord | null> {
    const run = this.pipelineStageRuns.find((candidate) =>
      candidate.id === stageRunId && candidate.buildId === buildId
      && candidate.projectId === projectId && candidate.status === "queued"
    );
    if (!run) return null;
    run.status = "running";
    run.startedAt = new Date().toISOString();
    this.recordPipelineStageEvent(run);
    return run;
  }

  async listQueuedStageRuns(): Promise<PipelineStageRunRecord[]> {
    const now = new Date();
    return this.pipelineStageRuns.filter((run) => run.status === "queued"
      && (this.pipelineStageAvailableAt.get(run.id) ?? now) <= now
    ).map((run) => structuredClone(run));
  }

  async listStaleRunningStageRuns(staleBefore: Date): Promise<PipelineStageRunRecord[]> {
    return this.pipelineStageRuns.filter((run) => run.status === "running"
      && run.startedAt !== null && new Date(run.startedAt) < staleBefore
    ).map((run) => structuredClone(run));
  }

  async transitionStageRun(
    workspaceId: string,
    projectId: string,
    stageRunId: string,
    expectedStatus: StageStatus,
    status: StageStatus,
    details: { outputManifestIds?: string[]; errorCode?: string; errorDetail?: string } = {}
  ): Promise<PipelineStageRunRecord | null> {
    const run = this.pipelineStageRuns.find((candidate) =>
      candidate.id === stageRunId && candidate.workspaceId === workspaceId
      && candidate.projectId === projectId && candidate.status === expectedStatus
    );
    if (!run) return null;
    const now = new Date().toISOString();
    run.status = status;
    run.startedAt ??= now;
    run.finishedAt = ["succeeded", "failed", "cancelled", "reused", "skipped"].includes(status) ? now : null;
    run.outputManifestIds = details.outputManifestIds ?? run.outputManifestIds;
    run.errorCode = status === "failed" ? details.errorCode ?? null : null;
    run.errorDetail = status === "failed" ? details.errorDetail ?? null : null;
    this.recordPipelineStageEvent(run);
    return run;
  }

  async failStageRunAndCreateRetry(
    input: FailStageRunAndCreateRetryInput
  ): Promise<FailStageRunAndCreateRetryResult> {
    const failed = await this.transitionStageRun(
      input.workspaceId, input.projectId, input.stageRunId, "running", "failed", {
        errorCode: input.errorCode,
        errorDetail: input.errorDetail
      }
    );
    if (!failed || !input.retry) return { failed, retry: null };
    const retry = await this.createStageRun({
      workspaceId: failed.workspaceId,
      projectId: failed.projectId,
      snapshotId: failed.snapshotId,
      buildId: failed.buildId,
      stage: failed.stage,
      attempt: failed.attempt + 1,
      inputDigest: input.retry.inputDigest,
      availableAt: input.retry.availableAt
    });
    return { failed, retry };
  }

  async completeStageRunAndCreateNext(input: CompleteStageRunInput): Promise<CompleteStageRunResult | null> {
    const completed = await this.transitionStageRun(
      input.workspaceId, input.projectId, input.stageRunId, "running", input.status,
      { outputManifestIds: input.outputManifestIds }
    );
    if (!completed) return null;
    const next = input.next ? await this.createStageRun(input.next) : null;
    return { completed, next };
  }

  async createArtifactWithAudit(manifestInput: ArtifactManifest, actorId?: string): Promise<ArtifactManifest> {
    const manifest = artifactManifestSchema.parse(manifestInput);
    const build = this.builds.find((candidate) => candidate.id === manifest.buildId
      && candidate.workspaceId === manifest.workspaceId && candidate.snapshotId === manifest.snapshotId);
    const repository = build && this.repositories.find((candidate) => candidate.id === build.repositoryId
      && candidate.workspaceId === manifest.workspaceId && candidate.projectId === manifest.projectId);
    const snapshot = this.sourceSnapshots.find((candidate) => candidate.id === manifest.snapshotId
      && candidate.workspaceId === manifest.workspaceId && candidate.repositoryId === build?.repositoryId);
    if (!build || !repository || !snapshot) {
      throw new Error("Artifact does not match the project build and snapshot");
    }
    const existing = this.knowledgeArtifacts.find((candidate) =>
      candidate.workspaceId === manifest.workspaceId
      && candidate.projectId === manifest.projectId
      && candidate.snapshotId === manifest.snapshotId
      && candidate.stage === manifest.stage
      && candidate.kind === manifest.kind
      && candidate.inputDigest === manifest.inputDigest
    );
    if (existing) {
      if (existing.contentDigest !== manifest.contentDigest || existing.storageKey !== manifest.storageKey) {
        throw new Error("Artifact cache collision");
      }
      return structuredClone(existing);
    }
    const contentAddressed = this.knowledgeArtifacts.find((candidate) => candidate.storageKey === manifest.storageKey);
    if (contentAddressed) {
      if (contentAddressed.workspaceId !== manifest.workspaceId
        || contentAddressed.projectId !== manifest.projectId
        || contentAddressed.snapshotId !== manifest.snapshotId
        || contentAddressed.stage !== manifest.stage
        || contentAddressed.kind !== manifest.kind
        || contentAddressed.contentDigest !== manifest.contentDigest) {
        throw new Error("Artifact cache collision");
      }
      return structuredClone(contentAddressed);
    }
    this.knowledgeArtifacts.push(structuredClone(manifest));
    await this.recordAudit({
      workspaceId: manifest.workspaceId,
      actorId,
      action: "knowledge_artifact.created",
      resourceType: "knowledge_artifact",
      resourceId: manifest.id,
      metadata: { stage: manifest.stage, kind: manifest.kind, contentDigest: manifest.contentDigest }
    });
    return structuredClone(manifest);
  }

  async findReusableArtifact(
    workspaceId: string,
    projectId: string,
    snapshotId: string,
    stage: BuildStage,
    kind: string,
    inputDigest: string
  ): Promise<ArtifactManifest | null> {
    const artifact = this.knowledgeArtifacts.find((candidate) =>
      candidate.workspaceId === workspaceId
      && candidate.projectId === projectId
      && candidate.snapshotId === snapshotId
      && candidate.stage === stage
      && candidate.kind === kind
      && candidate.inputDigest === inputDigest
    );
    return artifact ? structuredClone(artifact) : null;
  }

  async recordArtifactCacheMiss(manifest: ArtifactManifest, reason: "content_missing"): Promise<void> {
    await this.recordAudit({
      workspaceId: manifest.workspaceId,
      action: "pipeline.artifact.cache_miss",
      resourceType: "knowledge_artifact",
      resourceId: manifest.id,
      metadata: {
        reason,
        projectId: manifest.projectId,
        snapshotId: manifest.snapshotId,
        buildId: manifest.buildId,
        stage: manifest.stage,
        kind: manifest.kind
      }
    });
  }

  async findArtifactById(artifactId: string): Promise<ArtifactManifest | null> {
    const artifact = this.knowledgeArtifacts.find((candidate) => candidate.id === artifactId);
    return artifact ? structuredClone(artifact) : null;
  }

  async findSourceAnalysisArtifact(key: SourceAnalysisArtifactKey): Promise<SourceAnalysisArtifactRecord | null> {
    const artifact = this.sourceAnalysisArtifacts.find((candidate) =>
      candidate.workspaceId === key.workspaceId
      && candidate.contentHash === key.contentHash
      && candidate.analyzerId === key.analyzerId
      && candidate.analyzerVersion === key.analyzerVersion
      && candidate.parserConfigDigest === key.parserConfigDigest
    );
    return artifact ? structuredClone(artifact) : null;
  }

  async putSourceAnalysisArtifact(
    input: Omit<SourceAnalysisArtifactRecord, "createdAt">
  ): Promise<SourceAnalysisArtifactRecord> {
    if (this.workspace?.id !== input.workspaceId) {
      throw new Error("Source analysis artifact workspace does not exist");
    }
    const existing = await this.findSourceAnalysisArtifact(input);
    if (existing) {
      if (existing.factsDigest !== input.factsDigest) throw new Error("Source analysis cache collision");
      return existing;
    }
    const artifact = { ...structuredClone(input), createdAt: new Date() };
    this.sourceAnalysisArtifacts.push(artifact);
    return structuredClone(artifact);
  }

  async savePipelineSearchDocuments(input: {
    workspaceId: string;
    projectId: string;
    snapshotId: string;
    buildId: string;
    sourceArtifactId: string;
    documents: PipelineSearchDocumentInput[];
  }): Promise<PipelineSearchDocumentRecord[]> {
    const artifact = this.knowledgeArtifacts.find((candidate) => candidate.id === input.sourceArtifactId);
    if (!artifact
      || artifact.workspaceId !== input.workspaceId
      || artifact.projectId !== input.projectId
      || artifact.snapshotId !== input.snapshotId
    ) {
      throw new Error("Pipeline search document does not match the source artifact scope");
    }
    const saved: PipelineSearchDocumentRecord[] = [];
    for (const document of input.documents) {
      const existing = this.pipelineSearchDocuments.find((candidate) =>
        candidate.buildId === input.buildId
        && candidate.sourceArtifactId === input.sourceArtifactId
        && candidate.documentKey === document.documentKey
      );
      if (existing) {
        saved.push(structuredClone(existing));
        continue;
      }
      const record: PipelineSearchDocumentRecord = {
        ...structuredClone(document),
        id: randomUUID(),
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        snapshotId: input.snapshotId,
        buildId: input.buildId,
        sourceArtifactId: input.sourceArtifactId,
        createdAt: new Date()
      };
      this.pipelineSearchDocuments.push(record);
      saved.push(structuredClone(record));
    }
    return saved;
  }

  async listPipelineSearchDocuments(
    workspaceId: string,
    projectId: string,
    buildId: string
  ): Promise<PipelineSearchDocumentRecord[]> {
    return this.pipelineSearchDocuments.filter((document) =>
      document.workspaceId === workspaceId
      && document.projectId === projectId
      && document.buildId === buildId
    ).map((document) => structuredClone(document));
  }

  async listPipelineStageRuns(
    workspaceId: string,
    projectId: string,
    buildId: string
  ): Promise<PipelineStageRunRecord[]> {
    return this.pipelineStageRuns.filter((run) =>
      run.workspaceId === workspaceId && run.projectId === projectId && run.buildId === buildId
    );
  }

  async cancelPipelineStageRuns(
    workspaceId: string,
    projectId: string,
    buildId: string
  ): Promise<PipelineStageRunRecord[]> {
    const cancelled: PipelineStageRunRecord[] = [];
    for (const run of this.pipelineStageRuns) {
      if (run.workspaceId !== workspaceId || run.projectId !== projectId || run.buildId !== buildId) continue;
      if (run.status !== "queued" && run.status !== "running") continue;
      const transitioned = await this.transitionStageRun(workspaceId, projectId, run.id, run.status, "cancelled");
      if (transitioned) cancelled.push(transitioned);
    }
    return cancelled;
  }

  async listPipelineStageEvents(
    workspaceId: string,
    projectId: string,
    buildId: string,
    afterSequence: number,
    limit = 100
  ): Promise<PipelineStageEvent[]> {
    return this.pipelineStageEvents.filter((event) =>
      event.buildId === buildId && event.sequence > afterSequence
      && this.pipelineStageRuns.some((run) => run.id === event.stageRunId
        && run.workspaceId === workspaceId && run.projectId === projectId)
    ).slice(0, limit);
  }

  async saveKnowledgeGraph(input: SaveKnowledgeGraphInput): Promise<void> {
    validateKnowledgeGraph(input.graph);
    const build = this.builds.find((candidate) => candidate.id === input.buildId
      && candidate.workspaceId === input.workspaceId && candidate.snapshotId === input.snapshotId);
    const repository = build && this.repositories.find((candidate) => candidate.id === build.repositoryId
      && candidate.workspaceId === input.workspaceId && candidate.projectId === input.projectId);
    if (!build || !repository) throw new Error("Graph does not belong to the supplied project build");
    if (this.knowledgeGraphs.has(input.buildId)) throw new Error("Knowledge graph is immutable for this build");
    this.knowledgeGraphs.set(input.buildId, structuredClone(input.graph));
    await this.recordAudit({
      workspaceId: input.workspaceId, actorId: input.actorId, action: "knowledge_graph.created",
      resourceType: "knowledge_graph", resourceId: input.buildId,
      metadata: { nodeCount: input.graph.nodes.length, edgeCount: input.graph.edges.length }
    });
  }

  async getKnowledgeGraph(workspaceId: string, projectId: string, buildId: string): Promise<KnowledgeGraphRecord | null> {
    const build = this.builds.find((candidate) => candidate.id === buildId && candidate.workspaceId === workspaceId);
    const repository = build && this.repositories.find((candidate) => candidate.id === build.repositoryId
      && candidate.workspaceId === workspaceId && candidate.projectId === projectId);
    const graph = repository ? this.knowledgeGraphs.get(buildId) : undefined;
    return graph ? structuredClone(graph) : null;
  }

  private recordPipelineStageEvent(run: PipelineStageRunRecord): void {
    this.pipelineStageEvents.push({
      sequence: this.nextPipelineStageEventSequence++,
      buildId: run.buildId,
      stageRunId: run.id,
      stage: run.stage,
      status: run.status,
      occurredAt: new Date().toISOString()
    });
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
    version: string,
    provenance?: FrontendReleaseDraftProvenance
  ): Promise<ReleaseRecord> {
    const build = await this.getBuild(workspaceId, buildId);
    if (!build || build.repositoryId !== repositoryId || build.status !== "ready") {
      throw new Error("Only a ready build can create a release draft");
    }
    if (this.releases.some((release) =>
      release.repositoryId === repositoryId && release.version === version
    )) throw new Error("Release version already exists");
    if (provenance) {
      const repository = await this.getRepository(workspaceId, repositoryId);
      if (new Set(provenance.artifactIds).size !== provenance.artifactIds.length
        || provenance.artifactIds.some((id) => !this.knowledgeArtifacts.some((artifact) =>
          artifact.id === id
          && artifact.workspaceId === workspaceId
          && artifact.projectId === repository?.projectId
          && artifact.snapshotId === build.snapshotId
        ))) {
        throw new Error("Frontend v2 release must retain every packaged artifact");
      }
      const run = this.pipelineStageRuns.find((candidate) =>
        candidate.id === provenance.packageStageRunId
        && candidate.workspaceId === workspaceId
        && candidate.projectId === repository?.projectId
        && candidate.buildId === buildId
        && candidate.snapshotId === build.snapshotId
        && candidate.stage === "package"
        && (candidate.status === "succeeded" || candidate.status === "reused")
        && candidate.outputManifestIds.includes(provenance.packageArtifactId)
      );
      const artifact = await this.findArtifactById(provenance.packageArtifactId);
      if (!run || !artifact || artifact.workspaceId !== workspaceId
        || artifact.projectId !== repository?.projectId || artifact.snapshotId !== build.snapshotId
        || artifact.stage !== "package" || artifact.kind !== "frontend-pipeline-package"
        || artifact.schemaVersion !== 2) {
        throw new Error("Frontend v2 release must reference its terminal package stage output");
      }
    }
    const release: ReleaseRecord = {
      id: randomUUID(),
      workspaceId,
      repositoryId,
      buildId,
      snapshotId: build.snapshotId,
      version,
      kernelMode: provenance ? "pipeline" : "legacy",
      packageArtifactId: provenance?.packageArtifactId ?? null,
      releaseArtifactFamily: provenance?.releaseArtifactFamily ?? "knowledge-v1",
      packageStageRunId: provenance?.packageStageRunId ?? null,
      frontendIrSchemaVersion: provenance?.frontendIrSchemaVersion ?? null,
      frontendGraphSchemaVersion: provenance?.frontendGraphSchemaVersion ?? null,
      analyzerManifestDigest: provenance?.analyzerManifestDigest ?? null,
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

  async rollbackReleaseToLegacy(workspaceId: string, releaseId: string, actorId: string) {
    const release = this.releases.find((candidate) =>
      candidate.workspaceId === workspaceId && candidate.id === releaseId
    );
    const repository = release && this.repositories.find((candidate) =>
      candidate.workspaceId === workspaceId && candidate.id === release.repositoryId
    );
    if (!release || !repository || release.publishedAt === null || release.kernelMode !== "legacy") {
      throw new InvalidLegacyReleaseRollbackError();
    }
    const channelKey = `${workspaceId}:${release.repositoryId}:current`;
    const previousReleaseId = this.releaseChannels.get(channelKey) ?? null;
    if (previousReleaseId === release.id) return { release, previousReleaseId };
    this.releaseChannels.set(channelKey, release.id);
    try {
      await this.recordAudit({
        workspaceId,
        actorId,
        action: "release.rolled_back",
        resourceType: "release",
        resourceId: release.id,
        metadata: { projectId: repository.projectId, previousReleaseId }
      });
      return { release, previousReleaseId };
    } catch (error) {
      if (previousReleaseId === null) this.releaseChannels.delete(channelKey);
      else this.releaseChannels.set(channelKey, previousReleaseId);
      throw error;
    }
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

  async listKnowledgePagesForBuild(workspaceId: string, buildId: string): Promise<KnowledgePageRecord[]> {
    return this.knowledgePages.filter((page) => page.workspaceId === workspaceId && page.buildId === buildId)
      .sort((left, right) => left.slug.localeCompare(right.slug) || left.id.localeCompare(right.id))
      .map(boundedKnowledgePage);
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

  async countKnowledgePagesForBuild(workspaceId: string, buildId: string): Promise<number> {
    return this.knowledgePages.filter((page) => page.workspaceId === workspaceId && page.buildId === buildId).length;
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
        matchReason: knowledgeMatchReason(kind, title, query),
        score,
        excerpt: foundPage.body.slice(0, 240),
        pageId: foundPage.id,
        releaseId: release.id,
        citations,
        trust: calculateSearchResultTrust(foundPage.id, citations)
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
      if (matchesKnowledgeTextQuery(`${candidate.title}\n${candidate.body}`, query)) {
        add("page", candidate.title, 20, candidate.chunks.flatMap((chunk) => chunk.citations), candidate);
      }
    }
    const unique = new Map<string, KnowledgeSearchResult>();
    for (const result of results) {
      const key = `${result.kind}:${result.title}:${result.pageId}`;
      const existing = unique.get(key);
      if (!existing || existing.score < result.score) unique.set(key, result);
    }
    const sorted = [...unique.values()].filter((result) => result.trust.score >= MIN_SEARCH_RESULT_TRUST).sort((left, right) =>
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
        targetPath: edge.targetPath ?? null,
        startLine: edge.citation.startLine, endLine: edge.citation.endLine
      }))
    };
  }

  async knowledgeMetadataForBuild(workspaceId: string, buildId: string): Promise<KnowledgeMetadata> {
    const index = this.indexes.get(buildId);
    if (!index || !(await this.getBuild(workspaceId, buildId))) return { symbols: [], dependencies: [] };
    return {
      symbols: index.symbols.map((symbol) => ({
        name: symbol.name, kind: symbol.kind, path: symbol.path,
        startLine: symbol.startLine, endLine: symbol.endLine, exported: symbol.exported
      })),
      dependencies: index.edges.map((edge) => ({
        source: edge.source, target: edge.target, kind: edge.kind, path: edge.citation.path,
        targetPath: edge.targetPath ?? null,
        startLine: edge.citation.startLine, endLine: edge.citation.endLine
      }))
    };
  }
}
