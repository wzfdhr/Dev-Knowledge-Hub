import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  boundedKnowledgePage,
  FeedbackNotAcknowledgedError,
  InvalidFeedbackTransitionError,
  LastProjectAdminError,
  LastWorkspaceAdminError,
  knowledgeMatchReason,
  normalizePagination
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
  CreateFeedbackInput,
  CreateRemediationInput,
  CreateSnapshotInput,
  FeedbackRebuildInput,
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
  PipelineArtifactStore,
  PipelineSearchDocumentInput,
  PipelineSearchDocumentRecord,
  PipelineStageRunRecord,
  CreateStageRunInput,
  CompleteStageRunInput,
  CompleteStageRunResult,
  FailStageRunAndCreateRetryInput,
  FailStageRunAndCreateRetryResult,
  SaveKnowledgeGraphInput,
  ReleaseRecord,
  RepositoryConnectionInput,
  RepositoryRecord,
  ProjectRecord,
  ProjectAccess,
  ProjectMemberRecord,
  ProjectRole,
  RemediationBuildInput,
  RemediationEventRecord,
  RemediationRecord,
  RemediationListOptions,
  WorkspaceKnowledgeSearchRecord,
  WorkspaceProjectOverviewRecord,
  SetupResult,
  SourceFileRecord,
  SourceSnapshotRecord,
  TeamMemberRecord,
  TeamRole,
  WorkspaceRecord
} from "./store.js";
import type {
  BuildInput,
  BuildEvent,
  BuildRecord,
  BuildStatus,
  InitialPipelineStage,
  PersistedKnowledge
} from "../knowledge/build-service.js";
import { standardBuildPurpose } from "../knowledge/build-service.js";
import { transitionRemediation } from "../knowledge/remediation.js";
import type { RemediationState } from "../knowledge/remediation.js";
import type { Citation } from "../knowledge/intelligence.js";
import {
  artifactManifestSchema,
  canTransitionStage,
  graphEdgeSchema,
  graphNodeSchema,
  stageRunSchema,
  type ArtifactManifest,
  type BuildStage,
  type StageStatus
} from "../knowledge/pipeline/contracts.js";
import type { PipelineStageEvent } from "../knowledge/pipeline/events.js";
import { validateKnowledgeGraph } from "../knowledge/pipeline/graph.js";

interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

interface RepositoryRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  project_id: string;
  kind: "local" | "git" | "upload";
  name: string;
  local_path: string | null;
  clone_url: string | null;
  default_branch: string;
  archived_at: Date | null;
  has_credential: boolean;
}

interface SnapshotRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  repository_id: string;
  commit_sha: string;
  ref: string;
  remote_url: string | null;
  commit_timestamp: Date;
  storage_path: string;
}

interface BuildRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  repository_id: string;
  snapshot_id: string;
  snapshot_path: string;
  commit_sha: string;
  status: BuildStatus;
  warnings: BuildRecord["warnings"];
  cancel_requested: boolean;
  error_message: string | null;
  purpose: "standard" | "feedback" | "remediation";
  feedback_ids: string[];
  feedback_context: BuildRecord["purpose"]["feedbackContext"];
  remediation_context: Extract<BuildRecord["purpose"], { kind: "remediation" }>["remediationContext"];
  allow_llm?: boolean;
}

interface RemediationRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  project_id: string;
  repository_id: string;
  source_build_id: string;
  issue: RemediationRecord["issue"];
  state: RemediationState;
  rebuild_build_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface RemediationEventRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  remediation_id: string;
  from_state: RemediationState;
  to_state: RemediationState;
  actor_id: string | null;
  created_at: Date;
}

interface StageRunRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  project_id: string;
  snapshot_id: string;
  build_job_id: string;
  stage: BuildStage;
  attempt: number;
  status: StageStatus;
  input_digest: string;
  output_manifest_ids: string[];
  started_at: Date | null;
  finished_at: Date | null;
  error_code: string | null;
  error_detail: string | null;
}

interface StageEventRow extends QueryResultRow {
  sequence: string;
  build_job_id: string;
  stage_run_id: string;
  stage: BuildStage;
  status: StageStatus;
  created_at: Date;
}

interface ArtifactRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  project_id: string;
  snapshot_id: string;
  build_job_id: string;
  stage: BuildStage;
  kind: string;
  schema_version: number;
  input_digest: string;
  content_digest: string;
  storage_key: string;
  source_refs: ArtifactManifest["sourceRefs"];
  producer: ArtifactManifest["producer"];
  created_at: Date;
}

interface PipelineSearchDocumentRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  project_id: string;
  snapshot_id: string;
  build_job_id: string;
  source_artifact_id: string;
  document_key: string;
  kind: PipelineSearchDocumentRecord["kind"];
  title: string;
  content: string;
  citations: PipelineSearchDocumentRecord["citations"];
  metadata: PipelineSearchDocumentRecord["metadata"];
  created_at: Date;
}

interface GraphNodeRow extends QueryResultRow {
  node_id: string;
  workspace_id: string;
  project_id: string;
  snapshot_id: string;
  kind: "module" | "symbol" | "document" | "table" | "column" | "command";
  name: string;
  qualified_name: string;
  candidate: boolean;
  source_refs: unknown[];
  attributes: Record<string, string | number | boolean>;
}

interface GraphEdgeRow extends QueryResultRow {
  edge_id: string;
  from_node_id: string;
  to_node_id: string;
  kind: "imports" | "exports" | "calls" | "contains" | "documents" | "reads" | "writes" | "depends_on";
  candidate: boolean;
  candidate_reason: string | null;
  confidence: number;
  source_refs: unknown[];
}

interface KnowledgePageRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  repository_id: string;
  build_job_id: string;
  slug: string;
  title: string;
  body: string;
  chunks: KnowledgePageRecord["chunks"];
}

interface ReleaseRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  repository_id: string;
  build_job_id: string;
  snapshot_id: string;
  version: string;
  kernel_mode?: "legacy" | "pipeline";
  package_artifact_id?: string | null;
  created_at: Date;
  published_at: Date | null;
  status?: BuildStatus;
}

interface McpTokenRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  scopes: string[];
  expires_at: Date;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

interface FeedbackRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  release_id: string | null;
  query: string;
  reason: string;
  expected: string | null;
  citations: Citation[];
  status: AgentFeedbackStatus;
  rebuild_build_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ImportReportRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  project_id: string;
  repository_id: string | null;
  actor_id: string | null;
  source_kind: ImportReportRecord["sourceKind"];
  status: ImportReportRecord["status"];
  started_at: Date;
  finished_at: Date | null;
  collected_file_count: number;
  collected_text_bytes: string;
  ignored: ImportReportRecord["ignored"];
  snapshot_id: string | null;
  failure_code: string | null;
}

interface ProjectRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  archived_at: Date | null;
  created_at: Date;
}

interface TeamMemberRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  email: string;
  password_hash: string;
  role: TeamRole;
  created_at: Date;
  disabled_at: Date | null;
  session_version: number;
}

interface ProjectMemberRow extends QueryResultRow {
  id: string;
  project_id: string;
  workspace_id: string;
  email: string;
  role: ProjectRole;
  created_at: Date;
}

interface ProjectMemberLockRow extends ProjectMemberRow {
  workspace_role: TeamRole;
}

interface ProjectAccessRow extends ProjectRow {
  role: ProjectRole | null;
}

interface AuditEventRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

interface AdminMfaRow extends QueryResultRow {
  user_id: string;
  workspace_id: string;
  encrypted_secret: string;
  enabled_at: Date | null;
  failed_attempts: number;
  locked_until: Date | null;
}

function adminMfaRecord(row: AdminMfaRow): AdminMfaRecord {
  return {
    userId: row.user_id,
    workspaceId: row.workspace_id,
    encryptedSecret: row.encrypted_secret,
    enabledAt: row.enabled_at,
    failedAttempts: row.failed_attempts,
    lockedUntil: row.locked_until
  };
}

function repositoryRecord(row: RepositoryRow): RepositoryRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    kind: row.kind,
    name: row.name,
    localPath: row.local_path,
    cloneUrl: row.clone_url,
    defaultBranch: row.default_branch,
    archivedAt: row.archived_at,
    hasCredential: row.has_credential
  };
}

function snapshotRecord(row: SnapshotRow): SourceSnapshotRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    repositoryId: row.repository_id,
    commitSha: row.commit_sha,
    ref: row.ref,
    remoteUrl: row.remote_url,
    commitTimestamp: row.commit_timestamp,
    storagePath: row.storage_path
  };
}

function buildRecord(row: BuildRow): BuildRecord {
  const purpose = row.purpose === "feedback"
    ? {
        kind: "feedback" as const,
        feedbackIds: row.feedback_ids ?? [],
        feedbackContext: row.feedback_context ?? []
      }
    : row.purpose === "remediation"
      ? {
          kind: "remediation" as const,
          feedbackIds: [] as [],
          feedbackContext: [] as [],
          remediationContext: row.remediation_context ?? []
        }
    : standardBuildPurpose();
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    repositoryId: row.repository_id,
    snapshotId: row.snapshot_id,
    snapshotPath: row.snapshot_path,
    commitSha: row.commit_sha,
    status: row.status,
    warnings: row.warnings ?? [],
    cancelRequested: row.cancel_requested,
    purpose,
    allowLlm: row.allow_llm ?? false,
    ...(row.error_message ? { errorMessage: row.error_message } : {})
  };
}

function remediationRecord(row: RemediationRow): RemediationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    repositoryId: row.repository_id,
    sourceBuildId: row.source_build_id,
    issue: row.issue,
    state: row.state,
    rebuildBuildId: row.rebuild_build_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function remediationEventRecord(row: RemediationEventRow): RemediationEventRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    remediationId: row.remediation_id,
    fromState: row.from_state,
    toState: row.to_state,
    actorId: row.actor_id,
    createdAt: row.created_at
  };
}

function stageRunRecord(row: StageRunRow): PipelineStageRunRecord {
  const run = stageRunSchema.parse({
    id: row.id,
    buildId: row.build_job_id,
    stage: row.stage,
    attempt: row.attempt,
    status: row.status,
    inputDigest: row.input_digest,
    outputManifestIds: row.output_manifest_ids ?? [],
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    errorCode: row.error_code,
    errorDetail: row.error_detail
  });
  return {
    ...run,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    snapshotId: row.snapshot_id
  };
}

function pipelineStageEvent(row: StageEventRow): PipelineStageEvent {
  return {
    sequence: Number(row.sequence),
    buildId: row.build_job_id,
    stageRunId: row.stage_run_id,
    stage: row.stage,
    status: row.status,
    occurredAt: row.created_at.toISOString()
  };
}

function artifactManifest(row: ArtifactRow): ArtifactManifest {
  return artifactManifestSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    snapshotId: row.snapshot_id,
    buildId: row.build_job_id,
    stage: row.stage,
    kind: row.kind,
    schemaVersion: row.schema_version,
    inputDigest: row.input_digest,
    contentDigest: row.content_digest,
    storageKey: row.storage_key,
    sourceRefs: row.source_refs,
    producer: row.producer,
    createdAt: row.created_at.toISOString()
  });
}

function pipelineSearchDocument(row: PipelineSearchDocumentRow): PipelineSearchDocumentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    snapshotId: row.snapshot_id,
    buildId: row.build_job_id,
    sourceArtifactId: row.source_artifact_id,
    documentKey: row.document_key,
    kind: row.kind,
    title: row.title,
    content: row.content,
    citations: row.citations,
    metadata: row.metadata,
    createdAt: row.created_at
  };
}

function knowledgePageRecord(row: KnowledgePageRow): KnowledgePageRecord {
  return boundedKnowledgePage({
    id: row.id,
    workspaceId: row.workspace_id,
    repositoryId: row.repository_id,
    buildId: row.build_job_id,
    slug: row.slug,
    title: row.title,
    body: row.body,
    chunks: row.chunks ?? []
  });
}

function releaseRecord(row: ReleaseRow): ReleaseRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    repositoryId: row.repository_id,
    buildId: row.build_job_id,
    snapshotId: row.snapshot_id,
    version: row.version,
    kernelMode: row.kernel_mode ?? "legacy",
    packageArtifactId: row.package_artifact_id ?? null,
    createdAt: row.created_at,
    publishedAt: row.published_at
  };
}

function mcpTokenRecord(row: McpTokenRow): McpTokenRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    name: row.name,
    tokenHash: row.token_hash,
    tokenPrefix: row.token_prefix,
    scopes: (row.scopes ?? ["search", "source.read"]) as McpTokenRecord["scopes"],
    expiresAt: row.expires_at ?? new Date(row.created_at.getTime() + 90 * 24 * 60 * 60 * 1_000),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at
  };
}

function feedbackRecord(row: FeedbackRow): AgentFeedbackRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    releaseId: row.release_id,
    query: row.query,
    reason: row.reason,
    expected: row.expected,
    citations: row.citations ?? [],
    status: row.status,
    rebuildBuildId: row.rebuild_build_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function importReportRecord(row: ImportReportRow): ImportReportRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    repositoryId: row.repository_id,
    actorId: row.actor_id,
    sourceKind: row.source_kind,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    collectedFileCount: row.collected_file_count,
    collectedTextBytes: Number(row.collected_text_bytes),
    ignored: row.ignored ?? { total: 0, reasons: {} },
    snapshotId: row.snapshot_id,
    failureCode: row.failure_code
  };
}

function projectRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    slug: row.slug,
    archivedAt: row.archived_at,
    createdAt: row.created_at
  };
}

function teamMemberRecord(row: TeamMemberRow): TeamMemberRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
    sessionVersion: row.session_version
  };
}

function projectMemberRecord(row: ProjectMemberRow): ProjectMemberRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    email: row.email,
    role: row.role,
    createdAt: row.created_at
  };
}

function auditEventRecord(row: AuditEventRow): AuditEventRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ...(row.actor_id ? { actorId: row.actor_id } : {}),
    action: row.action,
    resourceType: row.resource_type,
    ...(row.resource_id ? { resourceId: row.resource_id } : {}),
    metadata: row.metadata ?? {},
    createdAt: row.created_at
  };
}

export class PostgresAppStore implements AppStore, PipelineArtifactStore {
  constructor(private readonly pool: Pool & Queryable) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertAudit(queryable: Queryable, event: AuditEventInput): Promise<void> {
    await queryable.query(
      `INSERT INTO audit_events
       (workspace_id, actor_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        event.workspaceId,
        event.actorId ?? null,
        event.action,
        event.resourceType,
        event.resourceId ?? null,
        JSON.stringify(event.metadata ?? {})
      ]
    );
  }

  async createStageRun(input: CreateStageRunInput): Promise<PipelineStageRunRecord> {
    const queued = stageRunSchema.parse({
      id: "pending",
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
    });
    const { rows } = await this.pool.query<StageRunRow>(
      `WITH run AS (
       INSERT INTO build_stage_runs
       (workspace_id, project_id, snapshot_id, build_job_id, stage, attempt, status, input_digest)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8
       FROM build_jobs build
       JOIN repositories repository
         ON repository.id = build.repository_id AND repository.workspace_id = build.workspace_id
       JOIN source_snapshots snapshot
         ON snapshot.id = build.snapshot_id AND snapshot.workspace_id = build.workspace_id
       WHERE build.workspace_id = $1 AND build.id = $4
         AND repository.project_id = $2 AND snapshot.id = $3 AND snapshot.repository_id = build.repository_id
       ON CONFLICT (build_job_id, stage, attempt) DO UPDATE
       SET updated_at = build_stage_runs.updated_at
       RETURNING id, workspace_id, project_id, snapshot_id, build_job_id, stage, attempt, status,
                 input_digest, output_manifest_ids, started_at, finished_at, error_code, error_detail
       ), event AS (
         INSERT INTO build_stage_events
           (workspace_id, project_id, build_job_id, stage_run_id, stage, status)
         SELECT workspace_id, project_id, build_job_id, id, stage, status FROM run
         ON CONFLICT (stage_run_id, status) DO NOTHING
       )
       SELECT * FROM run`,
      [input.workspaceId, input.projectId, input.snapshotId, input.buildId, queued.stage, queued.attempt, queued.status, queued.inputDigest]
    );
    if (!rows[0]) throw new Error("Stage run does not match the project build and snapshot");
    return stageRunRecord(rows[0]);
  }

  async claimNextStageRun(
    workspaceId: string,
    projectId: string,
    scope: { buildId?: string; stage?: BuildStage } = {}
  ): Promise<PipelineStageRunRecord | null> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<StageRunRow>(
        `WITH candidate AS (
           SELECT id FROM build_stage_runs
           WHERE workspace_id = $1 AND project_id = $2 AND status = 'queued' AND available_at <= now()
             AND ($3::uuid IS NULL OR build_job_id = $3)
             AND ($4::text IS NULL OR stage = $4)
           ORDER BY created_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         ), updated AS (
         UPDATE build_stage_runs AS run
         SET status = 'running', started_at = now(), updated_at = now()
         FROM candidate
         WHERE run.id = candidate.id AND run.workspace_id = $1 AND run.project_id = $2
         RETURNING run.id, run.workspace_id, run.project_id, run.snapshot_id, run.build_job_id,
                   run.stage, run.attempt, run.status, run.input_digest, run.output_manifest_ids,
                   run.started_at, run.finished_at, run.error_code, run.error_detail
         ), event AS (
           INSERT INTO build_stage_events
             (workspace_id, project_id, build_job_id, stage_run_id, stage, status)
           SELECT workspace_id, project_id, build_job_id, id, stage, status FROM updated
           ON CONFLICT (stage_run_id, status) DO NOTHING
         )
         SELECT * FROM updated`,
        [workspaceId, projectId, scope.buildId ?? null, scope.stage ?? null]
      );
      return rows[0] ? stageRunRecord(rows[0]) : null;
    });
  }

  async claimStageRun(
    stageRunId: string,
    buildId: string,
    projectId: string
  ): Promise<PipelineStageRunRecord | null> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<StageRunRow>(
        `WITH updated AS (
           UPDATE build_stage_runs
           SET status = 'running', started_at = now(), updated_at = now()
           WHERE id = $1 AND build_job_id = $2 AND project_id = $3 AND status = 'queued' AND available_at <= now()
           RETURNING id, workspace_id, project_id, snapshot_id, build_job_id, stage, attempt, status,
                     input_digest, output_manifest_ids, started_at, finished_at, error_code, error_detail
         ), event AS (
           INSERT INTO build_stage_events
             (workspace_id, project_id, build_job_id, stage_run_id, stage, status)
           SELECT workspace_id, project_id, build_job_id, id, stage, status FROM updated
           ON CONFLICT (stage_run_id, status) DO NOTHING
         )
         SELECT * FROM updated`,
        [stageRunId, buildId, projectId]
      );
      return rows[0] ? stageRunRecord(rows[0]) : null;
    });
  }

  async listQueuedStageRuns(): Promise<PipelineStageRunRecord[]> {
    const { rows } = await this.pool.query<StageRunRow>(
      `SELECT id, workspace_id, project_id, snapshot_id, build_job_id, stage, attempt, status,
              input_digest, output_manifest_ids, started_at, finished_at, error_code, error_detail
       FROM build_stage_runs WHERE status = 'queued' AND available_at <= now() ORDER BY available_at, created_at, id`
    );
    return rows.map(stageRunRecord);
  }

  async listStaleRunningStageRuns(staleBefore: Date): Promise<PipelineStageRunRecord[]> {
    const { rows } = await this.pool.query<StageRunRow>(
      `SELECT id, workspace_id, project_id, snapshot_id, build_job_id, stage, attempt, status,
              input_digest, output_manifest_ids, started_at, finished_at, error_code, error_detail
       FROM build_stage_runs
       WHERE status = 'running' AND started_at < $1
       ORDER BY started_at, id`,
      [staleBefore]
    );
    return rows.map(stageRunRecord);
  }

  async transitionStageRun(
    workspaceId: string,
    projectId: string,
    stageRunId: string,
    expectedStatus: StageStatus,
    status: StageStatus,
    details: { outputManifestIds?: string[]; errorCode?: string; errorDetail?: string } = {}
  ): Promise<PipelineStageRunRecord | null> {
    if (!canTransitionStage(expectedStatus, status)) {
      throw new Error(`Illegal stage transition: ${expectedStatus} -> ${status}`);
    }
    if (status === "failed" && !details.errorCode) throw new Error("Failed stage runs require errorCode");
    if (status !== "failed" && (details.errorCode || details.errorDetail)) throw new Error("Only failed stage runs include errors");
    const terminal = ["succeeded", "failed", "cancelled", "reused", "skipped"].includes(status);
    const { rows } = await this.pool.query<StageRunRow>(
      `WITH updated AS (
       UPDATE build_stage_runs
       SET status = $5,
           output_manifest_ids = COALESCE($6::uuid[], output_manifest_ids),
           started_at = COALESCE(started_at, now()),
           finished_at = CASE WHEN $7::boolean THEN now() ELSE NULL END,
           error_code = $8,
           error_detail = $9,
           updated_at = now()
       WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND status = $4
       RETURNING id, workspace_id, project_id, snapshot_id, build_job_id, stage, attempt, status,
                 input_digest, output_manifest_ids, started_at, finished_at, error_code, error_detail
       ), event AS (
         INSERT INTO build_stage_events
           (workspace_id, project_id, build_job_id, stage_run_id, stage, status)
         SELECT workspace_id, project_id, build_job_id, id, stage, status FROM updated
         ON CONFLICT (stage_run_id, status) DO NOTHING
       )
       SELECT * FROM updated`,
      [
        workspaceId, projectId, stageRunId, expectedStatus, status,
        details.outputManifestIds ?? null, terminal,
        status === "failed" ? details.errorCode ?? null : null,
        status === "failed" ? details.errorDetail ?? null : null
      ]
    );
    return rows[0] ? stageRunRecord(rows[0]) : null;
  }

  async failStageRunAndCreateRetry(
    input: FailStageRunAndCreateRetryInput
  ): Promise<FailStageRunAndCreateRetryResult> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<StageRunRow>(
        `UPDATE build_stage_runs
         SET status = 'failed', started_at = COALESCE(started_at, now()), finished_at = now(),
             error_code = $4, error_detail = $5, updated_at = now()
         WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND status = 'running'
         RETURNING id, workspace_id, project_id, snapshot_id, build_job_id, stage, attempt, status,
                   input_digest, output_manifest_ids, started_at, finished_at, error_code, error_detail`,
        [input.workspaceId, input.projectId, input.stageRunId, input.errorCode, input.errorDetail]
      );
      const failedRow = rows[0];
      if (!failedRow) return { failed: null, retry: null };
      const failed = stageRunRecord(failedRow);
      await client.query(
        `INSERT INTO build_stage_events
         (workspace_id, project_id, build_job_id, stage_run_id, stage, status)
         VALUES ($1, $2, $3, $4, $5, 'failed')
         ON CONFLICT (stage_run_id, status) DO NOTHING`,
        [failed.workspaceId, failed.projectId, failed.buildId, failed.id, failed.stage]
      );
      if (!input.retry) return { failed, retry: null };
      const { rows: retryRows } = await client.query<StageRunRow>(
        `INSERT INTO build_stage_runs
         (workspace_id, project_id, snapshot_id, build_job_id, stage, attempt, status, input_digest, available_at)
         SELECT $1, $2, $3, $4, $5, $6, 'queued', $7, $8
         FROM build_jobs build
         JOIN repositories repository ON repository.id = build.repository_id AND repository.workspace_id = build.workspace_id
         JOIN source_snapshots snapshot ON snapshot.id = build.snapshot_id AND snapshot.workspace_id = build.workspace_id
         WHERE build.workspace_id = $1 AND build.id = $4 AND repository.project_id = $2
           AND snapshot.id = $3 AND snapshot.repository_id = build.repository_id
         ON CONFLICT (build_job_id, stage, attempt) DO UPDATE
           SET updated_at = build_stage_runs.updated_at
         RETURNING id, workspace_id, project_id, snapshot_id, build_job_id, stage, attempt, status,
                   input_digest, output_manifest_ids, started_at, finished_at, error_code, error_detail`,
        [
          failed.workspaceId, failed.projectId, failed.snapshotId, failed.buildId,
          failed.stage, failed.attempt + 1, input.retry.inputDigest, input.retry.availableAt
        ]
      );
      if (!retryRows[0]) throw new Error("Retry stage run does not match the project build and snapshot");
      const retry = stageRunRecord(retryRows[0]);
      await client.query(
        `INSERT INTO build_stage_events
         (workspace_id, project_id, build_job_id, stage_run_id, stage, status)
         VALUES ($1, $2, $3, $4, $5, 'queued')
         ON CONFLICT (stage_run_id, status) DO NOTHING`,
        [retry.workspaceId, retry.projectId, retry.buildId, retry.id, retry.stage]
      );
      return { failed, retry };
    });
  }

  async completeStageRunAndCreateNext(
    input: CompleteStageRunInput
  ): Promise<CompleteStageRunResult | null> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<StageRunRow>(
        `UPDATE build_stage_runs
         SET status = $5,
             output_manifest_ids = COALESCE($6::uuid[], output_manifest_ids),
             finished_at = now(), updated_at = now()
         WHERE workspace_id = $1 AND project_id = $2 AND id = $3 AND status = $4
           AND NOT EXISTS (
             SELECT 1 FROM build_jobs build
             WHERE build.id = build_stage_runs.build_job_id
               AND build.workspace_id = build_stage_runs.workspace_id
               AND build.cancel_requested
           )
         RETURNING id, workspace_id, project_id, snapshot_id, build_job_id, stage, attempt, status,
                   input_digest, output_manifest_ids, started_at, finished_at, error_code, error_detail`,
        [input.workspaceId, input.projectId, input.stageRunId, "running", input.status, input.outputManifestIds ?? null]
      );
      const completedRow = rows[0];
      if (!completedRow) return null;
      const completed = stageRunRecord(completedRow);
      await client.query(
        `INSERT INTO build_stage_events
         (workspace_id, project_id, build_job_id, stage_run_id, stage, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (stage_run_id, status) DO NOTHING`,
        [completed.workspaceId, completed.projectId, completed.buildId, completed.id, completed.stage, completed.status]
      );
      if (!input.next) return { completed, next: null };
      const { rows: nextRows } = await client.query<StageRunRow>(
        `INSERT INTO build_stage_runs
         (workspace_id, project_id, snapshot_id, build_job_id, stage, attempt, status, input_digest)
         SELECT $1, $2, $3, $4, $5, $6, 'queued', $7
         FROM build_jobs build
         JOIN repositories repository ON repository.id = build.repository_id AND repository.workspace_id = build.workspace_id
         JOIN source_snapshots snapshot ON snapshot.id = build.snapshot_id AND snapshot.workspace_id = build.workspace_id
         WHERE build.workspace_id = $1 AND build.id = $4 AND repository.project_id = $2
           AND snapshot.id = $3 AND snapshot.repository_id = build.repository_id
         ON CONFLICT (build_job_id, stage, attempt) DO UPDATE
           SET updated_at = build_stage_runs.updated_at
         RETURNING id, workspace_id, project_id, snapshot_id, build_job_id, stage, attempt, status,
                   input_digest, output_manifest_ids, started_at, finished_at, error_code, error_detail`,
        [
          input.next.workspaceId, input.next.projectId, input.next.snapshotId, input.next.buildId,
          input.next.stage, input.next.attempt, input.next.inputDigest
        ]
      );
      if (!nextRows[0]) throw new Error("Next stage run does not match the project build and snapshot");
      const next = stageRunRecord(nextRows[0]);
      await client.query(
        `INSERT INTO build_stage_events
         (workspace_id, project_id, build_job_id, stage_run_id, stage, status)
         VALUES ($1, $2, $3, $4, $5, 'queued')
         ON CONFLICT (stage_run_id, status) DO NOTHING`,
        [next.workspaceId, next.projectId, next.buildId, next.id, next.stage]
      );
      return { completed, next };
    });
  }

  async listPipelineStageRuns(
    workspaceId: string,
    projectId: string,
    buildId: string
  ): Promise<PipelineStageRunRecord[]> {
    const { rows } = await this.pool.query<StageRunRow>(
      `SELECT id, workspace_id, project_id, snapshot_id, build_job_id, stage, attempt, status,
              input_digest, output_manifest_ids, started_at, finished_at, error_code, error_detail
       FROM build_stage_runs
       WHERE workspace_id = $1 AND project_id = $2 AND build_job_id = $3
       ORDER BY created_at, id`,
      [workspaceId, projectId, buildId]
    );
    return rows.map(stageRunRecord);
  }

  async cancelPipelineStageRuns(
    workspaceId: string,
    projectId: string,
    buildId: string
  ): Promise<PipelineStageRunRecord[]> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<StageRunRow>(
        `UPDATE build_stage_runs
         SET status = 'cancelled',
             started_at = COALESCE(started_at, now()),
             finished_at = now(),
             error_code = NULL,
             error_detail = NULL,
             updated_at = now()
         WHERE workspace_id = $1 AND project_id = $2 AND build_job_id = $3
           AND status IN ('queued', 'running')
         RETURNING id, workspace_id, project_id, snapshot_id, build_job_id, stage, attempt, status,
                   input_digest, output_manifest_ids, started_at, finished_at, error_code, error_detail`,
        [workspaceId, projectId, buildId]
      );
      for (const row of rows) {
        await client.query(
          `INSERT INTO build_stage_events
             (workspace_id, project_id, build_job_id, stage_run_id, stage, status)
           VALUES ($1, $2, $3, $4, $5, 'cancelled')
           ON CONFLICT (stage_run_id, status) DO NOTHING`,
          [row.workspace_id, row.project_id, row.build_job_id, row.id, row.stage]
        );
      }
      return rows.map(stageRunRecord);
    });
  }

  async listPipelineStageEvents(
    workspaceId: string,
    projectId: string,
    buildId: string,
    afterSequence: number,
    limit = 100
  ): Promise<PipelineStageEvent[]> {
    const { rows } = await this.pool.query<StageEventRow>(
      `SELECT sequence, build_job_id, stage_run_id, stage, status, created_at
       FROM build_stage_events
       WHERE workspace_id = $1 AND project_id = $2 AND build_job_id = $3 AND sequence > $4
       ORDER BY sequence LIMIT $5`,
      [workspaceId, projectId, buildId, afterSequence, limit]
    );
    return rows.map(pipelineStageEvent);
  }

  async createArtifactWithAudit(manifestInput: ArtifactManifest, actorId?: string): Promise<ArtifactManifest> {
    const manifest = artifactManifestSchema.parse(manifestInput);
    return this.transaction(async (client) => {
      const inserted = await client.query<ArtifactRow>(
        `INSERT INTO knowledge_artifacts
         (id, workspace_id, project_id, snapshot_id, build_job_id, stage, kind, schema_version,
          input_digest, content_digest, storage_key, source_refs, producer)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13
         FROM build_jobs build
         JOIN repositories repository
           ON repository.id = build.repository_id AND repository.workspace_id = build.workspace_id
         JOIN source_snapshots snapshot
           ON snapshot.id = build.snapshot_id AND snapshot.workspace_id = build.workspace_id
         WHERE build.workspace_id = $2 AND build.id = $5 AND repository.project_id = $3
           AND snapshot.id = $4 AND snapshot.repository_id = build.repository_id
         ON CONFLICT (project_id, snapshot_id, stage, kind, input_digest) DO NOTHING
         RETURNING id, workspace_id, project_id, snapshot_id, build_job_id, stage, kind, schema_version,
                   input_digest, content_digest, storage_key, source_refs, producer, created_at`,
        [
          manifest.id, manifest.workspaceId, manifest.projectId, manifest.snapshotId, manifest.buildId,
          manifest.stage, manifest.kind, manifest.schemaVersion, manifest.inputDigest, manifest.contentDigest,
          manifest.storageKey, JSON.stringify(manifest.sourceRefs), manifest.producer
        ]
      );
      const artifact = inserted.rows[0] ?? (await client.query<ArtifactRow>(
        `SELECT id, workspace_id, project_id, snapshot_id, build_job_id, stage, kind, schema_version,
                input_digest, content_digest, storage_key, source_refs, producer, created_at
         FROM knowledge_artifacts
         WHERE workspace_id = $1 AND project_id = $2 AND snapshot_id = $3
           AND stage = $4 AND kind = $5 AND input_digest = $6`,
        [manifest.workspaceId, manifest.projectId, manifest.snapshotId, manifest.stage, manifest.kind, manifest.inputDigest]
      )).rows[0];
      if (!artifact) throw new Error("Artifact does not match the project build and snapshot");
      const persisted = artifactManifest(artifact);
      if (persisted.contentDigest !== manifest.contentDigest || persisted.storageKey !== manifest.storageKey) {
        throw new Error("Artifact cache collision");
      }
      if (inserted.rows[0]) {
        await this.insertAudit(client, {
          workspaceId: manifest.workspaceId,
          actorId,
          action: "knowledge_artifact.created",
          resourceType: "knowledge_artifact",
          resourceId: persisted.id,
          metadata: { stage: persisted.stage, kind: persisted.kind, contentDigest: persisted.contentDigest }
        });
      }
      return persisted;
    });
  }

  async findReusableArtifact(
    workspaceId: string,
    projectId: string,
    snapshotId: string,
    stage: BuildStage,
    kind: string,
    inputDigest: string
  ): Promise<ArtifactManifest | null> {
    const { rows } = await this.pool.query<ArtifactRow>(
      `SELECT id, workspace_id, project_id, snapshot_id, build_job_id, stage, kind, schema_version,
              input_digest, content_digest, storage_key, source_refs, producer, created_at
       FROM knowledge_artifacts
       WHERE workspace_id = $1 AND project_id = $2 AND snapshot_id = $3
         AND stage = $4 AND kind = $5 AND input_digest = $6`,
      [workspaceId, projectId, snapshotId, stage, kind, inputDigest]
    );
    return rows[0] ? artifactManifest(rows[0]) : null;
  }

  async recordArtifactCacheMiss(manifest: ArtifactManifest, reason: "content_missing"): Promise<void> {
    await this.insertAudit(this.pool, {
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
    const { rows } = await this.pool.query<ArtifactRow>(
      `SELECT id, workspace_id, project_id, snapshot_id, build_job_id, stage, kind, schema_version,
              input_digest, content_digest, storage_key, source_refs, producer, created_at
       FROM knowledge_artifacts
       WHERE id = $1`,
      [artifactId]
    );
    return rows[0] ? artifactManifest(rows[0]) : null;
  }

  async savePipelineSearchDocuments(input: {
    workspaceId: string;
    projectId: string;
    snapshotId: string;
    buildId: string;
    sourceArtifactId: string;
    documents: PipelineSearchDocumentInput[];
  }): Promise<PipelineSearchDocumentRecord[]> {
    return this.transaction(async (client) => {
      const source = await client.query(
        `SELECT 1
         FROM knowledge_artifacts
         WHERE id = $1 AND workspace_id = $2 AND project_id = $3
           AND snapshot_id = $4`,
        [input.sourceArtifactId, input.workspaceId, input.projectId, input.snapshotId]
      );
      if (source.rowCount !== 1) {
        throw new Error("Pipeline search document does not match the source artifact scope");
      }
      for (const document of input.documents) {
        await client.query(
          `INSERT INTO pipeline_search_documents
           (workspace_id, project_id, snapshot_id, build_job_id, source_artifact_id,
            document_key, kind, title, content, citations, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
           ON CONFLICT (build_job_id, source_artifact_id, document_key) DO NOTHING`,
          [
            input.workspaceId, input.projectId, input.snapshotId, input.buildId, input.sourceArtifactId,
            document.documentKey, document.kind, document.title, document.content,
            JSON.stringify(document.citations), JSON.stringify(document.metadata)
          ]
        );
      }
      const { rows } = await client.query<PipelineSearchDocumentRow>(
        `SELECT id, workspace_id, project_id, snapshot_id, build_job_id, source_artifact_id,
                document_key, kind, title, content, citations, metadata, created_at
         FROM pipeline_search_documents
         WHERE workspace_id = $1 AND project_id = $2 AND build_job_id = $3 AND source_artifact_id = $4
         ORDER BY document_key, id`,
        [input.workspaceId, input.projectId, input.buildId, input.sourceArtifactId]
      );
      return rows.map(pipelineSearchDocument);
    });
  }

  async listPipelineSearchDocuments(
    workspaceId: string,
    projectId: string,
    buildId: string
  ): Promise<PipelineSearchDocumentRecord[]> {
    const { rows } = await this.pool.query<PipelineSearchDocumentRow>(
      `SELECT id, workspace_id, project_id, snapshot_id, build_job_id, source_artifact_id,
              document_key, kind, title, content, citations, metadata, created_at
       FROM pipeline_search_documents
       WHERE workspace_id = $1 AND project_id = $2 AND build_job_id = $3
       ORDER BY document_key, id`,
      [workspaceId, projectId, buildId]
    );
    return rows.map(pipelineSearchDocument);
  }

  async saveKnowledgeGraph(input: SaveKnowledgeGraphInput): Promise<void> {
    validateKnowledgeGraph(input.graph);
    await this.transaction(async (client) => {
      const owner = await client.query(
        `SELECT 1
         FROM build_jobs build
         JOIN repositories repository ON repository.id = build.repository_id AND repository.workspace_id = build.workspace_id
         JOIN source_snapshots snapshot ON snapshot.id = build.snapshot_id AND snapshot.workspace_id = build.workspace_id
         WHERE build.workspace_id = $1 AND build.id = $2 AND repository.project_id = $3 AND snapshot.id = $4`,
        [input.workspaceId, input.buildId, input.projectId, input.snapshotId]
      );
      if (owner.rowCount !== 1) throw new Error("Graph does not belong to the supplied project build");
      const existing = await client.query(
        "SELECT 1 FROM knowledge_graph_nodes WHERE workspace_id = $1 AND project_id = $2 AND build_job_id = $3 LIMIT 1",
        [input.workspaceId, input.projectId, input.buildId]
      );
      if (existing.rowCount) throw new Error("Knowledge graph is immutable for this build");
      for (const node of input.graph.nodes) {
        await client.query(
          `INSERT INTO knowledge_graph_nodes
           (workspace_id, project_id, snapshot_id, build_job_id, node_id, kind, name, qualified_name, candidate, source_refs, attributes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)`,
          [input.workspaceId, input.projectId, input.snapshotId, input.buildId, node.id, node.kind, node.name,
            node.qualifiedName, node.candidate, JSON.stringify(node.sourceRefs), JSON.stringify(node.attributes)]
        );
      }
      for (const graphEdge of input.graph.edges) {
        await client.query(
          `INSERT INTO knowledge_graph_edges
           (workspace_id, project_id, snapshot_id, build_job_id, edge_id, from_node_id, to_node_id, kind, candidate, candidate_reason, confidence, source_refs)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
          [input.workspaceId, input.projectId, input.snapshotId, input.buildId, graphEdge.id, graphEdge.fromNodeId,
            graphEdge.toNodeId, graphEdge.kind, graphEdge.candidate, graphEdge.candidateReason ?? null,
            graphEdge.confidence, JSON.stringify(graphEdge.sourceRefs)]
        );
      }
      await this.insertAudit(client, {
        workspaceId: input.workspaceId, actorId: input.actorId, action: "knowledge_graph.created",
        resourceType: "knowledge_graph", resourceId: input.buildId,
        metadata: { nodeCount: input.graph.nodes.length, edgeCount: input.graph.edges.length }
      });
    });
  }

  async getKnowledgeGraph(workspaceId: string, projectId: string, buildId: string): Promise<KnowledgeGraphRecord | null> {
    const nodes = await this.pool.query<GraphNodeRow>(
      `SELECT node_id, workspace_id, project_id, snapshot_id, kind, name, qualified_name, candidate, source_refs, attributes
       FROM knowledge_graph_nodes WHERE workspace_id = $1 AND project_id = $2 AND build_job_id = $3 ORDER BY node_id`,
      [workspaceId, projectId, buildId]
    );
    if (!nodes.rowCount) return null;
    const edges = await this.pool.query<GraphEdgeRow>(
      `SELECT edge_id, from_node_id, to_node_id, kind, candidate, candidate_reason, confidence, source_refs
       FROM knowledge_graph_edges WHERE workspace_id = $1 AND project_id = $2 AND build_job_id = $3 ORDER BY edge_id`,
      [workspaceId, projectId, buildId]
    );
    const graph: KnowledgeGraphRecord = {
      nodes: nodes.rows.map((row) => graphNodeSchema.parse({
        id: row.node_id, workspaceId: row.workspace_id, projectId: row.project_id, snapshotId: row.snapshot_id,
        kind: row.kind, name: row.name, qualifiedName: row.qualified_name, candidate: row.candidate,
        sourceRefs: row.source_refs, attributes: row.attributes
      })),
      edges: edges.rows.map((row) => graphEdgeSchema.parse({
        id: row.edge_id, fromNodeId: row.from_node_id, toNodeId: row.to_node_id, kind: row.kind,
        candidate: row.candidate, ...(row.candidate_reason ? { candidateReason: row.candidate_reason } : {}),
        confidence: row.confidence, sourceRefs: row.source_refs
      }))
    };
    validateKnowledgeGraph(graph);
    return graph;
  }

  async isSetupComplete(): Promise<boolean> {
    const { rows } = await this.pool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM admin_users) AS exists"
    );
    return rows[0]?.exists ?? false;
  }

  async createInitialSetup(email: string, passwordHash: string): Promise<SetupResult | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('devkh_initial_setup'))");
      const existing = await client.query("SELECT 1 FROM admin_users LIMIT 1");
      if (existing.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }
      const workspaceResult = await client.query<{
        id: string; name: string; slug: string;
      }>(
        "INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id, name, slug",
        ["Default Workspace", "default"]
      );
      const workspace = workspaceResult.rows[0];
      const adminResult = await client.query<{
        id: string; workspace_id: string; email: string; password_hash: string;
        disabled_at: Date | null; session_version: number;
      }>(
        `INSERT INTO admin_users (workspace_id, email, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, workspace_id, email, password_hash, disabled_at, session_version`,
        [workspace.id, email, passwordHash]
      );
      const admin = adminResult.rows[0];
      await client.query(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')",
        [workspace.id, admin.id]
      );
      const projectResult = await client.query<ProjectRow>(
        `INSERT INTO projects (workspace_id, name, slug) VALUES ($1, $2, $3)
         RETURNING id, workspace_id, name, slug, archived_at, created_at`,
        [workspace.id, "默认项目", "default-project"]
      );
      await client.query(
        "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'admin')",
        [projectResult.rows[0].id, admin.id]
      );
      await this.insertAudit(client, {
        workspaceId: workspace.id,
        actorId: admin.id,
        action: "setup.completed",
        resourceType: "workspace",
        resourceId: workspace.id
      });
      await client.query("COMMIT");
      return {
        workspace,
        admin: {
          id: admin.id,
          workspaceId: admin.workspace_id,
          email: admin.email,
          passwordHash: admin.password_hash,
          role: "admin",
          disabledAt: admin.disabled_at,
          sessionVersion: admin.session_version
        }
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findAdminByEmail(email: string): Promise<AdminRecord | null> {
    const { rows } = await this.pool.query<TeamMemberRow>(
      `SELECT u.id, u.workspace_id, u.email, u.password_hash, m.role, m.created_at,
              u.disabled_at, u.session_version
       FROM admin_users u
       JOIN workspace_members m ON m.workspace_id = u.workspace_id AND m.user_id = u.id
       WHERE u.email = $1 LIMIT 1`,
      [email]
    );
    const row = rows[0];
    return row ? {
      id: row.id,
      workspaceId: row.workspace_id,
      email: row.email,
      passwordHash: row.password_hash,
      role: row.role,
      disabledAt: row.disabled_at,
      sessionVersion: row.session_version
    } : null;
  }

  async findAdminById(id: string, workspaceId: string): Promise<AdminRecord | null> {
    const { rows } = await this.pool.query<TeamMemberRow>(
      `SELECT u.id, u.workspace_id, u.email, u.password_hash, m.role, m.created_at,
              u.disabled_at, u.session_version
       FROM admin_users u
       JOIN workspace_members m ON m.workspace_id = u.workspace_id AND m.user_id = u.id
       WHERE u.id = $1 AND u.workspace_id = $2`,
      [id, workspaceId]
    );
    const row = rows[0];
    return row ? {
      id: row.id,
      workspaceId: row.workspace_id,
      email: row.email,
      passwordHash: row.password_hash,
      role: row.role,
      disabledAt: row.disabled_at,
      sessionVersion: row.session_version
    } : null;
  }

  async getAdminMfa(workspaceId: string, userId: string): Promise<AdminMfaRecord | null> {
    const { rows } = await this.pool.query<AdminMfaRow>(
      `SELECT user_id, workspace_id, encrypted_secret, enabled_at, failed_attempts, locked_until
       FROM admin_mfa WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId]
    );
    return rows[0] ? adminMfaRecord(rows[0]) : null;
  }

  async savePendingAdminMfa(workspaceId: string, userId: string, encryptedSecret: string): Promise<AdminMfaRecord> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<AdminMfaRow>(
        `INSERT INTO admin_mfa (user_id, workspace_id, encrypted_secret, enabled_at, failed_attempts, locked_until)
         VALUES ($1, $2, $3, NULL, 0, NULL)
         ON CONFLICT (user_id) DO UPDATE SET encrypted_secret = EXCLUDED.encrypted_secret,
           workspace_id = EXCLUDED.workspace_id, enabled_at = NULL, failed_attempts = 0, locked_until = NULL, updated_at = now()
         RETURNING user_id, workspace_id, encrypted_secret, enabled_at, failed_attempts, locked_until`,
        [userId, workspaceId, encryptedSecret]
      );
      await client.query("DELETE FROM admin_mfa_recovery_codes WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId]);
      return adminMfaRecord(rows[0]);
    });
  }

  async enableAdminMfa(
    workspaceId: string, userId: string, recoveryCodeHashes: string[], actorId: string
  ): Promise<AdminMfaRecord | null> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<AdminMfaRow>(
        `UPDATE admin_mfa SET enabled_at = now(), failed_attempts = 0, locked_until = NULL, updated_at = now()
         WHERE workspace_id = $1 AND user_id = $2 AND enabled_at IS NULL
         RETURNING user_id, workspace_id, encrypted_secret, enabled_at, failed_attempts, locked_until`,
        [workspaceId, userId]
      );
      if (!rows[0]) return null;
      await client.query(
        "UPDATE admin_users SET session_version = session_version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2",
        [workspaceId, userId]
      );
      for (const codeHash of recoveryCodeHashes) {
        await client.query(
          "INSERT INTO admin_mfa_recovery_codes (user_id, workspace_id, code_hash) VALUES ($1, $2, $3)",
          [userId, workspaceId, codeHash]
        );
      }
      await this.insertAudit(client, { workspaceId, actorId, action: "mfa.enabled", resourceType: "admin_mfa", resourceId: userId });
      return adminMfaRecord(rows[0]);
    });
  }

  async clearAdminMfaFailures(workspaceId: string, userId: string): Promise<void> {
    await this.pool.query(
      "UPDATE admin_mfa SET failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId]
    );
  }

  async recordAdminMfaFailure(workspaceId: string, userId: string, now = new Date()): Promise<AdminMfaRecord | null> {
    const { rows } = await this.pool.query<AdminMfaRow>(
      `UPDATE admin_mfa
       SET failed_attempts = CASE WHEN locked_until IS NOT NULL AND locked_until > $3 THEN failed_attempts ELSE failed_attempts + 1 END,
           locked_until = CASE
             WHEN locked_until IS NOT NULL AND locked_until > $3 THEN locked_until
             WHEN failed_attempts + 1 >= 5 THEN $3 + interval '15 minutes'
             ELSE NULL END,
           updated_at = now()
       WHERE workspace_id = $1 AND user_id = $2
       RETURNING user_id, workspace_id, encrypted_secret, enabled_at, failed_attempts, locked_until`,
      [workspaceId, userId, now]
    );
    return rows[0] ? adminMfaRecord(rows[0]) : null;
  }

  async listActiveAdminMfaRecoveryCodes(workspaceId: string, userId: string): Promise<AdminMfaRecoveryCodeRecord[]> {
    const { rows } = await this.pool.query<{ id: string; code_hash: string; used_at: Date | null }>(
      `SELECT id, code_hash, used_at FROM admin_mfa_recovery_codes
       WHERE workspace_id = $1 AND user_id = $2 AND used_at IS NULL ORDER BY created_at ASC`,
      [workspaceId, userId]
    );
    return rows.map((row) => ({ id: row.id, codeHash: row.code_hash, usedAt: row.used_at }));
  }

  async consumeAdminMfaRecoveryCode(workspaceId: string, userId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE admin_mfa_recovery_codes SET used_at = now()
       WHERE id = $1 AND workspace_id = $2 AND user_id = $3 AND used_at IS NULL`,
      [id, workspaceId, userId]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async disableAdminMfa(workspaceId: string, userId: string, actorId: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const deleted = await client.query(
        "DELETE FROM admin_mfa WHERE workspace_id = $1 AND user_id = $2 AND enabled_at IS NOT NULL RETURNING user_id",
        [workspaceId, userId]
      );
      if (!deleted.rows[0]) return false;
      await client.query("UPDATE admin_users SET session_version = session_version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2", [workspaceId, userId]);
      await this.insertAudit(client, { workspaceId, actorId, action: "mfa.disabled", resourceType: "admin_mfa", resourceId: userId });
      return true;
    });
  }

  async listTeamMembers(workspaceId: string, pagination?: Pagination): Promise<TeamMemberRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    const { rows } = await this.pool.query<TeamMemberRow>(
      `SELECT u.id, u.workspace_id, u.email, u.password_hash, m.role, m.created_at,
              u.disabled_at, u.session_version
       FROM admin_users u
       JOIN workspace_members m ON m.workspace_id = u.workspace_id AND m.user_id = u.id
       WHERE u.workspace_id = $1
       ORDER BY m.created_at ASC, u.id ASC
       LIMIT $2 OFFSET $3`,
      [workspaceId, limit, offset]
    );
    return rows.map(teamMemberRecord);
  }

  async countTeamMembers(workspaceId: string): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM workspace_members WHERE workspace_id = $1`,
      [workspaceId]
    );
    return Number(rows[0]?.total ?? 0);
  }

  async createTeamMember(
    workspaceId: string,
    input: { email: string; passwordHash: string; role: TeamRole },
    actorId: string
  ): Promise<TeamMemberRecord | null> {
    return this.transaction(async (client) => {
      const inserted = await client.query<{ id: string; workspace_id: string; email: string; password_hash: string; disabled_at: Date | null; session_version: number }>(
        `INSERT INTO admin_users (workspace_id, email, password_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, email) DO NOTHING
         RETURNING id, workspace_id, email, password_hash, disabled_at, session_version`,
        [workspaceId, input.email, input.passwordHash]
      );
      const user = inserted.rows[0];
      if (!user) return null;
      const membership = await client.query<TeamMemberRow>(
        `INSERT INTO workspace_members (workspace_id, user_id, role)
         VALUES ($1, $2, $3)
         RETURNING $2::uuid AS id, $1::uuid AS workspace_id, $4::text AS email,
                   $5::text AS password_hash, role, created_at,
                   $6::timestamptz AS disabled_at, $7::integer AS session_version`,
        [workspaceId, user.id, input.role, user.email, user.password_hash, user.disabled_at, user.session_version]
      );
      const member = teamMemberRecord(membership.rows[0]);
      await this.insertAudit(client, {
        workspaceId,
        actorId,
        action: "member.created",
        resourceType: "workspace_member",
        resourceId: member.id,
        metadata: { role: member.role }
      });
      return member;
    });
  }

  async resetTeamMemberPassword(
    workspaceId: string, userId: string, passwordHash: string, actorId: string
  ): Promise<TeamMemberRecord | null> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<TeamMemberRow>(
        `UPDATE admin_users u
         SET password_hash = $3, session_version = session_version + 1, updated_at = now()
         FROM workspace_members m
         WHERE u.id = m.user_id AND u.workspace_id = m.workspace_id
           AND u.workspace_id = $1 AND u.id = $2
         RETURNING u.id, u.workspace_id, u.email, u.password_hash, m.role, m.created_at,
                   u.disabled_at, u.session_version`,
        [workspaceId, userId, passwordHash]
      );
      const member = rows[0] ? teamMemberRecord(rows[0]) : null;
      if (!member) return null;
      await this.insertAudit(client, {
        workspaceId, actorId, action: "member.password_reset", resourceType: "workspace_member", resourceId: member.id
      });
      return member;
    });
  }

  async setTeamMemberDisabled(
    workspaceId: string, userId: string, disabled: boolean, actorId: string
  ): Promise<TeamMemberRecord | null> {
    return this.transaction(async (client) => {
      const target = await client.query<TeamMemberRow>(
        `SELECT u.id, u.workspace_id, u.email, u.password_hash, m.role, m.created_at,
                u.disabled_at, u.session_version
         FROM admin_users u
         JOIN workspace_members m ON m.workspace_id = u.workspace_id AND m.user_id = u.id
         WHERE u.workspace_id = $1 AND u.id = $2 FOR UPDATE`,
        [workspaceId, userId]
      );
      const member = target.rows[0];
      if (!member) return null;
      if (disabled && !member.disabled_at && member.role === "admin") {
        const activeAdministrators = await client.query<{ id: string }>(
          `SELECT u.id
           FROM admin_users u
           JOIN workspace_members m ON m.workspace_id = u.workspace_id AND m.user_id = u.id
           WHERE u.workspace_id = $1 AND m.role = 'admin' AND u.disabled_at IS NULL
           FOR UPDATE`,
          [workspaceId]
        );
        if (activeAdministrators.rows.length <= 1) throw new LastWorkspaceAdminError();
      }
      const updated = await client.query<{ disabled_at: Date | null; session_version: number }>(
        `UPDATE admin_users
         SET disabled_at = CASE WHEN $3 THEN now() ELSE NULL END,
             session_version = session_version + 1,
             updated_at = now()
         WHERE workspace_id = $1 AND id = $2
         RETURNING disabled_at, session_version`,
        [workspaceId, userId, disabled]
      );
      const result = teamMemberRecord({ ...member, ...updated.rows[0] });
      await this.insertAudit(client, {
        workspaceId,
        actorId,
        action: disabled ? "member.disabled" : "member.enabled",
        resourceType: "workspace_member",
        resourceId: result.id
      });
      return result;
    });
  }

  async listProjects(workspaceId: string, pagination?: Pagination): Promise<ProjectRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    const { rows } = await this.pool.query<ProjectRow>(
      `SELECT id, workspace_id, name, slug, archived_at, created_at
       FROM projects WHERE workspace_id = $1
       ORDER BY created_at ASC, id ASC LIMIT $2 OFFSET $3`,
      [workspaceId, limit, offset]
    );
    return rows.map(projectRecord);
  }

  async createProject(
    workspaceId: string,
    input: { name: string; slug: string },
    actorId: string
  ): Promise<ProjectRecord | null> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<ProjectRow>(
        `INSERT INTO projects (workspace_id, name, slug)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, slug) DO NOTHING
         RETURNING id, workspace_id, name, slug, archived_at, created_at`,
        [workspaceId, input.name, input.slug]
      );
      const row = rows[0];
      if (!row) return null;
      const project = projectRecord(row);
      const creator = await client.query<{ user_id: string }>(
        `INSERT INTO project_members (project_id, user_id, role)
         SELECT $1, workspace_members.user_id, 'admin'
         FROM workspace_members
         WHERE workspace_members.workspace_id = $2 AND workspace_members.user_id = $3
         RETURNING user_id`,
        [project.id, workspaceId, actorId]
      );
      if (!creator.rows[0]) {
        throw new Error("Project creator must be a workspace member");
      }
      await this.insertAudit(client, {
        workspaceId,
        actorId,
        action: "project.created",
        resourceType: "project",
        resourceId: project.id
      });
      return project;
    });
  }

  async listAccessibleProjects(
    workspaceId: string,
    userId: string,
    pagination?: Pagination
  ): Promise<ProjectRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    const { rows } = await this.pool.query<ProjectRow>(
      `SELECT p.id, p.workspace_id, p.name, p.slug, p.archived_at, p.created_at
       FROM projects p
       JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = $2
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
       WHERE p.workspace_id = $1 AND (wm.role = 'admin' OR pm.user_id IS NOT NULL)
       ORDER BY p.created_at ASC, p.id ASC
       LIMIT $3 OFFSET $4`,
      [workspaceId, userId, limit, offset]
    );
    return rows.map(projectRecord);
  }

  async workspaceOverview(workspaceId: string, userId: string): Promise<WorkspaceProjectOverviewRecord[]> {
    type OverviewRow = QueryResultRow & {
      project: Record<string, unknown>;
      repository: Record<string, unknown> | null;
      latest_snapshot: Record<string, unknown> | null;
      current_release: Record<string, unknown> | null;
      latest_build: Record<string, unknown> | null;
      indexed_text_bytes: string;
      member_count: string;
      pending_feedback_count: string;
    };
    const { rows } = await this.pool.query<OverviewRow>(
      `WITH accessible_projects AS (
         SELECT p.id, p.workspace_id, p.name, p.slug, p.archived_at, p.created_at
         FROM projects p
         JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = $2
         LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
         WHERE p.workspace_id = $1 AND p.archived_at IS NULL
           AND (wm.role = 'admin' OR pm.user_id IS NOT NULL)
       )
       SELECT jsonb_build_object(
                'id', p.id, 'workspace_id', p.workspace_id, 'name', p.name, 'slug', p.slug,
                'archived_at', p.archived_at, 'created_at', p.created_at
              ) AS project,
              repo.value AS repository, snapshot.value AS latest_snapshot,
              release.value AS current_release, build.value AS latest_build,
              COALESCE(snapshot.indexed_text_bytes, 0)::text AS indexed_text_bytes,
              COALESCE(members.member_count, 0)::text AS member_count,
              COALESCE(feedback.pending_feedback_count, 0)::text AS pending_feedback_count
       FROM accessible_projects p
       LEFT JOIN LATERAL (
         SELECT jsonb_build_object(
           'id', r.id, 'workspace_id', r.workspace_id, 'project_id', r.project_id,
           'kind', r.kind, 'name', r.name, 'local_path', r.local_path, 'clone_url', r.clone_url,
           'default_branch', r.default_branch, 'archived_at', r.archived_at,
           'has_credential', EXISTS (SELECT 1 FROM encrypted_credentials c WHERE c.repository_id = r.id)
         ) AS value, r.id
         FROM repositories r WHERE r.workspace_id = p.workspace_id AND r.project_id = p.id
           AND r.archived_at IS NULL LIMIT 1
       ) repo ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_build_object(
                  'id', s.id, 'workspace_id', s.workspace_id, 'repository_id', s.repository_id,
                  'commit_sha', s.commit_sha, 'ref', s.ref, 'remote_url', s.remote_url,
                  'commit_timestamp', s.commit_timestamp, 'storage_path', s.storage_path,
                  'file_count', COALESCE(files.file_count, 0)
                ) AS value,
                COALESCE(files.indexed_text_bytes, 0) AS indexed_text_bytes
         FROM source_snapshots s
         LEFT JOIN LATERAL (
           SELECT count(*)::bigint AS file_count, COALESCE(sum(byte_size), 0)::bigint AS indexed_text_bytes
           FROM source_files f WHERE f.snapshot_id = s.id
         ) files ON true
         WHERE s.workspace_id = p.workspace_id AND s.repository_id = repo.id
         ORDER BY s.commit_timestamp DESC, s.created_at DESC, s.id DESC LIMIT 1
       ) snapshot ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_build_object(
           'id', r.id, 'workspace_id', r.workspace_id, 'repository_id', r.repository_id,
           'build_job_id', r.build_job_id, 'snapshot_id', r.snapshot_id, 'version', r.version,
           'kernel_mode', r.kernel_mode, 'package_artifact_id', r.package_artifact_id,
           'created_at', r.created_at, 'published_at', r.published_at
         ) AS value
         FROM release_channels channel JOIN releases r ON r.id = channel.release_id
         WHERE channel.workspace_id = p.workspace_id AND channel.repository_id = repo.id AND channel.name = 'current'
         LIMIT 1
       ) release ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_build_object(
           'id', b.id, 'workspace_id', b.workspace_id, 'repository_id', b.repository_id,
           'snapshot_id', b.snapshot_id, 'snapshot_path', b.snapshot_path, 'commit_sha', b.commit_sha,
           'status', b.status, 'warnings', b.warnings, 'cancel_requested', b.cancel_requested,
           'error_message', b.error_message, 'purpose', b.purpose, 'feedback_ids', b.feedback_ids,
           'feedback_context', b.feedback_context, 'remediation_context', b.remediation_context,
           'allow_llm', b.allow_llm
         ) AS value
         FROM build_jobs b WHERE b.workspace_id = p.workspace_id AND b.repository_id = repo.id
         ORDER BY b.created_at DESC, b.id DESC LIMIT 1
       ) build ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::bigint AS member_count FROM project_members pm WHERE pm.project_id = p.id
       ) members ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::bigint AS pending_feedback_count
         FROM agent_feedback f JOIN releases r ON r.id = f.release_id
         WHERE f.workspace_id = p.workspace_id AND f.status = 'open' AND r.repository_id = repo.id
       ) feedback ON true
       ORDER BY p.created_at ASC, p.id ASC`,
      [workspaceId, userId]
    );
    const date = (value: unknown) => new Date(String(value));
    return rows.map((row) => {
      const project = row.project;
      const repository = row.repository;
      const snapshot = row.latest_snapshot;
      const release = row.current_release;
      const build = row.latest_build;
      return {
        project: {
          id: String(project.id), workspaceId: String(project.workspace_id), name: String(project.name),
          slug: String(project.slug), archivedAt: project.archived_at ? date(project.archived_at) : null,
          createdAt: date(project.created_at)
        },
        repository: repository ? {
          id: String(repository.id), workspaceId: String(repository.workspace_id), projectId: String(repository.project_id),
          kind: repository.kind as RepositoryRecord["kind"], name: String(repository.name),
          localPath: repository.local_path ? String(repository.local_path) : null,
          cloneUrl: repository.clone_url ? String(repository.clone_url) : null,
          defaultBranch: String(repository.default_branch), archivedAt: repository.archived_at ? date(repository.archived_at) : null,
          hasCredential: Boolean(repository.has_credential)
        } : null,
        latestSnapshot: snapshot ? {
          id: String(snapshot.id), workspaceId: String(snapshot.workspace_id), repositoryId: String(snapshot.repository_id),
          commitSha: String(snapshot.commit_sha), ref: String(snapshot.ref),
          remoteUrl: snapshot.remote_url ? String(snapshot.remote_url) : null,
          commitTimestamp: date(snapshot.commit_timestamp), storagePath: String(snapshot.storage_path),
          fileCount: Number(snapshot.file_count ?? 0)
        } : null,
        indexedTextBytes: Number(row.indexed_text_bytes),
        currentRelease: release ? {
          id: String(release.id), workspaceId: String(release.workspace_id), repositoryId: String(release.repository_id),
          buildId: String(release.build_job_id), snapshotId: String(release.snapshot_id), version: String(release.version),
          kernelMode: release.kernel_mode === "pipeline" ? "pipeline" : "legacy",
          packageArtifactId: release.package_artifact_id ? String(release.package_artifact_id) : null,
          createdAt: date(release.created_at), publishedAt: release.published_at ? date(release.published_at) : null
        } : null,
        latestBuild: build ? {
          id: String(build.id), workspaceId: String(build.workspace_id), repositoryId: String(build.repository_id),
          snapshotId: String(build.snapshot_id), snapshotPath: String(build.snapshot_path),
          commitSha: String(build.commit_sha), status: build.status as BuildStatus, warnings: build.warnings as BuildRecord["warnings"],
          cancelRequested: Boolean(build.cancel_requested),
          purpose: build.purpose === "feedback" ? {
            kind: "feedback", feedbackIds: (build.feedback_ids ?? []) as string[],
            feedbackContext: (build.feedback_context ?? []) as BuildRecord["purpose"]["feedbackContext"]
          } : build.purpose === "remediation" ? {
            kind: "remediation", feedbackIds: [], feedbackContext: [],
            remediationContext: (build.remediation_context ?? []) as Extract<BuildRecord["purpose"], { kind: "remediation" }>["remediationContext"]
          } : standardBuildPurpose(),
          allowLlm: Boolean(build.allow_llm),
          ...(build.error_message ? { errorMessage: String(build.error_message) } : {})
        } : null,
        memberCount: Number(row.member_count),
        pendingFeedbackCount: Number(row.pending_feedback_count)
      };
    });
  }

  async searchWorkspaceKnowledge(
    workspaceId: string,
    userId: string,
    query: string
  ): Promise<WorkspaceKnowledgeSearchRecord[]> {
    const { rows } = await this.pool.query<ProjectRow>(
      `SELECT p.id, p.workspace_id, p.name, p.slug, p.archived_at, p.created_at
       FROM projects p
       JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = $2
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
       WHERE p.workspace_id = $1 AND p.archived_at IS NULL
         AND (wm.role = 'admin' OR pm.user_id IS NOT NULL)
       ORDER BY p.created_at ASC, p.id ASC`,
      [workspaceId, userId]
    );
    const resultSets = await Promise.all(rows.map(async (row) => {
      const project = projectRecord(row);
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
    const { rows } = await this.pool.query<ProjectMemberRow>(
      `SELECT pm.user_id AS id, pm.project_id, p.workspace_id, u.email, pm.role, pm.created_at
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
       JOIN admin_users u ON u.id = pm.user_id
       JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = pm.user_id
       WHERE p.workspace_id = $1 AND p.id = $2
       ORDER BY pm.created_at ASC, pm.user_id ASC
       LIMIT $3 OFFSET $4`,
      [workspaceId, projectId, limit, offset]
    );
    return rows.map(projectMemberRecord);
  }

  async addProjectMember(
    workspaceId: string,
    projectId: string,
    userId: string,
    role: ProjectRole,
    actorId: string
  ): Promise<ProjectMemberRecord | null> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<ProjectMemberRow>(
        `WITH inserted AS (
           INSERT INTO project_members (project_id, user_id, role)
           SELECT p.id, wm.user_id, $4::team_role
           FROM projects p
           JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = $3
           WHERE p.workspace_id = $1 AND p.id = $2
             AND (wm.role <> 'reader' OR $4::team_role = 'reader')
           ON CONFLICT (project_id, user_id) DO NOTHING
           RETURNING project_id, user_id, role, created_at
         )
         SELECT inserted.user_id AS id, inserted.project_id, p.workspace_id, u.email,
                inserted.role, inserted.created_at
         FROM inserted
         JOIN projects p ON p.id = inserted.project_id
         JOIN admin_users u ON u.id = inserted.user_id`,
        [workspaceId, projectId, userId, role]
      );
      const row = rows[0];
      if (!row) return null;
      const member = projectMemberRecord(row);
      await this.insertAudit(client, {
        workspaceId,
        actorId,
        action: "project_member.added",
        resourceType: "project_member",
        resourceId: member.id,
        metadata: { projectId, userId, role }
      });
      return member;
    });
  }

  async updateProjectMemberRole(
    workspaceId: string,
    projectId: string,
    userId: string,
    role: ProjectRole,
    actorId: string
  ): Promise<ProjectMemberRecord | null> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<ProjectMemberLockRow>(
        `SELECT pm.user_id AS id, pm.project_id, p.workspace_id, u.email, pm.role, pm.created_at,
                wm.role AS workspace_role
         FROM project_members pm
         JOIN projects p ON p.id = pm.project_id
         JOIN admin_users u ON u.id = pm.user_id
         JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = pm.user_id
         WHERE p.workspace_id = $1 AND p.id = $2
         FOR UPDATE OF pm`,
        [workspaceId, projectId]
      );
      const current = rows.find((member) => member.id === userId);
      if (!current || (current.workspace_role === "reader" && role !== "reader")) return null;
      if (current.role === "admin" && role !== "admin" && rows.filter((member) => member.role === "admin").length === 1) {
        throw new LastProjectAdminError();
      }
      await client.query(
        `UPDATE project_members SET role = $2, updated_at = now()
         WHERE project_id = $1 AND user_id = $3`,
        [projectId, role, userId]
      );
      const member = projectMemberRecord({ ...current, role });
      await this.insertAudit(client, {
        workspaceId,
        actorId,
        action: "project_member.role_changed",
        resourceType: "project_member",
        resourceId: member.id,
        metadata: { projectId, userId, role }
      });
      return member;
    });
  }

  async removeProjectMember(
    workspaceId: string,
    projectId: string,
    userId: string,
    actorId: string
  ): Promise<ProjectMemberRecord | null> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<ProjectMemberLockRow>(
        `SELECT pm.user_id AS id, pm.project_id, p.workspace_id, u.email, pm.role, pm.created_at,
                wm.role AS workspace_role
         FROM project_members pm
         JOIN projects p ON p.id = pm.project_id
         JOIN admin_users u ON u.id = pm.user_id
         JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = pm.user_id
         WHERE p.workspace_id = $1 AND p.id = $2
         FOR UPDATE OF pm`,
        [workspaceId, projectId]
      );
      const current = rows.find((member) => member.id === userId);
      if (!current) return null;
      if (current.role === "admin" && rows.filter((member) => member.role === "admin").length === 1) {
        throw new LastProjectAdminError();
      }
      await client.query(
        "DELETE FROM project_members WHERE project_id = $1 AND user_id = $2",
        [projectId, userId]
      );
      const member = projectMemberRecord(current);
      await this.insertAudit(client, {
        workspaceId,
        actorId,
        action: "project_member.removed",
        resourceType: "project_member",
        resourceId: member.id,
        metadata: { projectId, userId, role: member.role }
      });
      return member;
    });
  }

  async projectAccess(workspaceId: string, projectId: string, userId: string): Promise<ProjectAccess | null> {
    const { rows } = await this.pool.query<ProjectAccessRow>(
      `SELECT p.id, p.workspace_id, p.name, p.slug, p.archived_at, p.created_at,
              CASE WHEN wm.role = 'admin' THEN 'admin'::team_role ELSE pm.role END AS role
       FROM projects p
       JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = $3
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $3
       WHERE p.workspace_id = $1 AND p.id = $2
         AND (wm.role = 'admin' OR pm.user_id IS NOT NULL)`,
      [workspaceId, projectId, userId]
    );
    const row = rows[0];
    return row ? { project: projectRecord(row), role: row.role } : null;
  }

  async defaultWorkspace(): Promise<WorkspaceRecord | null> {
    const { rows } = await this.pool.query<WorkspaceRecord>(
      "SELECT id, name, slug FROM workspaces WHERE slug = 'default' LIMIT 1"
    );
    return rows[0] ?? null;
  }

  async recordAudit(event: AuditEventInput): Promise<void> {
    await this.insertAudit(this.pool, event);
  }

  async listProjectActivity(
    workspaceId: string,
    projectId: string,
    pagination?: Pagination
  ): Promise<AuditEventRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    const { rows } = await this.pool.query<AuditEventRow>(
      `SELECT a.id, a.workspace_id, a.actor_id, a.action, a.resource_type,
              a.resource_id, a.metadata, a.created_at
       FROM audit_events a
       WHERE a.workspace_id = $1 AND (
         (a.resource_type = 'project' AND a.resource_id = $2::text)
         OR EXISTS (
           SELECT 1 FROM repositories r
           WHERE r.workspace_id = a.workspace_id AND r.project_id = $3::uuid
             AND r.id::text = a.resource_id
         )
         OR EXISTS (
           SELECT 1 FROM mcp_tokens t
           WHERE t.workspace_id = a.workspace_id AND t.project_id = $3::uuid
             AND t.id::text = a.resource_id
         )
         OR a.metadata->>'projectId' = $2::text
       )
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $4 OFFSET $5`,
      [workspaceId, projectId, projectId, limit, offset]
    );
    return rows.map(auditEventRecord);
  }

  async countProjectActivity(workspaceId: string, projectId: string): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM audit_events a
       WHERE a.workspace_id = $1 AND (
         (a.resource_type = 'project' AND a.resource_id = $2::text)
         OR EXISTS (
           SELECT 1 FROM repositories r
           WHERE r.workspace_id = a.workspace_id AND r.project_id = $3::uuid
             AND r.id::text = a.resource_id
         )
         OR EXISTS (
           SELECT 1 FROM mcp_tokens t
           WHERE t.workspace_id = a.workspace_id AND t.project_id = $3::uuid
             AND t.id::text = a.resource_id
         )
         OR a.metadata->>'projectId' = $2::text
       )`,
      [workspaceId, projectId, projectId]
    );
    return Number(rows[0]?.total ?? 0);
  }

  async createImportReport(
    input: Omit<ImportReportRecord, "id" | "startedAt" | "finishedAt" | "status" | "collectedFileCount" | "collectedTextBytes" | "ignored" | "snapshotId" | "failureCode">
  ): Promise<ImportReportRecord> {
    const { rows } = await this.pool.query<ImportReportRow>(
      `INSERT INTO import_reports (workspace_id, project_id, repository_id, actor_id, source_kind, status)
       VALUES ($1, $2, $3, $4, $5, 'running')
       RETURNING id, workspace_id, project_id, repository_id, actor_id, source_kind, status,
                 started_at, finished_at, collected_file_count, collected_text_bytes, ignored,
                 snapshot_id, failure_code`,
      [input.workspaceId, input.projectId, input.repositoryId, input.actorId, input.sourceKind]
    );
    return importReportRecord(rows[0]);
  }

  async finishImportReport(
    workspaceId: string,
    reportId: string,
    input: Pick<ImportReportRecord, "status" | "collectedFileCount" | "collectedTextBytes" | "ignored" | "snapshotId" | "failureCode">
  ): Promise<ImportReportRecord | null> {
    const { rows } = await this.pool.query<ImportReportRow>(
      `UPDATE import_reports
       SET status = $3, finished_at = now(), collected_file_count = $4, collected_text_bytes = $5,
           ignored = $6::jsonb, snapshot_id = $7, failure_code = $8
       WHERE workspace_id = $1 AND id = $2 AND status = 'running'
       RETURNING id, workspace_id, project_id, repository_id, actor_id, source_kind, status,
                 started_at, finished_at, collected_file_count, collected_text_bytes, ignored,
                 snapshot_id, failure_code`,
      [workspaceId, reportId, input.status, input.collectedFileCount, input.collectedTextBytes,
        JSON.stringify(input.ignored), input.snapshotId, input.failureCode]
    );
    return rows[0] ? importReportRecord(rows[0]) : null;
  }

  async listImportReports(workspaceId: string, projectId: string, pagination?: Pagination): Promise<ImportReportRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    const { rows } = await this.pool.query<ImportReportRow>(
      `SELECT id, workspace_id, project_id, repository_id, actor_id, source_kind, status,
              started_at, finished_at, collected_file_count, collected_text_bytes, ignored,
              snapshot_id, failure_code
       FROM import_reports WHERE workspace_id = $1 AND project_id = $2
       ORDER BY started_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [workspaceId, projectId, limit, offset]
    );
    return rows.map(importReportRecord);
  }

  async countImportReports(workspaceId: string, projectId: string): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      "SELECT count(*)::text AS total FROM import_reports WHERE workspace_id = $1 AND project_id = $2",
      [workspaceId, projectId]
    );
    return Number(rows[0]?.total ?? 0);
  }

  async deleteExpiredImportReports(cutoff: Date): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM import_reports
       WHERE status IN ('failed', 'cancelled') AND finished_at < $1`,
      [cutoff]
    );
    return rowCount ?? 0;
  }

  async createMcpToken(
    input: CreateMcpTokenInput
  ): Promise<McpTokenRecord> {
    const { rows } = await this.pool.query<McpTokenRow>(
      `INSERT INTO mcp_tokens (workspace_id, project_id, name, token_hash, token_prefix, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now() + interval '90 days'))
       RETURNING id, workspace_id, project_id, name, token_hash, token_prefix, scopes, expires_at,
               created_at, last_used_at, revoked_at`,
      [input.workspaceId, input.projectId, input.name, input.tokenHash, input.tokenPrefix, input.scopes ?? ["search", "source.read"], input.expiresAt ?? null]
    );
    return mcpTokenRecord(rows[0]);
  }

  async createMcpTokenWithAudit(
    input: CreateMcpTokenInput,
    actorId: string
  ): Promise<McpTokenRecord> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<McpTokenRow>(
        `INSERT INTO mcp_tokens (workspace_id, project_id, name, token_hash, token_prefix, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now() + interval '90 days'))
         RETURNING id, workspace_id, project_id, name, token_hash, token_prefix, scopes, expires_at,
                 created_at, last_used_at, revoked_at`,
        [input.workspaceId, input.projectId, input.name, input.tokenHash, input.tokenPrefix, input.scopes ?? ["search", "source.read"], input.expiresAt ?? null]
      );
      const token = mcpTokenRecord(rows[0]);
      await this.insertAudit(client, {
        workspaceId: input.workspaceId,
        actorId,
        action: "mcp_token.created",
        resourceType: "mcp_token",
        resourceId: token.id
      });
      return token;
    });
  }

  async listMcpTokens(workspaceId: string, pagination?: Pagination, projectId?: string): Promise<McpTokenRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    const { rows } = await this.pool.query<McpTokenRow>(
      `SELECT id, workspace_id, project_id, name, token_hash, token_prefix, scopes, expires_at,
              created_at, last_used_at, revoked_at
       FROM mcp_tokens WHERE workspace_id = $1 AND ($2::uuid IS NULL OR project_id = $2)
       ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [workspaceId, projectId ?? null, limit, offset]
    );
    return rows.map(mcpTokenRecord);
  }

  async countMcpTokens(workspaceId: string, projectId?: string): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      "SELECT count(*)::text AS total FROM mcp_tokens WHERE workspace_id = $1 AND ($2::uuid IS NULL OR project_id = $2)",
      [workspaceId, projectId ?? null]
    );
    return Number(rows[0]?.total ?? 0);
  }

  async findActiveMcpToken(tokenHash: string): Promise<McpTokenRecord | null> {
    const { rows } = await this.pool.query<McpTokenRow>(
      `SELECT id, workspace_id, project_id, name, token_hash, token_prefix, scopes, expires_at,
              created_at, last_used_at, revoked_at
       FROM mcp_tokens WHERE token_hash = $1 AND revoked_at IS NULL AND project_id IS NOT NULL LIMIT 1`,
      [tokenHash]
    );
    return rows[0] ? mcpTokenRecord(rows[0]) : null;
  }

  async touchMcpToken(tokenId: string): Promise<void> {
    await this.pool.query(
      "UPDATE mcp_tokens SET last_used_at = now(), updated_at = now() WHERE id = $1 AND revoked_at IS NULL",
      [tokenId]
    );
  }

  async revokeMcpToken(workspaceId: string, tokenId: string): Promise<McpTokenRecord | null> {
    const { rows } = await this.pool.query<McpTokenRow>(
      `UPDATE mcp_tokens SET revoked_at = COALESCE(revoked_at, now()), updated_at = now()
       WHERE workspace_id = $1 AND id = $2
       RETURNING id, workspace_id, project_id, name, token_hash, token_prefix, scopes, expires_at,
                 created_at, last_used_at, revoked_at`,
      [workspaceId, tokenId]
    );
    return rows[0] ? mcpTokenRecord(rows[0]) : null;
  }

  async revokeMcpTokenWithAudit(
    workspaceId: string,
    tokenId: string,
    actorId: string
  ): Promise<McpTokenRecord | null> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<McpTokenRow>(
        `UPDATE mcp_tokens SET revoked_at = COALESCE(revoked_at, now()), updated_at = now()
         WHERE workspace_id = $1 AND id = $2
         RETURNING id, workspace_id, project_id, name, token_hash, token_prefix, scopes, expires_at,
                   created_at, last_used_at, revoked_at`,
        [workspaceId, tokenId]
      );
      if (!rows[0]) return null;
      const token = mcpTokenRecord(rows[0]);
      await this.insertAudit(client, {
        workspaceId,
        actorId,
        action: "mcp_token.revoked",
        resourceType: "mcp_token",
        resourceId: token.id
      });
      return token;
    });
  }

  async rotateMcpTokenWithAudit(
    workspaceId: string,
    tokenId: string,
    replacement: Pick<McpTokenRecord, "tokenHash" | "tokenPrefix"> & { scopes?: McpTokenRecord["scopes"] },
    actorId: string
  ): Promise<{ previous: McpTokenRecord; replacement: McpTokenRecord } | null> {
    return this.transaction(async (client) => {
      const previousResult = await client.query<McpTokenRow>(
        `SELECT id, workspace_id, project_id, name, token_hash, token_prefix, scopes, expires_at,
                created_at, last_used_at, revoked_at
         FROM mcp_tokens
         WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL
         FOR UPDATE`,
        [workspaceId, tokenId]
      );
      const previousRow = previousResult.rows[0];
      if (!previousRow) return null;
      const previous = mcpTokenRecord(previousRow);
      const replacementResult = await client.query<McpTokenRow>(
        `INSERT INTO mcp_tokens (workspace_id, project_id, name, token_hash, token_prefix, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + interval '90 days')
         RETURNING id, workspace_id, project_id, name, token_hash, token_prefix, scopes, expires_at,
                   created_at, last_used_at, revoked_at`,
        [workspaceId, previous.projectId, previous.name, replacement.tokenHash, replacement.tokenPrefix, replacement.scopes ?? previous.scopes]
      );
      const replacementToken = mcpTokenRecord(replacementResult.rows[0]);
      const revokedResult = await client.query<McpTokenRow>(
        `UPDATE mcp_tokens SET revoked_at = now(), updated_at = now()
         WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL
         RETURNING id, workspace_id, project_id, name, token_hash, token_prefix, scopes, expires_at,
                   created_at, last_used_at, revoked_at`,
        [workspaceId, tokenId]
      );
      const revoked = revokedResult.rows[0];
      if (!revoked) throw new Error("MCP token rotation lost its lock");
      const revokedToken = mcpTokenRecord(revoked);
      await this.insertAudit(client, {
        workspaceId,
        actorId,
        action: "mcp_token.rotated",
        resourceType: "mcp_token",
        resourceId: tokenId,
        metadata: { replacementTokenId: replacementToken.id }
      });
      return { previous: revokedToken, replacement: replacementToken };
    });
  }

  async createFeedback(input: CreateFeedbackInput): Promise<AgentFeedbackRecord> {
    const { rows } = await this.pool.query<FeedbackRow>(
      `INSERT INTO agent_feedback
       (workspace_id, release_id, query, reason, expected, citations)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id, workspace_id, release_id, query, reason, expected, citations, status,
                 rebuild_build_id, created_at, updated_at`,
      [
        input.workspaceId,
        input.releaseId ?? null,
        input.query,
        input.reason,
        input.expected ?? null,
        JSON.stringify(input.citations ?? [])
      ]
    );
    return feedbackRecord(rows[0]);
  }

  async reportFeedbackWithAudit(input: CreateFeedbackInput): Promise<AgentFeedbackRecord> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<FeedbackRow>(
        `INSERT INTO agent_feedback
         (workspace_id, release_id, query, reason, expected, citations)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING id, workspace_id, release_id, query, reason, expected, citations, status,
                   rebuild_build_id, created_at, updated_at`,
        [
          input.workspaceId,
          input.releaseId ?? null,
          input.query,
          input.reason,
          input.expected ?? null,
          JSON.stringify(input.citations ?? [])
        ]
      );
      const feedback = feedbackRecord(rows[0]);
      await this.insertAudit(client, {
        workspaceId: input.workspaceId,
        action: "feedback.reported",
        resourceType: "agent_feedback",
        resourceId: feedback.id,
        metadata: { releaseId: input.releaseId }
      });
      return feedback;
    });
  }

  async listFeedback(
    workspaceId: string,
    status?: AgentFeedbackStatus,
    pagination?: Pagination
  ): Promise<AgentFeedbackRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    const { rows } = await this.pool.query<FeedbackRow>(
      `SELECT id, workspace_id, release_id, query, reason, expected, citations, status,
              rebuild_build_id, created_at, updated_at
       FROM agent_feedback
       WHERE workspace_id = $1 AND ($2::agent_feedback_status IS NULL OR status = $2)
       ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [workspaceId, status ?? null, limit, offset]
    );
    return rows.map(feedbackRecord);
  }

  async countFeedback(workspaceId: string, status?: AgentFeedbackStatus): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM agent_feedback
       WHERE workspace_id = $1 AND ($2::agent_feedback_status IS NULL OR status = $2)`,
      [workspaceId, status ?? null]
    );
    return Number(rows[0]?.total ?? 0);
  }

  async getFeedback(workspaceId: string, feedbackId: string): Promise<AgentFeedbackRecord | null> {
    const { rows } = await this.pool.query<FeedbackRow>(
      `SELECT id, workspace_id, release_id, query, reason, expected, citations, status,
              rebuild_build_id, created_at, updated_at
       FROM agent_feedback WHERE workspace_id = $1 AND id = $2 LIMIT 1`,
      [workspaceId, feedbackId]
    );
    return rows[0] ? feedbackRecord(rows[0]) : null;
  }

  async transitionFeedback(
    workspaceId: string,
    feedbackId: string,
    status: AgentFeedbackStatus
  ): Promise<AgentFeedbackRecord | null> {
    const existing = await this.getFeedback(workspaceId, feedbackId);
    if (!existing) return null;
    const allowed: Record<AgentFeedbackStatus, AgentFeedbackStatus[]> = {
      open: ["acknowledged", "dismissed"],
      acknowledged: ["fixed", "dismissed"],
      fixed: [],
      dismissed: []
    };
    if (!allowed[existing.status].includes(status)) throw new InvalidFeedbackTransitionError();
    const { rows } = await this.pool.query<FeedbackRow>(
      `UPDATE agent_feedback SET status = $3, updated_at = now()
       WHERE workspace_id = $1 AND id = $2 AND status = $4
       RETURNING id, workspace_id, release_id, query, reason, expected, citations, status,
                 rebuild_build_id, created_at, updated_at`,
      [workspaceId, feedbackId, status, existing.status]
    );
    if (!rows[0]) throw new InvalidFeedbackTransitionError();
    return feedbackRecord(rows[0]);
  }

  async transitionFeedbackWithAudit(
    workspaceId: string,
    feedbackId: string,
    status: AgentFeedbackStatus,
    actorId: string
  ): Promise<AgentFeedbackRecord | null> {
    return this.transaction(async (client) => {
      const selected = await client.query<FeedbackRow>(
        `SELECT id, workspace_id, release_id, query, reason, expected, citations, status,
                rebuild_build_id, created_at, updated_at
         FROM agent_feedback WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
        [workspaceId, feedbackId]
      );
      const existing = selected.rows[0];
      if (!existing) return null;
      const allowed: Record<AgentFeedbackStatus, AgentFeedbackStatus[]> = {
        open: ["acknowledged", "dismissed"],
        acknowledged: ["fixed", "dismissed"],
        fixed: [],
        dismissed: []
      };
      if (!allowed[existing.status].includes(status)) throw new InvalidFeedbackTransitionError();
      const { rows } = await client.query<FeedbackRow>(
        `UPDATE agent_feedback SET status = $3, updated_at = now()
         WHERE workspace_id = $1 AND id = $2
         RETURNING id, workspace_id, release_id, query, reason, expected, citations, status,
                   rebuild_build_id, created_at, updated_at`,
        [workspaceId, feedbackId, status]
      );
      const feedback = feedbackRecord(rows[0]);
      await this.insertAudit(client, {
        workspaceId,
        actorId,
        action: "feedback.transitioned",
        resourceType: "agent_feedback",
        resourceId: feedback.id,
        metadata: { status }
      });
      return feedback;
    });
  }

  async markFeedbackRebuild(
    workspaceId: string,
    feedbackId: string,
    buildId: string
  ): Promise<AgentFeedbackRecord | null> {
    const { rows } = await this.pool.query<FeedbackRow>(
      `UPDATE agent_feedback SET rebuild_build_id = $3, updated_at = now()
       WHERE workspace_id = $1 AND id = $2 AND status = 'acknowledged'
       RETURNING id, workspace_id, release_id, query, reason, expected, citations, status,
                 rebuild_build_id, created_at, updated_at`,
      [workspaceId, feedbackId, buildId]
    );
    return rows[0] ? feedbackRecord(rows[0]) : null;
  }

  async requestFeedbackRebuildWithAudit(
    input: FeedbackRebuildInput
  ): Promise<{ build: BuildRecord; created: boolean }> {
    return this.transaction(async (client) => {
      const selected = await client.query<FeedbackRow>(
        `SELECT id, workspace_id, release_id, query, reason, expected, citations, status,
                rebuild_build_id, created_at, updated_at
         FROM agent_feedback WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
        [input.workspaceId, input.feedbackId]
      );
      if (!selected.rows[0] || selected.rows[0].status !== "acknowledged") {
        throw new FeedbackNotAcknowledgedError();
      }
      const feedback = feedbackRecord(selected.rows[0]);
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
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.build.repositoryId]);
      const active = await client.query<BuildRow>(
        `SELECT id, workspace_id, repository_id, snapshot_id, snapshot_path, commit_sha,
                status, warnings, cancel_requested, error_message,
                purpose, feedback_ids, feedback_context, remediation_context, allow_llm
         FROM build_jobs
         WHERE workspace_id = $1 AND repository_id = $2
           AND snapshot_id = $3 AND purpose = 'feedback' AND feedback_ids = $4::uuid[]
           AND status NOT IN ('ready', 'published', 'failed')
         ORDER BY created_at DESC LIMIT 1`,
        [input.workspaceId, input.build.repositoryId, input.build.snapshotId, purpose.feedbackIds]
      );
      let build: BuildRecord;
      let created = false;
      if (active.rows[0]) {
        build = buildRecord(active.rows[0]);
      } else {
        const inserted = await client.query<BuildRow>(
          `INSERT INTO build_jobs
           (workspace_id, repository_id, snapshot_id, snapshot_path, commit_sha, status,
            purpose, feedback_ids, feedback_context)
           VALUES ($1, $2, $3, $4, $5, 'queued', 'feedback', $6::uuid[], $7::jsonb)
           RETURNING id, workspace_id, repository_id, snapshot_id, snapshot_path, commit_sha,
                     status, warnings, cancel_requested, error_message,
                     purpose, feedback_ids, feedback_context, remediation_context, allow_llm`,
          [
            input.build.workspaceId,
            input.build.repositoryId,
            input.build.snapshotId,
            input.build.snapshotPath,
            input.build.commitSha,
            purpose.feedbackIds,
            JSON.stringify(purpose.feedbackContext)
          ]
        );
        build = buildRecord(inserted.rows[0]);
        created = true;
        await client.query(
          `INSERT INTO build_events (workspace_id, build_job_id, status)
           VALUES ($1, $2, 'queued')`,
          [build.workspaceId, build.id]
        );
      }
      await client.query(
        `UPDATE agent_feedback SET rebuild_build_id = $3, updated_at = now()
         WHERE workspace_id = $1 AND id = $2`,
        [input.workspaceId, input.feedbackId, build.id]
      );
      await this.insertAudit(client, {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        action: "feedback.rebuild_requested",
        resourceType: "agent_feedback",
        resourceId: input.feedbackId,
        metadata: { buildId: build.id, releaseId: input.releaseId }
      });
      return { build, created };
    });
  }

  async createRemediation(input: CreateRemediationInput): Promise<RemediationRecord> {
    return this.transaction(async (client) => {
      const owner = await client.query(
        `SELECT 1 FROM build_jobs build
         JOIN repositories repository
           ON repository.id = build.repository_id AND repository.workspace_id = build.workspace_id
         WHERE build.workspace_id = $1 AND build.id = $4
           AND repository.id = $3 AND repository.project_id = $2`,
        [input.workspaceId, input.projectId, input.repositoryId, input.sourceBuildId]
      );
      if (owner.rowCount !== 1) throw new Error("Remediation source does not match project");
      const { rows } = await client.query<RemediationRow>(
        `INSERT INTO remediation_cases
         (workspace_id, project_id, repository_id, source_build_id, issue_id, issue, state)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'open')
         ON CONFLICT (workspace_id, source_build_id, issue_id) DO NOTHING
         RETURNING id, workspace_id, project_id, repository_id, source_build_id, issue, state,
                   rebuild_build_id, created_at, updated_at`,
        [
          input.workspaceId,
          input.projectId,
          input.repositoryId,
          input.sourceBuildId,
          input.issue.id,
          JSON.stringify(input.issue)
        ]
      );
      if (rows[0]) return remediationRecord(rows[0]);
      const existing = await client.query<RemediationRow>(
        `SELECT id, workspace_id, project_id, repository_id, source_build_id, issue, state,
                rebuild_build_id, created_at, updated_at
         FROM remediation_cases
         WHERE workspace_id = $1 AND project_id = $2 AND repository_id = $3
           AND source_build_id = $4 AND issue_id = $5`,
        [input.workspaceId, input.projectId, input.repositoryId, input.sourceBuildId, input.issue.id]
      );
      if (!existing.rows[0]) throw new Error("Remediation case was not persisted");
      return remediationRecord(existing.rows[0]);
    });
  }

  async getRemediation(workspaceId: string, remediationId: string): Promise<RemediationRecord | null> {
    const { rows } = await this.pool.query<RemediationRow>(
      `SELECT id, workspace_id, project_id, repository_id, source_build_id, issue, state,
              rebuild_build_id, created_at, updated_at
       FROM remediation_cases WHERE workspace_id = $1 AND id = $2 LIMIT 1`,
      [workspaceId, remediationId]
    );
    return rows[0] ? remediationRecord(rows[0]) : null;
  }

  async listRemediations(
    workspaceId: string,
    projectId: string,
    options?: RemediationListOptions
  ): Promise<RemediationRecord[]> {
    const { limit, offset } = normalizePagination(options);
    const { rows } = await this.pool.query<RemediationRow>(
      `SELECT id, workspace_id, project_id, repository_id, source_build_id, issue, state,
              rebuild_build_id, created_at, updated_at
       FROM remediation_cases
       WHERE workspace_id = $1
         AND project_id = $2
         AND ($3::text IS NULL OR state = $3)
         AND ($4::text IS NULL OR issue->>'severity' = $4)
         AND ($5::text IS NULL OR issue->>'rule' = $5)
       ORDER BY created_at DESC, id DESC LIMIT $6 OFFSET $7`,
      [workspaceId, projectId, options?.state ?? null, options?.severity ?? null, options?.rule ?? null, limit, offset]
    );
    return rows.map(remediationRecord);
  }

  async countRemediations(
    workspaceId: string,
    projectId: string,
    state?: RemediationState
  ): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM remediation_cases
       WHERE workspace_id = $1 AND project_id = $2 AND ($3::text IS NULL OR state = $3)`,
      [workspaceId, projectId, state ?? null]
    );
    return Number(rows[0]?.total ?? 0);
  }

  async listRemediationEvents(workspaceId: string, remediationId: string): Promise<RemediationEventRecord[]> {
    const { rows } = await this.pool.query<RemediationEventRow>(
      `SELECT id, workspace_id, remediation_id, from_state, to_state, actor_id, created_at
       FROM remediation_events
       WHERE workspace_id = $1 AND remediation_id = $2
       ORDER BY sequence ASC`,
      [workspaceId, remediationId]
    );
    return rows.map(remediationEventRecord);
  }

  async transitionRemediationWithAudit(
    workspaceId: string,
    remediationId: string,
    state: RemediationState,
    actorId: string
  ): Promise<RemediationRecord | null> {
    return this.transaction(async (client) => {
      const selected = await client.query<RemediationRow>(
        `SELECT id, workspace_id, project_id, repository_id, source_build_id, issue, state,
                rebuild_build_id, created_at, updated_at
         FROM remediation_cases WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
        [workspaceId, remediationId]
      );
      const existing = selected.rows[0];
      if (!existing) return null;
      transitionRemediation(existing.state, state);
      const updated = await client.query<RemediationRow>(
        `UPDATE remediation_cases SET state = $3, updated_at = now()
         WHERE workspace_id = $1 AND id = $2
         RETURNING id, workspace_id, project_id, repository_id, source_build_id, issue, state,
                   rebuild_build_id, created_at, updated_at`,
        [workspaceId, remediationId, state]
      );
      const remediation = remediationRecord(updated.rows[0]);
      await client.query(
        `INSERT INTO remediation_events (workspace_id, remediation_id, from_state, to_state, actor_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [workspaceId, remediationId, existing.state, state, actorId]
      );
      await this.insertAudit(client, {
        workspaceId, actorId, action: "remediation.transitioned", resourceType: "remediation",
        resourceId: remediationId, metadata: { fromState: existing.state, toState: state }
      });
      return remediation;
    });
  }

  async requestRemediationBuildWithAudit(
    input: RemediationBuildInput
  ): Promise<{ build: BuildRecord; created: boolean }> {
    return this.transaction(async (client) => {
      const selected = await client.query<RemediationRow>(
        `SELECT id, workspace_id, project_id, repository_id, source_build_id, issue, state,
                rebuild_build_id, created_at, updated_at
         FROM remediation_cases WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
        [input.workspaceId, input.remediationId]
      );
      const selectedRow = selected.rows[0];
      if (!selectedRow || selectedRow.state !== "accepted") throw new Error("Remediation must be accepted first");
      const remediation = remediationRecord(selectedRow);
      if (input.build.workspaceId !== remediation.workspaceId || input.build.repositoryId !== remediation.repositoryId) {
        throw new Error("Remediation build does not match source project");
      }
      const purpose = {
        kind: "remediation" as const,
        feedbackIds: [] as [],
        feedbackContext: [] as [],
        remediationContext: [{
          remediationId: remediation.id,
          issueId: remediation.issue.id,
          sourceRefs: remediation.issue.sourceRefs
        }]
      };
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.build.repositoryId]);
      const active = await client.query<BuildRow>(
        `SELECT id, workspace_id, repository_id, snapshot_id, snapshot_path, commit_sha,
                status, warnings, cancel_requested, error_message,
                purpose, feedback_ids, feedback_context, remediation_context, allow_llm
         FROM build_jobs
         WHERE workspace_id = $1 AND repository_id = $2 AND snapshot_id = $3
           AND purpose = 'remediation' AND remediation_context = $4::jsonb
           AND status NOT IN ('ready', 'published', 'failed')
         ORDER BY created_at DESC LIMIT 1`,
        [input.workspaceId, input.build.repositoryId, input.build.snapshotId, JSON.stringify(purpose.remediationContext)]
      );
      let build: BuildRecord;
      let created = false;
      if (active.rows[0]) {
        build = buildRecord(active.rows[0]);
      } else {
        const inserted = await client.query<BuildRow>(
          `INSERT INTO build_jobs
           (workspace_id, repository_id, snapshot_id, snapshot_path, commit_sha, status,
            purpose, feedback_ids, feedback_context, remediation_context)
           VALUES ($1, $2, $3, $4, $5, 'queued', 'remediation', '{}'::uuid[], '[]'::jsonb, $6::jsonb)
           RETURNING id, workspace_id, repository_id, snapshot_id, snapshot_path, commit_sha,
                     status, warnings, cancel_requested, error_message,
                     purpose, feedback_ids, feedback_context, remediation_context, allow_llm`,
          [
            input.build.workspaceId,
            input.build.repositoryId,
            input.build.snapshotId,
            input.build.snapshotPath,
            input.build.commitSha,
            JSON.stringify(purpose.remediationContext)
          ]
        );
        build = buildRecord(inserted.rows[0]);
        created = true;
        await client.query(
          `INSERT INTO build_events (workspace_id, build_job_id, status)
           VALUES ($1, $2, 'queued')`,
          [build.workspaceId, build.id]
        );
      }
      await client.query(
        `UPDATE remediation_cases
         SET state = 'rebuilding', rebuild_build_id = $3, updated_at = now()
         WHERE workspace_id = $1 AND id = $2`,
        [input.workspaceId, remediation.id, build.id]
      );
      await client.query(
        `INSERT INTO remediation_events (workspace_id, remediation_id, from_state, to_state, actor_id)
         VALUES ($1, $2, 'accepted', 'rebuilding', $3)`,
        [input.workspaceId, remediation.id, input.actorId]
      );
      await this.insertAudit(client, {
        workspaceId: input.workspaceId, actorId: input.actorId,
        action: "remediation.rebuild_requested", resourceType: "remediation",
        resourceId: remediation.id, metadata: { buildId: build.id, issueId: remediation.issue.id }
      });
      return { build, created };
    });
  }

  async createRepository(
    workspaceId: string,
    input: RepositoryConnectionInput,
    projectId?: string
  ): Promise<RepositoryRecord | null> {
    return this.transaction((client) => this.insertRepository(client, workspaceId, input, null, projectId));
  }

  private async insertRepository(
    client: Queryable,
    workspaceId: string,
    input: RepositoryConnectionInput,
    archivedAt: Date | null = null,
    requestedProjectId?: string
  ): Promise<RepositoryRecord | null> {
    const projects = await client.query<{ id: string }>(
      `SELECT id FROM projects
       WHERE workspace_id = $1 AND archived_at IS NULL
         AND ($2::uuid IS NULL OR id = $2)
       ORDER BY created_at ASC, id ASC LIMIT 1`,
      [workspaceId, requestedProjectId ?? null]
    );
    const project = projects.rows[0];
    if (!project) return null;
    const result = await client.query<RepositoryRow>(
        `INSERT INTO repositories (workspace_id, project_id, kind, name, local_path, clone_url, archived_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (project_id) WHERE archived_at IS NULL DO NOTHING
         RETURNING id, workspace_id, project_id, kind, name, local_path, clone_url, default_branch, archived_at`,
        [
          workspaceId,
          project.id,
          input.kind,
          input.name,
          input.kind === "local" ? input.path : null,
          input.kind === "git" ? input.url : null,
          archivedAt
        ]
      );
    const row = result.rows[0];
    if (!row) return null;
    const encryptedToken = input.kind === "git" ? input.encryptedToken : undefined;
    if (encryptedToken) {
      await client.query(
        `INSERT INTO encrypted_credentials (workspace_id, repository_id, name, ciphertext)
         VALUES ($1, $2, $3, $4)`,
        [workspaceId, row.id, "repository-pat", encryptedToken]
      );
    }
    return repositoryRecord({ ...row, has_credential: Boolean(encryptedToken) });
  }

  async createRepositoryWithAudit(
    workspaceId: string,
    input: RepositoryConnectionInput,
    actorId: string,
    projectId?: string
  ): Promise<RepositoryRecord | null> {
    return this.transaction(async (client) => {
      const repository = await this.insertRepository(client, workspaceId, input, null, projectId);
      if (!repository) return null;
      await this.insertAudit(client, {
        workspaceId,
        actorId,
        action: "repository.connected",
        resourceType: "repository",
        resourceId: repository.id,
        metadata: { kind: repository.kind }
      });
      return repository;
    });
  }

  async currentRepository(workspaceId: string, projectId?: string): Promise<RepositoryRecord | null> {
    const { rows } = await this.pool.query<RepositoryRow>(
      `SELECT r.id, r.workspace_id, r.project_id, r.kind, r.name, r.local_path, r.clone_url,
              r.default_branch, r.archived_at,
              EXISTS (
                SELECT 1 FROM encrypted_credentials c
                WHERE c.workspace_id = r.workspace_id AND c.repository_id = r.id
              ) AS has_credential
       FROM repositories r WHERE r.workspace_id = $1 AND r.archived_at IS NULL
         AND ($2::uuid IS NULL OR r.project_id = $2) LIMIT 1`,
      [workspaceId, projectId ?? null]
    );
    return rows[0] ? repositoryRecord(rows[0]) : null;
  }

  async listActiveGitRepositories(): Promise<RepositoryRecord[]> {
    const { rows } = await this.pool.query<RepositoryRow>(
      `SELECT r.id, r.workspace_id, r.project_id, r.kind, r.name, r.local_path, r.clone_url,
              r.default_branch, r.archived_at,
              EXISTS (
                SELECT 1 FROM encrypted_credentials c
                WHERE c.workspace_id = r.workspace_id AND c.repository_id = r.id
              ) AS has_credential
       FROM repositories r WHERE r.kind = 'git' AND r.archived_at IS NULL
       ORDER BY r.workspace_id, r.project_id, r.id`
    );
    return rows.map(repositoryRecord);
  }

  async getRepository(workspaceId: string, repositoryId: string): Promise<RepositoryRecord | null> {
    const { rows } = await this.pool.query<RepositoryRow>(
      `SELECT r.id, r.workspace_id, r.project_id, r.kind, r.name, r.local_path, r.clone_url,
              r.default_branch, r.archived_at,
              EXISTS (
                SELECT 1 FROM encrypted_credentials c
                WHERE c.workspace_id = r.workspace_id AND c.repository_id = r.id
              ) AS has_credential
       FROM repositories r WHERE r.workspace_id = $1 AND r.id = $2 LIMIT 1`,
      [workspaceId, repositoryId]
    );
    return rows[0] ? repositoryRecord(rows[0]) : null;
  }

  async listArchivedRepositories(workspaceId: string): Promise<RepositoryRecord[]> {
    const { rows } = await this.pool.query<RepositoryRow>(
      `SELECT r.id, r.workspace_id, r.project_id, r.kind, r.name, r.local_path, r.clone_url,
              r.default_branch, r.archived_at,
              EXISTS (
                SELECT 1 FROM encrypted_credentials c
                WHERE c.workspace_id = r.workspace_id AND c.repository_id = r.id
              ) AS has_credential
       FROM repositories r
       WHERE r.workspace_id = $1 AND r.archived_at IS NOT NULL
       ORDER BY r.archived_at DESC, r.id DESC`,
      [workspaceId]
    );
    return rows.map(repositoryRecord);
  }

  async switchRepositoryWithAudit(
    workspaceId: string,
    input: RepositoryConnectionInput,
    actorId: string
  ): Promise<RepositoryRecord | null> {
    return this.transaction(async (client) => {
      const selected = await client.query<RepositoryRow>(
        `SELECT r.id, r.workspace_id, r.project_id, r.kind, r.name, r.local_path, r.clone_url,
                r.default_branch, r.archived_at,
                EXISTS (
                  SELECT 1 FROM encrypted_credentials c
                  WHERE c.workspace_id = r.workspace_id AND c.repository_id = r.id
                ) AS has_credential
         FROM repositories r
         WHERE r.workspace_id = $1 AND r.archived_at IS NULL
         FOR UPDATE`,
        [workspaceId]
      );
      const currentRow = selected.rows[0];
      if (!currentRow) return null;
      const current = repositoryRecord(currentRow);
      const replacement = await this.insertRepository(client, workspaceId, input, new Date());
      if (!replacement) return null;
      await client.query(
        `UPDATE repositories SET archived_at = now(), updated_at = now()
         WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
        [current.id, workspaceId]
      );
      await client.query(
        `UPDATE repositories SET archived_at = NULL, updated_at = now()
         WHERE id = $1 AND workspace_id = $2 AND archived_at IS NOT NULL`,
        [replacement.id, workspaceId]
      );
      await this.insertAudit(client, {
        workspaceId,
        actorId,
        action: "repository.switched",
        resourceType: "repository",
        resourceId: replacement.id,
        metadata: { oldRepositoryId: current.id, newRepositoryId: replacement.id }
      });
      return { ...replacement, archivedAt: null };
    });
  }

  async prepareUploadReplacementWithAudit(
    workspaceId: string,
    name: string,
    actorId: string
  ): Promise<RepositoryRecord | null> {
    return this.transaction(async (client) => {
      const current = await client.query<{ id: string }>(
        `SELECT id FROM repositories
         WHERE workspace_id = $1 AND archived_at IS NULL FOR UPDATE`,
        [workspaceId]
      );
      if (!current.rows[0]) return null;
      const candidate = await this.insertRepository(
        client,
        workspaceId,
        { kind: "upload", name },
        new Date()
      );
      if (!candidate) return null;
      await this.insertAudit(client, {
        workspaceId,
        actorId,
        action: "repository.upload_replacement_prepared",
        resourceType: "repository",
        resourceId: candidate.id,
        metadata: { kind: "upload" }
      });
      return candidate;
    });
  }

  async activateUploadReplacementWithAudit(
    workspaceId: string,
    repositoryId: string,
    actorId: string
  ): Promise<RepositoryRecord | null> {
    return this.transaction(async (client) => {
      const current = await client.query<RepositoryRow>(
        `SELECT r.id, r.workspace_id, r.project_id, r.kind, r.name, r.local_path, r.clone_url,
                r.default_branch, r.archived_at, false AS has_credential
         FROM repositories r
         WHERE r.workspace_id = $1 AND r.archived_at IS NULL FOR UPDATE`,
        [workspaceId]
      );
      const candidate = await client.query<RepositoryRow>(
        `SELECT r.id, r.workspace_id, r.project_id, r.kind, r.name, r.local_path, r.clone_url,
                r.default_branch, r.archived_at, false AS has_credential
         FROM repositories r
         WHERE r.workspace_id = $1 AND r.id = $2 AND r.kind = 'upload'
           AND r.archived_at IS NOT NULL FOR UPDATE`,
        [workspaceId, repositoryId]
      );
      if (!current.rows[0] || !candidate.rows[0]) return null;
      await client.query(
        `UPDATE repositories SET archived_at = now(), updated_at = now()
         WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
        [current.rows[0].id, workspaceId]
      );
      const promoted = await client.query<RepositoryRow>(
        `UPDATE repositories SET archived_at = NULL, updated_at = now()
         WHERE id = $1 AND workspace_id = $2 AND archived_at IS NOT NULL
         RETURNING id, workspace_id, project_id, kind, name, local_path, clone_url,
                   default_branch, archived_at`,
        [repositoryId, workspaceId]
      );
      const replacement = promoted.rows[0];
      if (!replacement) throw new Error("Upload replacement promotion failed");
      await this.insertAudit(client, {
        workspaceId,
        actorId,
        action: "repository.switched",
        resourceType: "repository",
        resourceId: repositoryId,
        metadata: { oldRepositoryId: current.rows[0].id, newRepositoryId: repositoryId }
      });
      return repositoryRecord({ ...replacement, has_credential: false });
    });
  }

  async discardPendingUploadReplacement(workspaceId: string, repositoryId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM repositories r
       WHERE r.workspace_id = $1 AND r.id = $2 AND r.kind = 'upload'
         AND r.archived_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM source_snapshots s WHERE s.repository_id = r.id)`,
      [workspaceId, repositoryId]
    );
  }

  async findSnapshotByCommit(
    workspaceId: string,
    repositoryId: string,
    commitSha: string
  ): Promise<SourceSnapshotRecord | null> {
    const { rows } = await this.pool.query<SnapshotRow>(
      `SELECT id, workspace_id, repository_id, commit_sha, ref, remote_url,
              commit_timestamp, storage_path
       FROM source_snapshots
       WHERE workspace_id = $1 AND repository_id = $2 AND commit_sha = $3`,
      [workspaceId, repositoryId, commitSha]
    );
    return rows[0] ? snapshotRecord(rows[0]) : null;
  }

  async findSnapshotById(workspaceId: string, snapshotId: string): Promise<SourceSnapshotRecord | null> {
    const { rows } = await this.pool.query<SnapshotRow>(
      `SELECT id, workspace_id, repository_id, commit_sha, ref, remote_url,
              commit_timestamp, storage_path
       FROM source_snapshots WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, snapshotId]
    );
    return rows[0] ? snapshotRecord(rows[0]) : null;
  }

  async listSnapshotFiles(workspaceId: string, snapshotId: string): Promise<SourceFileRecord[]> {
    const { rows } = await this.pool.query<{
      id: string; workspace_id: string; snapshot_id: string; path: string;
      byte_size: number; content_hash: string; language: string | null;
    }>(
      `SELECT id, workspace_id, snapshot_id, path, byte_size, content_hash, language
       FROM source_files WHERE workspace_id = $1 AND snapshot_id = $2
       ORDER BY path, id`,
      [workspaceId, snapshotId]
    );
    return rows.map((row) => ({
      id: row.id, workspaceId: row.workspace_id, snapshotId: row.snapshot_id,
      path: row.path, byteSize: row.byte_size, contentHash: row.content_hash, language: row.language
    }));
  }

  async latestSnapshot(workspaceId: string, repositoryId: string): Promise<SourceSnapshotRecord | null> {
    const { rows } = await this.pool.query<SnapshotRow>(
      `SELECT id, workspace_id, repository_id, commit_sha, ref, remote_url,
              commit_timestamp, storage_path
       FROM source_snapshots WHERE workspace_id = $1 AND repository_id = $2
       ORDER BY commit_timestamp DESC, created_at DESC, id DESC LIMIT 1`,
      [workspaceId, repositoryId]
    );
    return rows[0] ? snapshotRecord(rows[0]) : null;
  }

  async snapshotChangeSummary(workspaceId: string, repositoryId: string, snapshotId: string) {
    const { rows } = await this.pool.query<{ previous_snapshot_id: string | null; added: string[]; modified: string[]; deleted: string[] }>(
      `WITH current_snapshot AS (
         SELECT id, repository_id, commit_timestamp, created_at FROM source_snapshots
         WHERE workspace_id = $1 AND repository_id = $2 AND id = $3
       ), previous_snapshot AS (
         SELECT s.id FROM source_snapshots s JOIN current_snapshot c ON c.repository_id = s.repository_id
         WHERE s.workspace_id = $1 AND (s.commit_timestamp, s.created_at, s.id) < (c.commit_timestamp, c.created_at, c.id)
         ORDER BY s.commit_timestamp DESC, s.created_at DESC, s.id DESC LIMIT 1
       ), current_files AS (
         SELECT path, content_hash FROM source_files
         WHERE snapshot_id = (SELECT id FROM current_snapshot)
       ), previous_files AS (
         SELECT path, content_hash FROM source_files
         WHERE snapshot_id = (SELECT id FROM previous_snapshot)
       )
       SELECT (SELECT id FROM previous_snapshot) AS previous_snapshot_id,
         coalesce((SELECT array_agg(c.path ORDER BY c.path)
           FROM current_files c LEFT JOIN previous_files p ON p.path = c.path
           WHERE p.path IS NULL), '{}'::text[]) AS added,
         coalesce((SELECT array_agg(c.path ORDER BY c.path)
           FROM current_files c JOIN previous_files p ON p.path = c.path
           WHERE c.content_hash <> p.content_hash), '{}'::text[]) AS modified,
         coalesce((SELECT array_agg(p.path ORDER BY p.path)
           FROM previous_files p LEFT JOIN current_files c ON c.path = p.path
           WHERE c.path IS NULL), '{}'::text[]) AS deleted
       FROM current_snapshot`,
      [workspaceId, repositoryId, snapshotId]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      snapshotId, previousSnapshotId: row.previous_snapshot_id, added: row.added ?? [], modified: row.modified ?? [], deleted: row.deleted ?? [],
      requiresBuild: (row.added?.length ?? 0) + (row.modified?.length ?? 0) + (row.deleted?.length ?? 0) > 0,
      affectedModules: [], suggestedTests: []
    };
  }

  async findSourceFile(workspaceId: string, snapshotId: string, filePath: string) {
    const { rows } = await this.pool.query<{
      id: string; workspace_id: string; snapshot_id: string; path: string;
      byte_size: number; content_hash: string; language: string | null;
    }>(
      `SELECT id, workspace_id, snapshot_id, path, byte_size, content_hash, language
       FROM source_files WHERE workspace_id = $1 AND snapshot_id = $2 AND path = $3`,
      [workspaceId, snapshotId, filePath]
    );
    const row = rows[0];
    return row ? {
      id: row.id, workspaceId: row.workspace_id, snapshotId: row.snapshot_id,
      path: row.path, byteSize: row.byte_size, contentHash: row.content_hash, language: row.language
    } : null;
  }

  private async insertSnapshot(
    client: Queryable,
    { snapshot, files }: CreateSnapshotInput
  ): Promise<{ snapshot: SourceSnapshotRecord; inserted: boolean }> {
      const inserted = await client.query<SnapshotRow>(
        `INSERT INTO source_snapshots
         (id, workspace_id, repository_id, commit_sha, ref, remote_url, commit_timestamp, storage_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (repository_id, commit_sha) DO NOTHING
         RETURNING id, workspace_id, repository_id, commit_sha, ref, remote_url,
                   commit_timestamp, storage_path`,
        [
          snapshot.id,
          snapshot.workspaceId,
          snapshot.repositoryId,
          snapshot.commitSha,
          snapshot.ref,
          snapshot.remoteUrl,
          snapshot.commitTimestamp,
          snapshot.storagePath
        ]
      );
      const insertedSnapshot = inserted.rows[0];
      if (!insertedSnapshot) {
        const existing = await client.query<SnapshotRow>(
          `SELECT id, workspace_id, repository_id, commit_sha, ref, remote_url,
                  commit_timestamp, storage_path
           FROM source_snapshots
           WHERE workspace_id = $1 AND repository_id = $2 AND commit_sha = $3`,
          [snapshot.workspaceId, snapshot.repositoryId, snapshot.commitSha]
        );
        if (!existing.rows[0]) throw new Error("Snapshot conflict winner was not found");
        return { snapshot: snapshotRecord(existing.rows[0]), inserted: false };
      }
      for (const file of files) {
        await client.query(
          `INSERT INTO source_files
           (id, workspace_id, snapshot_id, path, language, content_hash, byte_size)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            file.id,
            file.workspaceId,
            file.snapshotId,
            file.path,
            file.language,
            file.contentHash,
            file.byteSize
          ]
        );
      }
      return { snapshot: snapshotRecord(insertedSnapshot), inserted: true };
  }

  async createSnapshot(input: CreateSnapshotInput): Promise<SourceSnapshotRecord> {
    return this.transaction(async (client) => (await this.insertSnapshot(client, input)).snapshot);
  }

  async createSnapshotWithAudit(
    input: CreateSnapshotInput,
    actorId: string
  ): Promise<SourceSnapshotRecord> {
    return this.transaction(async (client) => {
      const persisted = await this.insertSnapshot(client, input);
      await this.insertAudit(client, {
        workspaceId: input.snapshot.workspaceId,
        actorId,
        action: "repository.sync_succeeded",
        resourceType: "repository",
        resourceId: input.snapshot.repositoryId,
        metadata: {
          commitSha: persisted.snapshot.commitSha,
          unchanged: !persisted.inserted
        }
      });
      return persisted.snapshot;
    });
  }

  async countSnapshotFiles(snapshotId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM source_files WHERE snapshot_id = $1",
      [snapshotId]
    );
    return Number(rows[0]?.count ?? 0);
  }

  async snapshotTextBytes(snapshotId: string): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      "SELECT coalesce(sum(byte_size), 0)::text AS total FROM source_files WHERE snapshot_id = $1",
      [snapshotId]
    );
    return Number(rows[0]?.total ?? 0);
  }

  async sourceFileHashes(workspaceId: string, snapshotId: string): Promise<ReadonlyMap<string, string>> {
    const { rows } = await this.pool.query<{ path: string; content_hash: string }>(
      `SELECT path, content_hash FROM source_files
       WHERE workspace_id = $1 AND snapshot_id = $2 ORDER BY path`,
      [workspaceId, snapshotId]
    );
    return new Map(rows.map((row) => [row.path, row.content_hash]));
  }

  async snapshotFileMetadata(workspaceId: string, snapshotId: string) {
    const { rows } = await this.pool.query<{ path: string; byte_size: string; content_hash: string }>(
      `SELECT path, byte_size::text AS byte_size, content_hash FROM source_files
       WHERE workspace_id = $1 AND snapshot_id = $2 ORDER BY path`,
      [workspaceId, snapshotId]
    );
    return rows.map((row) => ({
      path: row.path,
      byteSize: Number(row.byte_size),
      contentHash: row.content_hash
    }));
  }

  async repositoryCredential(workspaceId: string, repositoryId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ ciphertext: string }>(
      `SELECT ciphertext FROM encrypted_credentials
       WHERE workspace_id = $1 AND repository_id = $2 AND name = 'repository-pat'`,
      [workspaceId, repositoryId]
    );
    return rows[0]?.ciphertext ?? null;
  }

  async getModelConfig(workspaceId: string): Promise<ModelConfigRecord | null> {
    const { rows } = await this.pool.query<{
      ciphertext: string;
      metadata: { provider?: string; model?: string };
    }>(
      `SELECT ciphertext, metadata FROM encrypted_credentials
       WHERE workspace_id = $1 AND repository_id IS NULL AND name = 'model-provider'`,
      [workspaceId]
    );
    const row = rows[0];
    if (!row?.metadata.provider || !row.metadata.model) return null;
    return {
      workspaceId,
      provider: row.metadata.provider as ModelProvider,
      model: row.metadata.model,
      encryptedApiKey: row.ciphertext
    };
  }

  async upsertModelConfig(
    workspaceId: string,
    input: { provider: ModelProvider; model: string; encryptedApiKey?: string },
    actorId: string
  ): Promise<ModelConfigRecord> {
    return this.transaction(async (client) => {
      const existing = await client.query<{ id: string; ciphertext: string }>(
        `SELECT id, ciphertext FROM encrypted_credentials
         WHERE workspace_id = $1 AND repository_id IS NULL AND name = 'model-provider'
         FOR UPDATE`,
        [workspaceId]
      );
      if (!existing.rows[0] && !input.encryptedApiKey) throw new Error("An API key is required");
      const metadata = JSON.stringify({ provider: input.provider, model: input.model });
      if (existing.rows[0]) {
        await client.query(
          `UPDATE encrypted_credentials
           SET ciphertext = COALESCE($2, ciphertext), metadata = $3::jsonb, updated_at = now()
           WHERE workspace_id = $1 AND id = $4`,
          [workspaceId, input.encryptedApiKey ?? null, metadata, existing.rows[0].id]
        );
      } else {
        await client.query(
          `INSERT INTO encrypted_credentials
           (workspace_id, repository_id, name, ciphertext, metadata)
           VALUES ($1, NULL, 'model-provider', $2, $3::jsonb)`,
          [workspaceId, input.encryptedApiKey, metadata]
        );
      }
      await this.insertAudit(client, {
        workspaceId, actorId, action: "model_config.updated", resourceType: "model_config",
        metadata: { provider: input.provider, model: input.model }
      });
      return {
        workspaceId, provider: input.provider, model: input.model,
        encryptedApiKey: input.encryptedApiKey ?? existing.rows[0].ciphertext
      };
    });
  }

  async createBuild(
    input: BuildInput
  ): Promise<{ build: BuildRecord; created: boolean }> {
    const purpose = input.purpose ?? standardBuildPurpose();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.repositoryId]);
      const active = await client.query<BuildRow>(
        `SELECT id, workspace_id, repository_id, snapshot_id, snapshot_path, commit_sha,
                status, warnings, cancel_requested, error_message,
                purpose, feedback_ids, feedback_context, remediation_context, allow_llm
         FROM build_jobs
         WHERE workspace_id = $1 AND repository_id = $2
           AND snapshot_id = $3 AND purpose = $4 AND feedback_ids = $5::uuid[]
           AND remediation_context = $6::jsonb AND allow_llm = $7
           AND status NOT IN ('ready', 'published', 'failed')
         ORDER BY created_at DESC LIMIT 1`,
        [
          input.workspaceId,
          input.repositoryId,
          input.snapshotId,
          purpose.kind,
          purpose.feedbackIds,
          JSON.stringify(purpose.remediationContext ?? []),
          input.allowLlm === true
        ]
      );
      if (active.rows[0]) {
        await client.query("COMMIT");
        return { build: buildRecord(active.rows[0]), created: false };
      }
      const inserted = await client.query<BuildRow>(
        `INSERT INTO build_jobs
         (workspace_id, repository_id, snapshot_id, snapshot_path, commit_sha, status,
          purpose, feedback_ids, feedback_context, remediation_context, allow_llm)
         VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7::uuid[], $8::jsonb, $9::jsonb, $10)
         RETURNING id, workspace_id, repository_id, snapshot_id, snapshot_path, commit_sha,
                   status, warnings, cancel_requested, error_message,
                     purpose, feedback_ids, feedback_context, remediation_context, allow_llm`,
        [
          input.workspaceId,
          input.repositoryId,
          input.snapshotId,
          input.snapshotPath,
          input.commitSha,
          purpose.kind,
          purpose.feedbackIds,
          JSON.stringify(purpose.feedbackContext),
          JSON.stringify(purpose.remediationContext ?? []),
          input.allowLlm === true
        ]
      );
      const build = buildRecord(inserted.rows[0]);
      await client.query(
        `INSERT INTO build_events (workspace_id, build_job_id, status)
         VALUES ($1, $2, 'queued')`,
        [build.workspaceId, build.id]
      );
      if (input.llmAudit) {
        await this.insertAudit(client, {
          workspaceId: build.workspaceId,
          actorId: input.llmAudit.actorId,
          action: "build.llm_opted_in",
          resourceType: "build",
          resourceId: build.id,
          metadata: { projectId: input.llmAudit.projectId, snapshotId: build.snapshotId }
        });
      }
      await client.query("COMMIT");
      return { build, created: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getBuild(workspaceId: string, buildId: string): Promise<BuildRecord | null> {
    const { rows } = await this.pool.query<BuildRow>(
      `SELECT id, workspace_id, repository_id, snapshot_id, snapshot_path, commit_sha,
              status, warnings, cancel_requested, error_message,
                purpose, feedback_ids, feedback_context, remediation_context, allow_llm
       FROM build_jobs WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, buildId]
    );
    return rows[0] ? buildRecord(rows[0]) : null;
  }

  async claimBuild(buildId: string): Promise<BuildRecord | null> {
    return this.transaction(async (client) => {
      const candidate = await client.query<Pick<BuildRow, "workspace_id" | "repository_id">>(
        `SELECT workspace_id, repository_id
         FROM build_jobs
         WHERE id = $1 AND status = 'queued'
         FOR UPDATE`,
        [buildId]
      );
      if (!candidate.rows[0]) return null;
      const { workspace_id: workspaceId, repository_id: repositoryId } = candidate.rows[0];
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`${workspaceId}:${repositoryId}`]
      );
      const { rows } = await client.query<BuildRow>(
        `UPDATE build_jobs AS candidate
         SET status = 'syncing', updated_at = now()
         WHERE candidate.id = $1 AND candidate.status = 'queued'
           AND NOT EXISTS (
             SELECT 1 FROM build_jobs AS active
             WHERE active.workspace_id = candidate.workspace_id
               AND active.repository_id = candidate.repository_id
               AND active.id <> candidate.id
               AND active.status IN ('syncing', 'parsing', 'synthesizing', 'validating')
           )
         RETURNING candidate.id, candidate.workspace_id, candidate.repository_id,
                   candidate.snapshot_id, candidate.snapshot_path, candidate.commit_sha,
                   candidate.status, candidate.warnings, candidate.cancel_requested,
                   candidate.error_message, candidate.purpose, candidate.feedback_ids,
                   candidate.feedback_context, candidate.remediation_context, candidate.allow_llm`,
        [buildId]
      );
      if (!rows[0]) return null;
      await client.query(
        `INSERT INTO build_events (workspace_id, build_job_id, status)
         VALUES ($1, $2, 'syncing')`,
        [rows[0].workspace_id, rows[0].id]
      );
      return buildRecord(rows[0]);
    });
  }

  async transitionBuild(
    buildId: string,
    expectedStatus: BuildStatus,
    status: BuildStatus,
    details?: {
      errorMessage?: string;
      warnings?: BuildRecord["warnings"];
      requireNotCancelled?: boolean;
    }
  ): Promise<BuildRecord | null> {
    const { rows } = await this.pool.query<BuildRow>(
      `WITH updated AS (
         UPDATE build_jobs
         SET status = $3, error_message = COALESCE($4, error_message),
             warnings = COALESCE($5::jsonb, warnings), updated_at = now()
         WHERE id = $1 AND status = $2 AND ($7::boolean = false OR cancel_requested = false)
         RETURNING id, workspace_id, repository_id, snapshot_id, snapshot_path, commit_sha,
                   status, warnings, cancel_requested, error_message,
                   purpose, feedback_ids, feedback_context, remediation_context, allow_llm
       ), event AS (
         INSERT INTO build_events (workspace_id, build_job_id, status, payload)
         SELECT workspace_id, id, status, $6::jsonb FROM updated RETURNING id
       )
       SELECT * FROM updated`,
      [
        buildId,
        expectedStatus,
        status,
          details?.errorMessage ?? null,
          details?.warnings ? JSON.stringify(details.warnings) : null,
          JSON.stringify({
            ...(details?.errorMessage ? { errorMessage: details.errorMessage } : {}),
            ...(details?.warnings ? { warnings: details.warnings } : {})
          }),
          details?.requireNotCancelled ?? false
      ]
    );
    return rows[0] ? buildRecord(rows[0]) : null;
  }

  async transitionBuildAndCreateInitialStage(
    buildId: string,
    expectedStatus: BuildStatus,
    status: BuildStatus,
    details: {
      errorMessage?: string;
      warnings?: BuildRecord["warnings"];
      requireNotCancelled?: boolean;
    },
    stage: InitialPipelineStage
  ): Promise<{ build: BuildRecord; initialStage: { stageRunId: string; projectId: string } } | null> {
    const queued = stageRunSchema.parse({
      id: "pending",
      buildId,
      stage: "convert",
      attempt: 1,
      status: "queued",
      inputDigest: stage.inputDigest,
      outputManifestIds: [],
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorDetail: null
    });
    return this.transaction(async (client) => {
      const payload = JSON.stringify({
        ...(details.errorMessage ? { errorMessage: details.errorMessage } : {}),
        ...(details.warnings ? { warnings: details.warnings } : {})
      });
      const { rows } = await client.query<BuildRow>(
        `UPDATE build_jobs
         SET status = $3, error_message = COALESCE($4, error_message),
             warnings = COALESCE($5::jsonb, warnings), updated_at = now()
         WHERE id = $1 AND status = $2 AND ($6::boolean = false OR cancel_requested = false)
         RETURNING id, workspace_id, repository_id, snapshot_id, snapshot_path, commit_sha,
                   status, warnings, cancel_requested, error_message,
                   purpose, feedback_ids, feedback_context, remediation_context, allow_llm`,
        [
          buildId,
          expectedStatus,
          status,
          details.errorMessage ?? null,
          details.warnings ? JSON.stringify(details.warnings) : null,
          details.requireNotCancelled ?? false
        ]
      );
      if (!rows[0]) return null;
      const build = buildRecord(rows[0]);
      await client.query(
        `INSERT INTO build_events (workspace_id, build_job_id, status, payload)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [build.workspaceId, build.id, build.status, payload]
      );
      const { rows: stageRows } = await client.query<StageRunRow>(
        `WITH run AS (
           INSERT INTO build_stage_runs
             (workspace_id, project_id, snapshot_id, build_job_id, stage, attempt, status, input_digest)
           SELECT $1, repository.project_id, build.snapshot_id, build.id, $2, $3, $4, $5
           FROM build_jobs build
           JOIN repositories repository
             ON repository.id = build.repository_id AND repository.workspace_id = build.workspace_id
           JOIN source_snapshots snapshot
             ON snapshot.id = build.snapshot_id AND snapshot.workspace_id = build.workspace_id
           WHERE build.workspace_id = $1 AND build.id = $6
             AND snapshot.repository_id = build.repository_id
           ON CONFLICT (build_job_id, stage, attempt) DO UPDATE
             SET updated_at = build_stage_runs.updated_at
           RETURNING id, workspace_id, project_id, snapshot_id, build_job_id, stage, attempt, status,
                     input_digest, output_manifest_ids, started_at, finished_at, error_code, error_detail
         ), event AS (
           INSERT INTO build_stage_events
             (workspace_id, project_id, build_job_id, stage_run_id, stage, status)
           SELECT workspace_id, project_id, build_job_id, id, stage, status FROM run
           ON CONFLICT (stage_run_id, status) DO NOTHING
         )
         SELECT * FROM run`,
        [
          build.workspaceId,
          queued.stage,
          queued.attempt,
          queued.status,
          queued.inputDigest,
          build.id
        ]
      );
      if (!stageRows[0]) throw new Error("Initial stage run does not match the project build and snapshot");
      const persistedStage = stageRunRecord(stageRows[0]);
      return {
        build,
        initialStage: { stageRunId: persistedStage.id, projectId: persistedStage.projectId }
      };
    });
  }

  async requestBuildCancellation(workspaceId: string, buildId: string): Promise<BuildRecord | null> {
    const { rows } = await this.pool.query<BuildRow>(
      `UPDATE build_jobs SET cancel_requested = true, updated_at = now()
       WHERE workspace_id = $1 AND id = $2
         AND status NOT IN ('ready', 'published', 'failed')
       RETURNING id, workspace_id, repository_id, snapshot_id, snapshot_path, commit_sha,
                 status, warnings, cancel_requested, error_message,
                 purpose, feedback_ids, feedback_context, remediation_context, allow_llm`,
      [workspaceId, buildId]
    );
    return rows[0] ? buildRecord(rows[0]) : this.getBuild(workspaceId, buildId);
  }

  async listUnfinishedBuilds(): Promise<BuildRecord[]> {
    const { rows } = await this.pool.query<BuildRow>(
      `SELECT id, workspace_id, repository_id, snapshot_id, snapshot_path, commit_sha,
              status, warnings, cancel_requested, error_message,
              purpose, feedback_ids, feedback_context, remediation_context, allow_llm
       FROM build_jobs WHERE status NOT IN ('ready', 'published', 'failed')
       ORDER BY created_at ASC`
    );
    return rows.map(buildRecord);
  }

  async listBuilds(
    workspaceId: string,
    repositoryId: string,
    pagination?: Pagination
  ): Promise<BuildRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    const { rows } = await this.pool.query<BuildRow>(
      `SELECT id, workspace_id, repository_id, snapshot_id, snapshot_path, commit_sha,
              status, warnings, cancel_requested, error_message,
              purpose, feedback_ids, feedback_context, remediation_context, allow_llm
       FROM build_jobs WHERE workspace_id = $1 AND repository_id = $2
       ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [workspaceId, repositoryId, limit, offset]
    );
    return rows.map(buildRecord);
  }

  async countBuilds(workspaceId: string, repositoryId: string): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM build_jobs
       WHERE workspace_id = $1 AND repository_id = $2`,
      [workspaceId, repositoryId]
    );
    return Number(rows[0]?.total ?? 0);
  }

  async listBuildEvents(
    workspaceId: string,
    buildId: string,
    pagination?: Pagination
  ): Promise<BuildEvent[]> {
    const { limit, offset } = normalizePagination(pagination);
    const { rows } = await this.pool.query<{
      sequence: string; build_job_id: string; status: BuildStatus;
      created_at: Date; payload: { errorMessage?: string };
    }>(
      `SELECT e.sequence, e.build_job_id, e.status, e.created_at, e.payload
       FROM build_events e JOIN build_jobs b ON b.id = e.build_job_id
       WHERE e.workspace_id = $1 AND e.build_job_id = $2
       ORDER BY e.sequence LIMIT $3 OFFSET $4`,
      [workspaceId, buildId, limit, offset]
    );
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      buildId: row.build_job_id,
      status: row.status,
      occurredAt: row.created_at.toISOString(),
      ...(row.payload.errorMessage ? { errorMessage: row.payload.errorMessage } : {})
    }));
  }

  async saveKnowledge({ build, index, output }: PersistedKnowledge): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        "SELECT 1 FROM knowledge_pages WHERE build_job_id = $1 LIMIT 1",
        [build.id]
      );
      if (existing.rows[0]) throw new Error("Knowledge for this build is immutable");
      for (const symbol of index.symbols) {
        await client.query(
          `INSERT INTO code_symbols
           (workspace_id, source_file_id, name, kind, signature, start_line, end_line, exported)
           SELECT $1, sf.id, $4, $5, $6, $7, $8, $9
           FROM source_files sf
           WHERE sf.workspace_id = $1 AND sf.snapshot_id = $2 AND sf.path = $3
           ON CONFLICT (source_file_id, kind, name, start_line, end_line) DO NOTHING`,
          [build.workspaceId, build.snapshotId, symbol.path, symbol.name, symbol.kind,
            symbol.signature ?? null, symbol.startLine, symbol.endLine, symbol.exported]
        );
      }
      for (const edge of index.edges) {
        await client.query(
          `INSERT INTO code_edges
           (workspace_id, snapshot_id, kind, source_name, target_name, source_path, target_path,
            start_line, end_line)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (snapshot_id, kind, source_name, target_name, source_path, start_line, end_line)
           DO NOTHING`,
          [build.workspaceId, build.snapshotId, edge.kind, edge.source, edge.target,
            edge.citation.path, edge.targetPath ?? null,
            edge.citation.startLine, edge.citation.endLine]
        );
      }
      for (const draft of output.pages) {
        const pageResult = await client.query<{ id: string }>(
          `INSERT INTO knowledge_pages
           (workspace_id, repository_id, build_job_id, slug, title, body)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [build.workspaceId, build.repositoryId, build.id, draft.slug, draft.title, draft.body]
        );
        for (const [position, chunk] of draft.chunks.entries()) {
          await client.query(
            `INSERT INTO knowledge_chunks
             (workspace_id, page_id, position, heading, content, citations)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [build.workspaceId, pageResult.rows[0].id, position, chunk.heading, chunk.content,
              JSON.stringify(chunk.citations)]
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createReleaseDraft(
    workspaceId: string,
    repositoryId: string,
    buildId: string,
    version: string
  ): Promise<ReleaseRecord> {
    const { rows } = await this.pool.query<ReleaseRow>(
      `INSERT INTO releases (workspace_id, repository_id, build_job_id, snapshot_id, version)
       SELECT $1, $2, b.id, b.snapshot_id, $4
       FROM build_jobs b
       WHERE b.id = $3 AND b.workspace_id = $1 AND b.repository_id = $2 AND b.status = 'ready'
       RETURNING id, workspace_id, repository_id, build_job_id, snapshot_id, version,
                 kernel_mode, package_artifact_id, created_at, published_at`,
      [workspaceId, repositoryId, buildId, version]
    );
    if (!rows[0]) throw new Error("Only a ready build can create a release draft");
    return releaseRecord(rows[0]);
  }

  async publishRelease(
    workspaceId: string,
    releaseId: string,
    channel = "current"
  ): Promise<ReleaseRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<ReleaseRow>(
        `SELECT r.id, r.workspace_id, r.repository_id, r.build_job_id, r.snapshot_id,
                r.version, r.kernel_mode, r.package_artifact_id, r.created_at, r.published_at, b.status
         FROM releases r JOIN build_jobs b ON b.id = r.build_job_id
         WHERE r.workspace_id = $1 AND r.id = $2 FOR UPDATE`,
        [workspaceId, releaseId]
      );
      const release = selected.rows[0];
      if (!release) throw new Error("Release not found");
      if (release.status !== "ready") throw new Error("Release build is not ready");
      await client.query(
        `INSERT INTO release_channels (workspace_id, repository_id, release_id, name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (repository_id, name) DO UPDATE
         SET release_id = EXCLUDED.release_id, updated_at = now()`,
        [workspaceId, release.repository_id, release.id, channel]
      );
      const published = await client.query<ReleaseRow>(
        `UPDATE releases SET published_at = COALESCE(published_at, now()), updated_at = now()
         WHERE id = $1
         RETURNING id, workspace_id, repository_id, build_job_id, snapshot_id, version,
                   kernel_mode, package_artifact_id, created_at, published_at`,
        [release.id]
      );
      const publishedBuild = await client.query<{ id: string; workspace_id: string; status: BuildStatus }>(
        `UPDATE build_jobs SET status = 'published', updated_at = now()
         WHERE id = $1 AND status = 'ready'
         RETURNING id, workspace_id, status`,
        [release.build_job_id]
      );
      if (!publishedBuild.rows[0]) throw new Error("Release build is no longer ready");
      await client.query(
        `INSERT INTO build_events (workspace_id, build_job_id, status)
         VALUES ($1, $2, 'published')`,
        [publishedBuild.rows[0].workspace_id, publishedBuild.rows[0].id]
      );
      await client.query("COMMIT");
      return releaseRecord(published.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async currentRelease(
    workspaceId: string,
    repositoryId: string,
    channel = "current"
  ): Promise<ReleaseRecord | null> {
    const { rows } = await this.pool.query<ReleaseRow>(
      `SELECT r.id, r.workspace_id, r.repository_id, r.build_job_id, r.snapshot_id,
              r.version, r.kernel_mode, r.package_artifact_id, r.created_at, r.published_at
       FROM release_channels c JOIN releases r ON r.id = c.release_id
       WHERE c.workspace_id = $1 AND c.repository_id = $2 AND c.name = $3`,
      [workspaceId, repositoryId, channel]
    );
    return rows[0] ? releaseRecord(rows[0]) : null;
  }

  async getRelease(workspaceId: string, releaseId: string): Promise<ReleaseRecord | null> {
    const { rows } = await this.pool.query<ReleaseRow>(
      `SELECT id, workspace_id, repository_id, build_job_id, snapshot_id, version,
              kernel_mode, package_artifact_id, created_at, published_at
       FROM releases WHERE workspace_id = $1 AND id = $2 LIMIT 1`,
      [workspaceId, releaseId]
    );
    return rows[0] ? releaseRecord(rows[0]) : null;
  }

  async listReleases(
    workspaceId: string,
    repositoryId: string,
    pagination?: Pagination
  ): Promise<ReleaseRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    const { rows } = await this.pool.query<ReleaseRow>(
      `SELECT id, workspace_id, repository_id, build_job_id, snapshot_id, version,
              kernel_mode, package_artifact_id, created_at, published_at
       FROM releases WHERE workspace_id = $1 AND repository_id = $2
       ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [workspaceId, repositoryId, limit, offset]
    );
    return rows.map(releaseRecord);
  }

  async countReleases(workspaceId: string, repositoryId: string): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM releases
       WHERE workspace_id = $1 AND repository_id = $2`,
      [workspaceId, repositoryId]
    );
    return Number(rows[0]?.total ?? 0);
  }

  async listKnowledgePages(
    workspaceId: string,
    releaseId?: string,
    pagination?: Pagination
  ): Promise<KnowledgePageRecord[]> {
    const { limit, offset } = normalizePagination(pagination);
    const { rows } = await this.pool.query<KnowledgePageRow>(
      `SELECT p.id, p.workspace_id, p.repository_id, p.build_job_id, p.slug, p.title,
              left(p.body, 20000) AS body,
              COALESCE(jsonb_agg(jsonb_build_object(
                'id', c.id, 'heading', c.heading, 'content', left(c.content, 8000),
                'citations', jsonb_path_query_array(c.citations, '$[0 to 7]')
              ) ORDER BY c.position, c.id) FILTER (WHERE c.id IS NOT NULL), '[]'::jsonb) AS chunks
       FROM knowledge_pages p
       JOIN releases r ON r.build_job_id = p.build_job_id
       LEFT JOIN LATERAL (
         SELECT * FROM knowledge_chunks selected_chunk
         WHERE selected_chunk.page_id = p.id
         ORDER BY selected_chunk.position, selected_chunk.id LIMIT 50
       ) c ON true
       LEFT JOIN release_channels rc ON rc.release_id = r.id AND rc.name = 'current'
       WHERE p.workspace_id = $1 AND (($2::uuid IS NOT NULL AND r.id = $2) OR ($2::uuid IS NULL AND rc.id IS NOT NULL))
       GROUP BY p.id ORDER BY p.slug, p.id LIMIT $3 OFFSET $4`,
      [workspaceId, releaseId ?? null, limit, offset]
    );
    return rows.map(knowledgePageRecord);
  }

  async countKnowledgePages(workspaceId: string, releaseId?: string): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      `SELECT count(DISTINCT p.id)::text AS total
       FROM knowledge_pages p
       JOIN releases r ON r.build_job_id = p.build_job_id
       LEFT JOIN release_channels rc ON rc.release_id = r.id AND rc.name = 'current'
       WHERE p.workspace_id = $1
         AND (($2::uuid IS NOT NULL AND r.id = $2)
           OR ($2::uuid IS NULL AND rc.id IS NOT NULL))`,
      [workspaceId, releaseId ?? null]
    );
    return Number(rows[0]?.total ?? 0);
  }

  async countKnowledgePagesForBuild(workspaceId: string, buildId: string): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM knowledge_pages
       WHERE workspace_id = $1 AND build_job_id = $2`,
      [workspaceId, buildId]
    );
    return Number(rows[0]?.total ?? 0);
  }

  async getKnowledgePage(workspaceId: string, pageId: string): Promise<KnowledgePageRecord | null> {
    const { rows } = await this.pool.query<KnowledgePageRow>(
      `SELECT p.id, p.workspace_id, p.repository_id, p.build_job_id, p.slug, p.title,
              left(p.body, 20000) AS body,
              COALESCE(jsonb_agg(jsonb_build_object(
                'id', c.id, 'heading', c.heading, 'content', left(c.content, 8000),
                'citations', jsonb_path_query_array(c.citations, '$[0 to 7]')
              ) ORDER BY c.position, c.id) FILTER (WHERE c.id IS NOT NULL), '[]'::jsonb) AS chunks
       FROM knowledge_pages p LEFT JOIN LATERAL (
         SELECT * FROM knowledge_chunks selected_chunk
         WHERE selected_chunk.page_id = p.id
         ORDER BY selected_chunk.position, selected_chunk.id LIMIT 50
       ) c ON true
       WHERE p.workspace_id = $1 AND p.id = $2 GROUP BY p.id`,
      [workspaceId, pageId]
    );
    return rows[0] ? knowledgePageRecord(rows[0]) : null;
  }

  private async targetedKnowledgePage(
    sql: string,
    values: unknown[]
  ): Promise<KnowledgePageRecord | null> {
    const { rows } = await this.pool.query<KnowledgePageRow>(sql, values);
    return rows[0] ? knowledgePageRecord(rows[0]) : null;
  }

  async findKnowledgePageBySlug(workspaceId: string, releaseId: string, slug: string) {
    return this.targetedKnowledgePage(
      `SELECT p.id, p.workspace_id, p.repository_id, p.build_job_id, p.slug, p.title,
              left(p.body, 20000) AS body,
              COALESCE(jsonb_agg(jsonb_build_object(
                'id', c.id, 'heading', c.heading, 'content', left(c.content, 8000),
                'citations', jsonb_path_query_array(c.citations, '$[0 to 7]')
              ) ORDER BY c.position, c.id) FILTER (WHERE c.id IS NOT NULL), '[]'::jsonb) AS chunks
       FROM releases r JOIN knowledge_pages p ON p.build_job_id = r.build_job_id
       LEFT JOIN LATERAL (
         SELECT * FROM knowledge_chunks selected_chunk WHERE selected_chunk.page_id = p.id
         ORDER BY selected_chunk.position, selected_chunk.id LIMIT 50
       ) c ON true
       WHERE r.workspace_id = $1 AND r.id = $2 AND p.slug = $3
       GROUP BY p.id ORDER BY p.id LIMIT 1`,
      [workspaceId, releaseId, slug]
    );
  }

  async findKnowledgePageByModule(workspaceId: string, releaseId: string, moduleId: string) {
    return this.targetedKnowledgePage(
      `SELECT p.id, p.workspace_id, p.repository_id, p.build_job_id, p.slug, p.title,
              left(p.body, 20000) AS body,
              COALESCE(jsonb_agg(jsonb_build_object(
                'id', c.id, 'heading', c.heading, 'content', left(c.content, 8000),
                'citations', jsonb_path_query_array(c.citations, '$[0 to 7]')
              ) ORDER BY c.position, c.id) FILTER (WHERE c.id IS NOT NULL), '[]'::jsonb) AS chunks
       FROM releases r JOIN knowledge_pages p ON p.build_job_id = r.build_job_id
       LEFT JOIN LATERAL (
         SELECT * FROM knowledge_chunks selected_chunk WHERE selected_chunk.page_id = p.id
         ORDER BY selected_chunk.position, selected_chunk.id LIMIT 50
       ) c ON true
       WHERE r.workspace_id = $1 AND r.id = $2
         AND (p.title IN ('模块：' || $3, 'Module: ' || $3) OR p.slug = $3)
       GROUP BY p.id ORDER BY p.slug, p.id LIMIT 1`,
      [workspaceId, releaseId, moduleId]
    );
  }

  async findKnowledgePageBySymbol(
    workspaceId: string,
    releaseId: string,
    name: string,
    sourcePath?: string
  ) {
    return this.targetedKnowledgePage(
      `SELECT p.id, p.workspace_id, p.repository_id, p.build_job_id, p.slug, p.title,
              left(p.body, 20000) AS body,
              COALESCE(jsonb_agg(jsonb_build_object(
                'id', c.id, 'heading', c.heading, 'content', left(c.content, 8000),
                'citations', jsonb_path_query_array(c.citations, '$[0 to 7]')
              ) ORDER BY c.position, c.id) FILTER (WHERE c.id IS NOT NULL), '[]'::jsonb) AS chunks
       FROM releases r JOIN knowledge_pages p ON p.build_job_id = r.build_job_id
       LEFT JOIN LATERAL (
         SELECT * FROM knowledge_chunks selected_chunk WHERE selected_chunk.page_id = p.id
         ORDER BY selected_chunk.position, selected_chunk.id LIMIT 50
       ) c ON true
       WHERE r.workspace_id = $1 AND r.id = $2 AND p.title = $3
         AND ($4::text IS NULL OR EXISTS (
           SELECT 1 FROM knowledge_chunks cited_chunk,
             LATERAL jsonb_array_elements(cited_chunk.citations) citation
           WHERE cited_chunk.page_id = p.id AND citation->>'path' = $4
         ))
       GROUP BY p.id ORDER BY p.slug, p.id LIMIT 1`,
      [workspaceId, releaseId, name, sourcePath ?? null]
    );
  }

  async knowledgeReleaseSummary(workspaceId: string, releaseId: string) {
    const { rows } = await this.pool.query<{
      page_count: string;
      chunk_count: string;
      citation_count: string;
    }>(
      `SELECT count(DISTINCT p.id)::text AS page_count,
              count(c.id)::text AS chunk_count,
              COALESCE(sum(jsonb_array_length(c.citations)), 0)::text AS citation_count
       FROM releases r
       LEFT JOIN knowledge_pages p ON p.build_job_id = r.build_job_id
       LEFT JOIN knowledge_chunks c ON c.page_id = p.id
       WHERE r.workspace_id = $1 AND r.id = $2`,
      [workspaceId, releaseId]
    );
    return {
      pageCount: Number(rows[0]?.page_count ?? 0),
      chunkCount: Number(rows[0]?.chunk_count ?? 0),
      citationCount: Number(rows[0]?.citation_count ?? 0)
    };
  }

  async searchKnowledge(
    workspaceId: string,
    repositoryId: string,
    query: string,
    releaseId?: string
  ): Promise<KnowledgeSearchResult[]> {
    const { rows } = await this.pool.query<{
      kind: KnowledgeSearchResult["kind"]; title: string; excerpt: string; score: number;
      page_id: string; release_id: string; citations: Citation[];
    }>(
      `WITH selected_release AS (
         SELECT r.* FROM releases r
         LEFT JOIN release_channels rc ON rc.release_id = r.id AND rc.name = 'current'
         WHERE r.workspace_id = $1 AND r.repository_id = $2
           AND (($4::uuid IS NOT NULL AND r.id = $4) OR ($4::uuid IS NULL AND rc.id IS NOT NULL))
         LIMIT 1
       ), symbol_candidates AS (
         SELECT DISTINCT CASE WHEN cs.kind = 'module' THEN 'module' ELSE 'symbol' END AS kind,
                CASE WHEN cs.kind = 'module' THEN sf.path ELSE cs.name END AS title,
                left(kp.body, 240) AS excerpt,
                CASE
                  WHEN lower(cs.name) = lower($3) THEN 100
                  WHEN lower(sf.path) = lower($3) THEN 90
                  WHEN lower(cs.name) LIKE lower($3) || '%' THEN 80
                  WHEN lower(sf.path) LIKE lower($3) || '%' THEN 70
                  ELSE 30 + similarity(lower(cs.name), lower($3)) * 10
                END AS score,
                kp.id AS page_id, sr.id AS release_id,
                jsonb_build_array(jsonb_build_object(
                  'path', sf.path, 'startLine', cs.start_line, 'endLine', cs.end_line,
                  'commitSha', b.commit_sha, 'blobHash', sf.content_hash
                )) AS citations
         FROM selected_release sr
         JOIN build_jobs b ON b.id = sr.build_job_id
         JOIN source_files sf ON sf.snapshot_id = sr.snapshot_id
         JOIN code_symbols cs ON cs.source_file_id = sf.id
         JOIN LATERAL (
           SELECT p.* FROM knowledge_pages p WHERE p.build_job_id = sr.build_job_id
           ORDER BY CASE WHEN p.title = cs.name OR p.title IN ('模块：' || sf.path, 'Module: ' || sf.path) THEN 0 ELSE 1 END, p.slug LIMIT 1
         ) kp ON true
         WHERE lower(cs.name) LIKE lower($3) || '%' OR lower(sf.path) LIKE lower($3) || '%'
            OR similarity(lower(cs.name), lower($3)) > 0.2
       ), symbol_matches AS (
         SELECT *, ROW_NUMBER() OVER (ORDER BY score DESC, title, page_id) AS symbol_rank
         FROM symbol_candidates
       ), neighbor_candidates AS (
         SELECT DISTINCT 'dependency-neighbor' AS kind,
                CASE WHEN kp.title LIKE '模块：%' THEN substring(kp.title FROM 4)
                     WHEN kp.title LIKE 'Module: %' THEN substring(kp.title FROM 9)
                     ELSE neighbor.name END AS title,
                left(kp.body, 240) AS excerpt, 60::real AS score,
                kp.id AS page_id, sr.id AS release_id, kc.citations
         FROM selected_release sr
         JOIN code_edges ce ON ce.workspace_id = sr.workspace_id
                            AND ce.snapshot_id = sr.snapshot_id
         CROSS JOIN LATERAL (SELECT
           CASE WHEN lower(ce.target_name) = lower($3) THEN ce.source_name ELSE ce.target_name END AS name,
           CASE WHEN lower(ce.target_name) = lower($3) THEN ce.source_path ELSE ce.target_path END AS path
         ) neighbor
         JOIN LATERAL (
           SELECT p.* FROM knowledge_pages p
           WHERE p.build_job_id = sr.build_job_id AND (
             p.slug = 'modules/' || trim(both '-' from regexp_replace(
               lower(neighbor.name), '[^a-z0-9]+', '-', 'g'
             ))
             OR p.slug = 'modules/' || trim(both '-' from regexp_replace(
               lower(neighbor.path), '[^a-z0-9]+', '-', 'g'
             ))
             OR (p.title = neighbor.name AND EXISTS (
               SELECT 1 FROM knowledge_chunks cited
               WHERE cited.page_id = p.id
                 AND cited.citations @> jsonb_build_array(jsonb_build_object('path', neighbor.path))
             ))
           )
           ORDER BY p.slug LIMIT 1
         ) kp ON true
         JOIN LATERAL (
           SELECT jsonb_path_query_array(selected_chunk.citations, '$[0 to 7]') AS citations
           FROM knowledge_chunks selected_chunk
           WHERE selected_chunk.page_id = kp.id
           ORDER BY selected_chunk.position, selected_chunk.id LIMIT 1
         ) kc ON true
         WHERE lower(ce.source_name) = lower($3) OR lower(ce.target_name) = lower($3)
       ), neighbor_matches AS (
         SELECT *, ROW_NUMBER() OVER (ORDER BY score DESC, title, page_id) AS neighbor_rank
         FROM neighbor_candidates
       ), text_candidates AS (
         SELECT DISTINCT 'page' AS kind, kp.title, left(kp.body, 240) AS excerpt,
                (20 + ts_rank_cd(to_tsvector('english', kp.title || ' ' || kp.body),
                                 plainto_tsquery('english', $3)) * 10
                    + similarity(lower(kp.title), lower($3)))::real AS score,
                kp.id AS page_id, sr.id AS release_id, kc.citations
         FROM selected_release sr JOIN knowledge_pages kp ON kp.build_job_id = sr.build_job_id
         JOIN LATERAL (
           SELECT jsonb_path_query_array(selected_chunk.citations, '$[0 to 7]') AS citations
           FROM knowledge_chunks selected_chunk
           WHERE selected_chunk.page_id = kp.id
           ORDER BY selected_chunk.position, selected_chunk.id LIMIT 1
         ) kc ON true
         WHERE to_tsvector('english', kp.title || ' ' || kp.body) @@ plainto_tsquery('english', $3)
            OR lower(kp.title || ' ' || kp.body) LIKE '%' || lower($3) || '%'
            OR similarity(lower(kp.title), lower($3)) > 0.2
       ), text_matches AS (
         SELECT *, ROW_NUMBER() OVER (ORDER BY score DESC, title, page_id) AS text_rank
         FROM text_candidates
       )
       SELECT * FROM (
         SELECT kind, title, excerpt, score, page_id, release_id, citations
         FROM symbol_matches WHERE symbol_rank <= 15
         UNION ALL
         SELECT kind, title, excerpt, score, page_id, release_id, citations
         FROM neighbor_matches WHERE neighbor_rank <= 15
         UNION ALL
         SELECT kind, title, excerpt, score, page_id, release_id, citations
         FROM text_matches WHERE text_rank <= 20
       ) ranked ORDER BY score DESC, title ASC, page_id ASC LIMIT 50`,
      [workspaceId, repositoryId, query, releaseId ?? null]
    );
    return rows.map((row) => ({
      kind: row.kind,
      title: row.title,
      excerpt: row.excerpt,
      matchReason: knowledgeMatchReason(row.kind, row.title, query),
      score: Number(row.score),
      pageId: row.page_id,
      releaseId: row.release_id,
      citations: row.citations
    }));
  }

  async knowledgeMetadata(workspaceId: string, releaseId: string): Promise<KnowledgeMetadata> {
    const symbols = await this.pool.query<{
      name: string; kind: string; path: string; start_line: number; end_line: number; exported: boolean;
    }>(
      `SELECT cs.name, cs.kind, sf.path, cs.start_line, cs.end_line, cs.exported
       FROM releases r
       JOIN source_files sf ON sf.snapshot_id = r.snapshot_id
       JOIN code_symbols cs ON cs.source_file_id = sf.id
       WHERE r.workspace_id = $1 AND r.id = $2
       ORDER BY sf.path, cs.start_line, cs.name LIMIT 500`,
      [workspaceId, releaseId]
    );
    const dependencies = await this.pool.query<{
      source_name: string; target_name: string; kind: string; source_path: string; target_path: string | null;
      start_line: number; end_line: number;
    }>(
      `SELECT ce.source_name, ce.target_name, ce.kind, ce.source_path, ce.target_path, ce.start_line, ce.end_line
       FROM releases r JOIN code_edges ce ON ce.snapshot_id = r.snapshot_id
       WHERE r.workspace_id = $1 AND r.id = $2
       ORDER BY ce.source_path, ce.start_line, ce.source_name, ce.target_name LIMIT 500`,
      [workspaceId, releaseId]
    );
    return {
      symbols: symbols.rows.map((row) => ({
        name: row.name, kind: row.kind, path: row.path,
        startLine: row.start_line, endLine: row.end_line, exported: row.exported
      })),
      dependencies: dependencies.rows.map((row) => ({
        source: row.source_name, target: row.target_name, kind: row.kind, path: row.source_path,
        targetPath: row.target_path,
        startLine: row.start_line, endLine: row.end_line
      }))
    };
  }
}
