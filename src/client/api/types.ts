import type { LintIssue, TrustScore } from "../../shared/api-contracts";
import type { AgentFeedbackStatus } from "../../server/persistence/store";
import type { BuildStatus } from "../../server/knowledge/build-service";

export interface Admin { id: string; email: string; role?: "admin" | "member" | "reader" }
export interface Session { authenticated: true; admin: Admin }
export interface MfaStatus { enabled: boolean; pending: boolean; lockedUntil: string | null }
export interface TeamMember {
  id: string;
  email: string;
  role: "admin" | "member" | "reader";
  createdAt?: string;
  disabledAt?: string | null;
}
export type ProjectMember = TeamMember;
export interface Project {
  id: string;
  name: string;
  slug: string;
  archivedAt: string | null;
  createdAt: string;
}
export interface ProjectSummary {
  project: Project;
  repository: Repository | null;
  latestSnapshot: RepositoryStatus["latestSnapshot"];
  currentRelease: Release | null;
  latestBuild: Build | null;
  memberCount: number;
  indexedTextBytes?: number;
  pendingFeedbackCount?: number;
}
export interface ProjectKnowledgeQuality {
  repository: Repository | null;
  latestSnapshot: RepositoryStatus["latestSnapshot"];
  currentRelease: Release | null;
  latestBuild: Build | null;
  pendingFeedbackCount: number;
  indexedTextBytes: number;
  knowledge: { pageCount: number; chunkCount: number; citationCount: number };
  remediation: { open: number; accepted: number; rebuilding: number; resolved: number; dismissed: number };
  qualityPipeline: {
    stage: PipelineStageRun["stage"];
    status: PipelineStageRun["status"];
    artifactReady: boolean;
    errorCode: string | null;
  } | null;
  assessment: { trust: TrustScore; issueTotal: number; issues: LintIssue[] } | null;
  change: SnapshotChangeSummary | null;
  diagnostics: Array<{ code: "SOURCE_MISSING" | "SNAPSHOT_MISSING" | "BUILD_FAILED" | "RELEASE_MISSING" | "REBUILD_RECOMMENDED" | "PUBLISHED" }>;
}
export type RemediationState = "open" | "accepted" | "rebuilding" | "resolved" | "dismissed";
export interface Remediation {
  id: string;
  projectId: string;
  repositoryId: string;
  sourceBuildId: string;
  issue: LintIssue;
  state: RemediationState;
  rebuildBuildId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface RemediationEvent {
  id: string;
  remediationId: string;
  fromState: RemediationState;
  toState: RemediationState;
  actorId: string | null;
  reason: string | null;
  createdAt: string;
}
export interface WorkspaceOverview {
  projects: ProjectSummary[];
  totals: { projects: number; connected: number; published: number; members: number };
}
export interface ProjectActivity {
  id: string;
  projectId: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}
export interface Repository {
  id: string;
  projectId: string;
  kind: "local" | "git" | "upload";
  name: string;
  path?: string | null;
  url?: string | null;
  hasCredential?: boolean;
  defaultBranch: string;
}
export interface ArchivedRepository {
  id: string;
  name: string;
  kind: Repository["kind"];
  archivedAt: string;
}
export interface UploadSnapshotSummary {
  snapshotId: string;
  sourceVersion: string;
  fileCount: number;
  textBytes: number;
  unchanged: boolean;
  ignored: { total: number; reasons: Record<string, number> };
  assetCount: number;
}
export interface ImportReport {
  id: string;
  projectId: string;
  repositoryId: string | null;
  sourceKind: Repository["kind"];
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string | null;
  collectedFileCount: number;
  collectedTextBytes: number;
  ignored: { total: number; reasons: Record<string, number> };
  snapshotId: string | null;
  failureCode: string | null;
}
export type ImportPhase = "reading" | "filtering" | "packaging" | "uploading" | "validating" | "snapshot";
export type ImportRunStatus = "idle" | "running" | "paused" | "failed" | "completed" | "cancelled";
export interface ImportProgress {
  phase: ImportPhase;
  status: ImportRunStatus;
  percent: number;
  processedFiles?: number;
  totalFiles?: number;
  processedBytes?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  estimatedSeconds?: number;
  detail?: string;
}
export interface SnapshotSummary {
  snapshotId: string;
  commitSha: string;
  ref: string;
  fileCount: number;
  textBytes?: number;
  ignored?: { total: number; reasons: Record<string, number> };
  unchanged: boolean;
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
  impact?: {
    roots: Array<{ id: string; path: string; kind: string; changed: boolean; children: unknown[] }>;
    crossLinks: Array<{ id: string; kind: string; candidate: boolean }>;
    affectedModulePaths: string[];
    deletedPaths: string[];
  };
}
export interface Build {
  id: string;
  snapshotId: string;
  commitSha: string;
  status: BuildStatus;
  warnings: Array<{ code?: string; message?: string }>;
  cancelRequested: boolean;
  allowLlm?: boolean;
  errorMessage?: string;
}
export type PipelineBuildStage = "convert" | "extract" | "tables" | "graph" | "synthesize" | "index" | "lint" | "viz" | "validate" | "package";
export type PipelineStageStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "reused" | "skipped";
export interface PipelineStageRun {
  id: string;
  buildId: string;
  stage: PipelineBuildStage;
  attempt: number;
  status: PipelineStageStatus;
  inputDigest: string;
  outputManifestIds: string[];
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  errorDetail: string | null;
}
export interface KnowledgeKernelDifference {
  area: "pages" | "graph_nodes" | "graph_edges" | "search" | "quality" | "citations";
  key: string;
  reason: "missing_in_pipeline" | "additional_in_pipeline" | "invalid_citation" | "quality_changed";
}
export interface KnowledgeKernelComparison {
  blockingDefects: KnowledgeKernelDifference[];
  compatibilityDifferences: KnowledgeKernelDifference[];
  expectedImprovements: KnowledgeKernelDifference[];
  citations: { valid: boolean; total: number; invalid: KnowledgeKernelDifference[] };
}
export interface Release {
  id: string;
  buildId: string;
  snapshotId: string;
  version: string;
  createdAt: string;
  publishedAt: string | null;
  commitSha?: string | null;
  kernelMode?: "legacy" | "pipeline";
  packageArtifactId?: string | null;
  releaseArtifactFamily?: "knowledge-v1" | "frontend-v2";
  packageStageRunId?: string | null;
  frontendIrSchemaVersion?: number | null;
  frontendGraphSchemaVersion?: number | null;
  analyzerManifestDigest?: string | null;
}
export interface RepositoryStatus {
  repository: Repository | null;
  latestSnapshot: null | {
    id: string; commitSha: string; ref: string; commitTimestamp: string; fileCount?: number;
  };
}
export interface KnowledgeMetadata {
  symbols: Array<{
    name: string; kind: string; path: string; startLine: number; endLine: number; exported: boolean;
  }>;
  dependencies: Array<{
    source: string; target: string; kind: string; path: string; targetPath: string | null; startLine: number; endLine: number;
  }>;
}
export interface Citation {
  path: string;
  startLine: number;
  endLine: number;
  commitSha: string;
  blobHash: string;
  symbol?: string;
  kind?: string;
}
export type GraphNodeKind = "module" | "symbol" | "document" | "table" | "column" | "command";
export type GraphEdgeKind = "imports" | "exports" | "calls" | "contains" | "documents" | "reads" | "writes" | "depends_on";
export interface GraphSourceRef {
  snapshotId: string;
  path: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  blobHash: string;
}
export interface KnowledgeGraphNode {
  id: string;
  projectId: string;
  snapshotId: string;
  kind: GraphNodeKind;
  name: string;
  qualifiedName: string;
  candidate: boolean;
  sourceRefs: GraphSourceRef[];
  attributes: Record<string, unknown>;
}
interface KnowledgeGraphEdgeBase {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kind: GraphEdgeKind;
  confidence: number;
  sourceRefs: GraphSourceRef[];
}
export type KnowledgeGraphEdge = (KnowledgeGraphEdgeBase & {
  candidate: false;
  candidateReason?: never;
}) | (KnowledgeGraphEdgeBase & {
  candidate: true;
  candidateReason: string;
});
export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}
export interface GraphTreeNode {
  id: string;
  name: string;
  kind: GraphNodeKind;
  candidate: boolean;
  children: GraphTreeNode[];
}
export type GraphTreeCrossLink = KnowledgeGraphEdge & { cycle: boolean };
export type ProjectGraphFormat = "json" | "tree" | "mermaid" | "markmap";
export interface ProjectGraphDataByFormat {
  json: KnowledgeGraph;
  tree: { roots: GraphTreeNode[]; crossLinks: GraphTreeCrossLink[] };
  mermaid: string;
  markmap: string;
}
export type ProjectGraphResponse<F extends ProjectGraphFormat = ProjectGraphFormat> = F extends ProjectGraphFormat ? {
  release: { id: string; version: string } | null;
  format: F;
  data: ProjectGraphDataByFormat[F] | null;
} : never;
export interface KnowledgeChunk {
  id: string;
  heading: string | null;
  content: string;
  citations: Citation[];
}
export interface KnowledgePageRecord {
  id: string;
  slug: string;
  title: string;
  body: string;
  chunks: KnowledgeChunk[];
}
export interface SearchResult {
  kind: string;
  title: string;
  excerpt: string;
  matchReason: string;
  score: number;
  pageId: string;
  releaseId: string;
  citations: Citation[];
  trust: TrustScore;
}
export interface WorkspaceSearchResult extends SearchResult {
  projectId: string;
  projectName: string;
  projectSlug: string;
}
export interface SourceExcerpt extends Citation { content: string }
export type FrontendPreviewStatus = "source_missing" | "build_missing" | "build_failed" | "candidate_failed" | "candidate_pending" | "ready";
export interface FrontendPreviewEntity {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  canonicalPath: string;
  packageKey: string;
  sourceRefs: GraphSourceRef[];
  facets: Record<string, Record<string, unknown>>;
  attributes: Record<string, unknown>;
}
export interface FrontendPreviewEdge {
  id: string;
  kind: string;
  fromEntityId: string;
  toEntityId: string;
  evidenceClass: "fact" | "candidate";
  confidence: number;
  candidateReason?: string;
  sourceRefs: GraphSourceRef[];
}
export interface FrontendPreviewPage {
  id: string;
  slug: string;
  title: string;
  kind: "architecture" | "routes" | "components" | "data" | "visualizations" | "tooling-tests";
  items: Array<{ entityId: string; kind: string; name: string; qualifiedName: string; sourceRefs: GraphSourceRef[] }>;
  citations: GraphSourceRef[];
  chunks: Array<{ heading: string; content: string; citations: GraphSourceRef[] }>;
}
export interface FrontendCandidatePreview {
  build: { id: string; snapshotId: string; commitSha: string; status: BuildStatus };
  graph: { schemaVersion: 2; snapshotId: string; analyzerManifestDigest: string; nodes: FrontendPreviewEntity[]; edges: FrontendPreviewEdge[] };
  pages: FrontendPreviewPage[];
  projectProfile: {
    schemaVersion: 1;
    snapshotId: string;
    analyzerManifestDigest: string;
    profileDigest: string;
    framework: { state: "known" | "unknown" | "unsupported"; value?: { name: string; version: string; supported: boolean }; reason?: string };
    [key: string]: unknown;
  };
  search: Array<{ documentKey: string; kind: string; title: string; content: string; citations: GraphSourceRef[]; metadata: Record<string, string | number | boolean> }>;
  quality: {
    summary: { entities: number; factEdges: number; candidateEdges: number; citedEntities: number; components: number; testedComponents: number; routes: number; visualizations: number };
    issues: Array<{ rule: string; severity: "warning" | "info"; targetId: string; message: string; sourceRefs: GraphSourceRef[] }>;
  };
  visualization: { routeIds: string[]; componentIds: string[]; visualizationIds: string[]; factEdgeIds: string[] };
  validation: { valid: boolean; pageCount: number; issueCount: number };
}
export interface FrontendKnowledgeComparison {
  legacy: { entities: number; factRelations: number; pages: number; searchDocuments: number; impactPaths: number; issues: number };
  candidate: { entities: number; factRelations: number; candidateRelations: number; pages: number; searchDocuments: number; impactPaths: number; issues: number };
  candidateEntityKeys: string[];
  candidateFactKeys: string[];
  impact: { legacyPaths: string[]; candidatePaths: string[]; legacySuggestedTests: string[]; candidateSuggestedTests: string[] };
  citations: { valid: boolean; checked: number; invalid: string[] };
}
export type FrontendPreviewResponse =
  | { status: "ready"; preview: FrontendCandidatePreview; comparison: FrontendKnowledgeComparison; stale: boolean }
  | { status: Exclude<FrontendPreviewStatus, "ready">; preview: null; build?: { id: string; status: BuildStatus }; failedStage?: { stage: string; errorCode: string | null } };
export interface Feedback {
  id: string;
  releaseId: string | null;
  query: string;
  reason: string;
  expected: string | null;
  citations: Citation[];
  status: AgentFeedbackStatus;
  rebuildBuildId: string | null;
  createdAt: string;
  updatedAt: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  releaseVersion: string;
}
export interface McpToken {
  id: string;
  projectId: string;
  name: string;
  tokenPrefix: string;
  scopes: Array<"search" | "source.read">;
  expiresAt: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export interface WorkspaceMcpToken {
  id: string;
  userId: string;
  name: string;
  tokenPrefix: string;
  scopes: Array<"workspace.patterns.read" | "workspace.solutions.read">;
  sessionVersion: number;
  expiresAt: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export type { FrontendSolutionContext } from "../../shared/frontend-solution-context";
export interface McpConnection {
  endpoint: string;
  transport: string;
  authorization: string;
  stdioCommand: string;
  tools: string[];
}
export interface CodexConnectionPack {
  projectId: string;
  endpoint: string;
  environmentVariable: string;
  configToml: string;
  agentsMarkdown: string;
  checkCommand: string;
}
export type ModelProvider = "openai" | "anthropic";
export interface ModelConfig {
  provider: ModelProvider;
  model: string;
  hasApiKey: boolean;
}
export interface ApiErrorShape { error: { code: string; message: string; changedPaths?: string[] } }
