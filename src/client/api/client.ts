import type {
  ApiErrorShape, ArchivedRepository, Build, CodexConnectionPack, ExperienceReviewItemDto,
  Feedback, FrontendExperienceLintResponse, FrontendPreviewResponse, FrontendSolutionContext, GraphSourceRef, ImportProgress,
  ImportReport, KnowledgeKernelComparison, KnowledgeMetadata, KnowledgePageRecord, McpConnection,
  McpToken, MfaStatus, PipelineStageRun, Project, ProjectActivity, ProjectGraphFormat,
  ProjectGraphResponse, ProjectKnowledgeQuality, ProjectMember, ProjectSummary, Release, Remediation,
  RemediationEvent, RemediationState, Repository, RepositoryStatus, SearchResult, Session,
  SnapshotChangeSummary, SnapshotSummary, SourceExcerpt, TeamMember, UploadSnapshotSummary,
  WorkspaceExperienceLibraryResponse, WorkspaceMcpToken, WorkspaceOverview, WorkspaceSearchResult
} from "./types";
import type { ModelConfig, ModelProvider } from "./types";
import type { AgentFeedbackStatus } from "../../server/persistence/store";
import type { FolderImportFile } from "./folder-import";
import { createUploadManifest } from "./upload-manifest";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: ApiErrorShape["error"]) {
    super(message);
    this.name = "ApiError";
  }
}

export interface PaginationParams {
  limit: number;
  offset: number;
}

export interface ProjectGraphRequestOptions {
  releaseId?: string;
}

export interface RemediationListParams extends PaginationParams {
  state?: RemediationState;
  severity?: "error" | "warning" | "info";
  rule?: string;
}

export interface PaginatedResponse {
  total: number;
  nextOffset: number | null;
}

export interface UploadFolderOptions {
  onProgress?(progress: ImportProgress): void;
}

export const LIST_PAGE_SIZE = 100;
export const ACTIVE_PROJECT_STORAGE_KEY = "devkh:active-project-id";

export function activeProjectId(): string | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function csrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith("devkh_csrf="))?.slice("devkh_csrf=".length);
}

function retryAfterMilliseconds(value: string | null): number {
  if (!value) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(60_000, Math.max(0, seconds * 1_000));
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.min(60_000, Math.max(0, timestamp - Date.now())) : 1_000;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const projectId = activeProjectId();
  const csrf = init?.method && !["GET", "HEAD", "OPTIONS"].includes(init.method) ? csrfToken() : undefined;
  const retryRateLimit = path.includes("/upload-sessions");
  const fetchAttempt = async (rateLimitRetries = 0): Promise<Response> => {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers: {
        ...(projectId ? { "x-devkh-project": projectId } : {}),
        ...(csrf ? { "x-devkh-csrf": csrf } : {}),
        ...(typeof init?.body === "string" ? { "content-type": "application/json" } : {}),
        ...init?.headers
      }
    });
    if (!retryRateLimit || response.status !== 429 || rateLimitRetries >= 5) return response;
    await new Promise((resolve) => setTimeout(resolve, retryAfterMilliseconds(response.headers.get("retry-after"))));
    return fetchAttempt(rateLimitRetries + 1);
  };
  const response = await fetchAttempt();
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ApiErrorShape | null;
    throw new ApiError(response.status, body?.error.code ?? "REQUEST_FAILED", body?.error.message ?? "Request failed", body?.error);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export interface ApiClient {
  setupStatus(): Promise<{ setupRequired: boolean }>;
  setup(input: { email: string; password: string }): Promise<unknown>;
  login(input: { email: string; password: string; code?: string; recoveryCode?: string }): Promise<Session>;
  session(): Promise<Session>;
  logout(): Promise<void>;
  listMembers(): Promise<{ members: TeamMember[] }>;
  createMember(input: { email: string; password: string; role: TeamMember["role"] }): Promise<{ member: TeamMember }>;
  resetMemberPassword(userId: string, password: string): Promise<{ member: TeamMember }>;
  setMemberDisabled(userId: string, disabled: boolean): Promise<{ member: TeamMember }>;
  listProjects(): Promise<{ projects: Project[] }>;
  workspaceOverview(): Promise<WorkspaceOverview>;
  searchWorkspaceKnowledge(query: string): Promise<{ results: WorkspaceSearchResult[] }>;
  createProject(input: { name: string; slug: string }): Promise<{ project: Project }>;
  getProjectSummary(projectId: string): Promise<ProjectSummary>;
  listImportReports(projectId: string, pagination: PaginationParams): Promise<{ reports: ImportReport[] } & PaginatedResponse>;
  listProjectActivity(projectId: string, pagination: PaginationParams):
    Promise<{ activity: ProjectActivity[]; members: ProjectMember[] } & PaginatedResponse>;
  listProjectMembers(projectId: string): Promise<{ members: ProjectMember[] }>;
  listAvailableProjectMembers(projectId: string): Promise<{ members: TeamMember[] }>;
  addProjectMember(projectId: string, input: { userId: string; role: ProjectMember["role"] }): Promise<{ member: ProjectMember }>;
  updateProjectMemberRole(projectId: string, userId: string, role: ProjectMember["role"]): Promise<{ member: ProjectMember }>;
  removeProjectMember(projectId: string, userId: string): Promise<{ member: ProjectMember }>;
  connectRepository(input: { kind: "local"; name: string; path: string } | { kind: "git"; name: string; url: string; token?: string } | { kind: "upload"; name: string }): Promise<{ repository: Repository }>;
  replaceRepository(input: { kind: "local"; name: string; path: string } | { kind: "git"; name: string; url: string; token?: string } | { kind: "upload"; name: string }): Promise<{ repository: Repository; pendingUpload?: boolean }>;
  listArchivedRepositories(): Promise<{ repositories: ArchivedRepository[] }>;
  uploadFolder(projectId: string, repositoryId: string, files: FolderImportFile[], options?: UploadFolderOptions): Promise<UploadSnapshotSummary>;
  uploadReplacementFolder(projectId: string, repositoryId: string, files: FolderImportFile[], options?: UploadFolderOptions): Promise<UploadSnapshotSummary>;
  getRepository(): Promise<{ repository: Repository | null }>;
  getRepositoryStatus(): Promise<RepositoryStatus>;
  syncRepository(): Promise<SnapshotSummary>;
  getProjectChanges(projectId: string): Promise<{ change: SnapshotChangeSummary | null }>;
  getProjectGraph<F extends ProjectGraphFormat = "tree">(projectId: string, format?: F, options?: ProjectGraphRequestOptions): Promise<ProjectGraphResponse<F>>;
  getProjectFrontendPreview(projectId: string): Promise<FrontendPreviewResponse>;
  getProjectFrontendPreviewSource(projectId: string, buildId: string, source: GraphSourceRef): Promise<SourceExcerpt>;
  getProjectKnowledgeQuality(projectId: string): Promise<ProjectKnowledgeQuality>;
  listProjectRemediations(projectId: string, params: RemediationListParams): Promise<{ remediations: Remediation[] }>;
  listProjectRemediationEvents(projectId: string, remediationId: string): Promise<{ events: RemediationEvent[] }>;
  transitionProjectRemediation(projectId: string, remediationId: string, input: { state: "accepted" | "dismissed" | "resolved"; reason?: string }): Promise<{ remediation: Remediation }>;
  requestProjectRemediationRebuild(projectId: string, remediationId: string): Promise<{ build: Build; created: boolean }>;
  listBuilds(pagination: PaginationParams): Promise<{ builds: Build[] } & PaginatedResponse>;
  getBuildStages(id: string): Promise<{
    buildId: string;
    legacyStatus: Build["status"];
    pipelineStatus: Build["status"] | null;
    stages: PipelineStageRun[];
  }>;
  getBuildComparison(id: string): Promise<{ buildId: string; comparison: KnowledgeKernelComparison }>;
  startBuild(snapshotId: string, options?: { allowLlm?: boolean }): Promise<{ build: Build; created: boolean }>;
  cancelBuild(id: string): Promise<{ build: Build }>;
  listReleases(pagination: PaginationParams): Promise<{ releases: Release[] } & PaginatedResponse>;
  getRelease(id: string): Promise<{ release: Release }>;
  currentRelease(): Promise<{ release: Release }>;
  createRelease(buildId: string, version: string): Promise<{ release: Release }>;
  publishRelease(id: string): Promise<{ release: Release }>;
  rollbackRelease(id: string): Promise<{ release: Release; previousReleaseId: string | null }>;
  listKnowledgePages(releaseId: string | undefined, pagination: PaginationParams):
    Promise<{ pages: KnowledgePageRecord[] } & PaginatedResponse>;
  getKnowledgePage(id: string): Promise<{ page: KnowledgePageRecord }>;
  searchKnowledge(query: string, releaseId?: string): Promise<{ results: SearchResult[] }>;
  getSource(input: { path: string; startLine: number; endLine: number; releaseId?: string }): Promise<SourceExcerpt>;
  getKnowledgeMetadata(releaseId: string): Promise<KnowledgeMetadata>;
  listFeedback(status: AgentFeedbackStatus | undefined, pagination: PaginationParams):
    Promise<{ feedback: Feedback[] } & PaginatedResponse>;
  transitionFeedback(id: string, status: AgentFeedbackStatus): Promise<{ feedback: Feedback }>;
  rebuildFeedback(id: string): Promise<{ build: Build; created: boolean }>;
  getMcpConnection(): Promise<McpConnection>;
  listMcpTokens(pagination: PaginationParams): Promise<{ tokens: McpToken[] } & PaginatedResponse>;
  listProjectMcpTokens(projectId: string, pagination: PaginationParams): Promise<{ tokens: McpToken[] } & PaginatedResponse>;
  getProjectCodexConnection(projectId: string): Promise<CodexConnectionPack>;
  createMcpToken(name: string, projectId: string, scopes?: McpToken["scopes"]): Promise<McpToken & { token: string }>;
  revokeMcpToken(id: string): Promise<{ token: McpToken }>;
  rotateMcpToken(id: string): Promise<{ previous: McpToken; replacement: McpToken; token: string }>;
  getWorkspaceMcpConnection(): Promise<McpConnection>;
  listWorkspaceMcpTokens(pagination: PaginationParams): Promise<{ tokens: WorkspaceMcpToken[] } & PaginatedResponse>;
  createWorkspaceMcpToken(
    name: string,
    scopes?: WorkspaceMcpToken["scopes"]
  ): Promise<WorkspaceMcpToken & { token: string }>;
  revokeWorkspaceMcpToken(id: string): Promise<{ token: WorkspaceMcpToken }>;
  rotateWorkspaceMcpToken(id: string): Promise<{
    previous: WorkspaceMcpToken; replacement: WorkspaceMcpToken; token: string;
  }>;
  listWorkspaceExperiences(input: {
    currentProjectId?: string;
    query?: string;
  }): Promise<WorkspaceExperienceLibraryResponse>;
  listExperienceReviewItems(): Promise<{ reviewItems: ExperienceReviewItemDto[] }>;
  runExperienceLint(): Promise<FrontendExperienceLintResponse>;
  previewFrontendSolution(
    projectId: string,
    input: { task: string; changedPaths?: string[] }
  ): Promise<{ context: FrontendSolutionContext }>;
  reviewExperience(
    experienceId: string,
    input: { action: string; reason: string; basisEvidenceIds: string[] }
  ): Promise<unknown>;
  getModelConfig(): Promise<{ config: ModelConfig | null }>;
  updateModelConfig(input: { provider: ModelProvider; model: string; apiKey: string }): Promise<{ config: ModelConfig }>;
  getMfaStatus(): Promise<MfaStatus>;
  enrollMfa(currentPassword: string): Promise<{ enabled: false; secret: string; otpauthUri: string }>;
  verifyMfa(code: string): Promise<{ enabled: true; recoveryCodes: string[] }>;
  disableMfa(input: { currentPassword: string; code: string }): Promise<void>;
}

const json = (value: unknown) => JSON.stringify(value);
function listPath(path: string, pagination: PaginationParams, values: Record<string, string | undefined> = {}) {
  const params = new URLSearchParams({
    limit: String(pagination.limit),
    offset: String(pagination.offset)
  });
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, value);
  }
  return `${path}?${params}`;
}

const UPLOAD_MANIFEST_PAGE_SIZE = 500;
const UPLOAD_RESUME_PREFIX = "devkh:upload-session:";

interface UploadSessionStart {
  id: string;
  status: "open" | "committing" | "committed" | "cancelled";
  entryCount: number;
  expiresAt: string;
}

interface UploadManifestDecision {
  ordinal: number;
  disposition: "upload_required" | "metadata_only" | "ignored";
  trust: "pending" | "server_verified" | "client_unverified";
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function resumeCreateKey(projectId: string, repositoryId: string, manifestDigest: string): {
  storage: Storage | undefined;
  key: string;
  createKey: string;
} {
  const storage = browserStorage();
  const key = `${UPLOAD_RESUME_PREFIX}${projectId}:${repositoryId}:${manifestDigest}`;
  const now = Date.now();
  try {
    const saved = storage?.getItem(key);
    if (saved) {
      const value = JSON.parse(saved) as { createKey?: string; createdAt?: number };
      if (value.createKey && value.createdAt && now - value.createdAt < 23 * 60 * 60 * 1_000) {
        return { storage, key, createKey: value.createKey };
      }
    }
  } catch {
    // A corrupt resume hint must not prevent a new upload.
  }
  const createKey = crypto.randomUUID();
  try {
    storage?.setItem(key, JSON.stringify({ createKey, createdAt: now }));
  } catch {
    // Upload remains usable when browser storage is unavailable.
  }
  return { storage, key, createKey };
}

async function uploadFolderSession(
  projectId: string,
  repositoryId: string,
  files: FolderImportFile[],
  options: UploadFolderOptions = {}
): Promise<UploadSnapshotSummary> {
  const manifest = await createUploadManifest(files);
  const sourceFiles = files.filter((file) => file.kind === "source");
  const totalFiles = sourceFiles.length;
  const totalBytes = sourceFiles.reduce((sum, file) => sum + file.file.size, 0);
  const verified = new Set<number>();
  let processedFiles = 0;
  let processedBytes = 0;
  let transferredBytesThisAttempt = 0;
  const startedAt = Date.now();
  const reportTransfer = (detail: string) => {
    const elapsedSeconds = Math.max((Date.now() - startedAt) / 1_000, 0.001);
    const bytesPerSecond = transferredBytesThisAttempt > 0
      ? Math.round(transferredBytesThisAttempt / elapsedSeconds)
      : undefined;
    const remainingBytes = Math.max(0, totalBytes - processedBytes);
    const percent = totalBytes > 0
      ? Math.min(100, Math.floor(processedBytes / totalBytes * 100))
      : totalFiles > 0 ? Math.min(100, Math.floor(processedFiles / totalFiles * 100)) : 100;
    options.onProgress?.({
      phase: "uploading", status: "running", percent,
      processedFiles, totalFiles, processedBytes, totalBytes,
      bytesPerSecond,
      estimatedSeconds: bytesPerSecond ? Math.ceil(remainingBytes / bytesPerSecond) : undefined,
      detail
    });
  };
  const markVerified = (ordinal: number, byteSize: number, detail?: string) => {
    if (verified.has(ordinal)) return;
    verified.add(ordinal);
    processedFiles += 1;
    processedBytes += byteSize;
    reportTransfer(detail ?? `已验证 ${processedFiles}/${totalFiles} 个源码文件`);
  };
  const resume = resumeCreateKey(projectId, repositoryId, manifest.manifestDigest);
  const base = `/api/projects/${encodeURIComponent(projectId)}/upload-sessions`;
  let session: UploadSessionStart | undefined;
  try {
    session = await request<UploadSessionStart>(base, {
      method: "POST",
      headers: { "Idempotency-Key": resume.createKey },
      body: json({ repositoryId, entryCount: manifest.entries.length })
    });
    reportTransfer(`上传会话保留至 ${new Date(session.expiresAt).toLocaleString("zh-CN")}`);
    for (let offset = 0; offset < manifest.entries.length; offset += UPLOAD_MANIFEST_PAGE_SIZE) {
      const page = Math.floor(offset / UPLOAD_MANIFEST_PAGE_SIZE);
      const response = await request<{ entries: UploadManifestDecision[] }>(
        `${base}/${encodeURIComponent(session.id)}/manifest-pages/${page}`,
        {
          method: "PUT",
          headers: { "Idempotency-Key": `${resume.createKey}:manifest:${page}` },
          body: json({ entries: manifest.entries.slice(offset, offset + UPLOAD_MANIFEST_PAGE_SIZE) })
        }
      );
      for (const decision of response.entries) {
        const source = files[decision.ordinal];
        if (!source || source.kind !== "source") {
          if (decision.disposition === "upload_required") {
            throw new Error("Upload manifest no longer matches selected files");
          }
          continue;
        }
        if (decision.disposition !== "upload_required") {
          markVerified(
            decision.ordinal,
            source.file.size,
            `服务端已处理 ${processedFiles + 1}/${totalFiles} 个源码文件`
          );
          continue;
        }
        if (decision.trust !== "server_verified") {
          await request(`${base}/${encodeURIComponent(session.id)}/files/${decision.ordinal}`, {
            method: "PUT",
            headers: {
              "Idempotency-Key": `${resume.createKey}:file:${decision.ordinal}`,
              "content-type": "application/octet-stream"
            },
            body: source.file
          });
          transferredBytesThisAttempt += source.file.size;
        }
        markVerified(decision.ordinal, source.file.size);
      }
    }
    options.onProgress?.({
      phase: "validating", status: "running", percent: 100,
      processedFiles, totalFiles, processedBytes, totalBytes,
      detail: "文件传输完成，正在执行服务端校验"
    });
    const result = await request<UploadSnapshotSummary>(`${base}/${encodeURIComponent(session.id)}/commit`, {
      method: "POST",
      headers: { "Idempotency-Key": `${resume.createKey}:commit` },
      body: json({ manifestDigest: manifest.manifestDigest })
    });
    try { resume.storage?.removeItem(resume.key); } catch { /* best-effort browser cleanup */ }
    return result;
  } catch (error) {
    const terminal = error instanceof ApiError && [
      "IDEMPOTENCY_KEY_REUSED", "UPLOAD_SESSION_EXPIRED", "UPLOAD_SESSION_INVALIDATED",
      "UPLOAD_SESSION_NOT_FOUND", "UPLOAD_SESSION_STATE"
    ].includes(error.code);
    if (terminal) {
      try { resume.storage?.removeItem(resume.key); } catch { /* best-effort browser cleanup */ }
      if (session) {
        await request(`${base}/${encodeURIComponent(session.id)}`, {
          method: "DELETE",
          headers: { "Idempotency-Key": `${resume.createKey}:cancel-terminal` }
        }).catch(() => undefined);
      }
    }
    throw error;
  }
}

export const api: ApiClient = {
  setupStatus: () => request("/api/setup/status"),
  setup: (input) => request("/api/setup", { method: "POST", body: json(input) }),
  login: (input) => request("/api/session", { method: "POST", body: json(input) }),
  session: () => request("/api/session"),
  logout: () => request("/api/session", { method: "DELETE" }),
  listMembers: () => request("/api/members"),
  createMember: (input) => request("/api/members", { method: "POST", body: json(input) }),
  resetMemberPassword: (userId, password) => request(`/api/members/${userId}/password`, { method: "PATCH", body: json({ password }) }),
  setMemberDisabled: (userId, disabled) => request(`/api/members/${userId}/disabled`, { method: "PATCH", body: json({ disabled }) }),
  listProjects: () => request("/api/projects"),
  workspaceOverview: () => request("/api/workspace/overview"),
  searchWorkspaceKnowledge: (query) => request(`/api/workspace/knowledge/search?q=${encodeURIComponent(query)}`),
  createProject: (input) => request("/api/projects", { method: "POST", body: json(input) }),
  getProjectSummary: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/summary`),
  listImportReports: (projectId, pagination) => request(listPath(
    `/api/projects/${encodeURIComponent(projectId)}/import-reports`, pagination
  )),
  listProjectActivity: (projectId, pagination) => request(listPath(
    `/api/projects/${encodeURIComponent(projectId)}/activity`,
    pagination
  )),
  listProjectMembers: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/members`),
  listAvailableProjectMembers: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/available-members`),
  addProjectMember: (projectId, input) => request(`/api/projects/${encodeURIComponent(projectId)}/members`, {
    method: "POST", body: json(input)
  }),
  updateProjectMemberRole: (projectId, userId, role) => request(
    `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
    { method: "PATCH", body: json({ role }) }
  ),
  removeProjectMember: (projectId, userId) => request(
    `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" }
  ),
  connectRepository: (input) => {
    const projectId = activeProjectId();
    return request(projectId ? `/api/projects/${encodeURIComponent(projectId)}/repositories` : "/api/repositories", {
      method: "POST", body: json(input)
    });
  },
  replaceRepository: (input) => request("/api/repositories/current/replace", { method: "POST", body: json(input) }),
  listArchivedRepositories: () => request("/api/repositories/archived"),
  uploadFolder: uploadFolderSession,
  uploadReplacementFolder: uploadFolderSession,
  getRepository: () => request("/api/repositories/current"),
  getRepositoryStatus: () => request("/api/repositories/current/status"),
  syncRepository: () => request("/api/repositories/current/sync", { method: "POST" }),
  getProjectChanges: (projectId) => request(`/api/projects/${projectId}/changes`),
  getProjectGraph: <F extends ProjectGraphFormat = "tree">(projectId: string, format: F = "tree" as F, options?: ProjectGraphRequestOptions) => {
    const params = new URLSearchParams({ format });
    if (options?.releaseId) params.set("releaseId", options.releaseId);
    return request<ProjectGraphResponse<F>>(`/api/projects/${encodeURIComponent(projectId)}/graph?${params}`);
  },
  getProjectFrontendPreview: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/frontend-preview`),
  getProjectFrontendPreviewSource: (projectId, buildId, source) => {
    const params = new URLSearchParams({
      buildId, path: source.path, startLine: String(source.startLine), endLine: String(source.endLine)
    });
    return request(`/api/projects/${encodeURIComponent(projectId)}/frontend-preview/source?${params}`);
  },
  getProjectKnowledgeQuality: (projectId) => request(`/api/projects/${projectId}/knowledge-quality`),
  listProjectRemediations: (projectId, params) => request(listPath(
    `/api/projects/${encodeURIComponent(projectId)}/remediations`, params, {
      state: params.state,
      severity: params.severity,
      rule: params.rule
    }
  )),
  listProjectRemediationEvents: (projectId, remediationId) => request(
    `/api/projects/${encodeURIComponent(projectId)}/remediations/${encodeURIComponent(remediationId)}/events`
  ),
  transitionProjectRemediation: (projectId, remediationId, input) => request(
    `/api/projects/${encodeURIComponent(projectId)}/remediations/${encodeURIComponent(remediationId)}`,
    { method: "PATCH", body: json(input) }
  ),
  requestProjectRemediationRebuild: (projectId, remediationId) => request(
    `/api/projects/${encodeURIComponent(projectId)}/remediations/${encodeURIComponent(remediationId)}/rebuild`,
    { method: "POST" }
  ),
  listBuilds: (pagination) => request(listPath("/api/builds", pagination)),
  getBuildStages: (id) => request(`/api/builds/${encodeURIComponent(id)}/stages`),
  getBuildComparison: (id) => request(`/api/builds/${encodeURIComponent(id)}/comparison`),
  startBuild: (snapshotId, options) => request("/api/builds", {
    method: "POST",
    body: json({ snapshotId, ...(options?.allowLlm ? { allowLlm: true } : {}) })
  }),
  cancelBuild: (id) => request(`/api/builds/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  listReleases: (pagination) => request(listPath("/api/releases", pagination)),
  getRelease: (id) => request(`/api/releases/${encodeURIComponent(id)}`),
  currentRelease: () => request("/api/releases/current"),
  createRelease: (buildId, version) => request("/api/releases", { method: "POST", body: json({ buildId, version }) }),
  publishRelease: (id) => request(`/api/releases/${encodeURIComponent(id)}/publish`, { method: "POST" }),
  rollbackRelease: (id) => request(`/api/releases/${encodeURIComponent(id)}/rollback`, { method: "POST" }),
  listKnowledgePages: (releaseId, pagination) => request(listPath(
    "/api/knowledge/pages",
    pagination,
    { releaseId }
  )),
  getKnowledgePage: (id) => request(`/api/knowledge/pages/${encodeURIComponent(id)}`),
  searchKnowledge: (query, releaseId) => {
    const params = new URLSearchParams({ q: query });
    if (releaseId) params.set("releaseId", releaseId);
    return request(`/api/knowledge/search?${params}`);
  },
  getSource: (input) => {
    const params = new URLSearchParams({ path: input.path, startLine: String(input.startLine), endLine: String(input.endLine) });
    if (input.releaseId) params.set("releaseId", input.releaseId);
    return request(`/api/knowledge/source?${params}`);
  },
  getKnowledgeMetadata: (releaseId) => request(`/api/knowledge/metadata?releaseId=${encodeURIComponent(releaseId)}`),
  listFeedback: (status, pagination) => request(listPath("/api/feedback", pagination, { status })),
  transitionFeedback: (id, status) => request(`/api/feedback/${id}`, { method: "PATCH", body: json({ status }) }),
  rebuildFeedback: (id) => request(`/api/feedback/${id}/rebuild`, { method: "POST" }),
  getMcpConnection: () => request("/api/mcp/connection"),
  listMcpTokens: (pagination) => request(listPath("/api/mcp/tokens", pagination)),
  listProjectMcpTokens: (projectId, pagination) => request(listPath("/api/mcp/tokens", pagination, { projectId })),
  getProjectCodexConnection: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/codex-connection`),
  createMcpToken: (name, projectId, scopes) => request("/api/mcp/tokens", { method: "POST", body: json({ name, projectId, ...(scopes ? { scopes } : {}) }) }),
  revokeMcpToken: (id) => request(`/api/mcp/tokens/${id}/revoke`, { method: "POST" }),
  rotateMcpToken: (id) => request(`/api/mcp/tokens/${encodeURIComponent(id)}/rotate`, { method: "POST" }),
  getWorkspaceMcpConnection: () => request("/api/workspace/mcp/connection"),
  listWorkspaceMcpTokens: (pagination) => request(listPath("/api/workspace/mcp/tokens", pagination)),
  createWorkspaceMcpToken: (name, scopes) => request("/api/workspace/mcp/tokens", {
    method: "POST", body: json({ name, ...(scopes ? { scopes } : {}) })
  }),
  revokeWorkspaceMcpToken: (id) => request(`/api/workspace/mcp/tokens/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
  rotateWorkspaceMcpToken: (id) => request(`/api/workspace/mcp/tokens/${encodeURIComponent(id)}/rotate`, { method: "POST" }),
  listWorkspaceExperiences: (input) => {
    const params = new URLSearchParams();
    if (input.currentProjectId) params.set("currentProjectId", input.currentProjectId);
    if (input.query) params.set("query", input.query);
    return request(`/api/knowledge/experiences${params.size ? `?${params}` : ""}`);
  },
  listExperienceReviewItems: () => request("/api/knowledge/experience-review-items"),
  runExperienceLint: () => request("/api/knowledge/experience-lint", { method: "POST" }),
  previewFrontendSolution: (projectId, input) => request(
    `/api/projects/${encodeURIComponent(projectId)}/frontend-solution-context`,
    { method: "POST", body: json(input) }
  ),
  reviewExperience: (experienceId, input) => request(
    `/api/knowledge/experiences/${encodeURIComponent(experienceId)}/reviews`,
    { method: "POST", body: json({ ...input, decisionId: null, supersededById: null }) }
  ),
  getModelConfig: () => request("/api/settings/model"),
  updateModelConfig: (input) => request("/api/settings/model", { method: "PUT", body: json(input) }),
  getMfaStatus: () => request("/api/settings/mfa"),
  enrollMfa: (currentPassword) => request("/api/settings/mfa/enroll", { method: "POST", body: json({ currentPassword }) }),
  verifyMfa: (code) => request("/api/settings/mfa/verify", { method: "POST", body: json({ code }) }),
  disableMfa: (input) => request("/api/settings/mfa", { method: "DELETE", body: json(input) })
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}
