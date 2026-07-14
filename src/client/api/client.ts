import type {
  ApiErrorShape, Build, Feedback, McpConnection, McpToken, KnowledgePageRecord,
  ArchivedRepository, KnowledgeMetadata, ProjectKnowledgeQuality, Release, Repository, RepositoryStatus, SearchResult, Session, SnapshotChangeSummary, SnapshotSummary, SourceExcerpt,
  UploadSnapshotSummary, ImportReport, TeamMember, ProjectMember, Project, ProjectSummary, ProjectActivity, CodexConnectionPack,
  WorkspaceOverview, WorkspaceSearchResult
} from "./types";
import type { ModelConfig, ModelProvider } from "./types";
import type { AgentFeedbackStatus } from "../../server/persistence/store";
import type { ResumableUploadApi, ResumableUploadStatus } from "./resumable-upload";

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

export interface PaginatedResponse {
  total: number;
  nextOffset: number | null;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const projectId = activeProjectId();
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(projectId ? { "x-devkh-project": projectId } : {}),
      ...(typeof init?.body === "string" ? { "content-type": "application/json" } : {}),
      ...init?.headers
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ApiErrorShape | null;
    throw new ApiError(response.status, body?.error.code ?? "REQUEST_FAILED", body?.error.message ?? "Request failed", body?.error);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export interface ApiClient extends ResumableUploadApi {
  setupStatus(): Promise<{ setupRequired: boolean }>;
  setup(input: { email: string; password: string }): Promise<unknown>;
  login(input: { email: string; password: string }): Promise<Session>;
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
  uploadZip(file: File): Promise<UploadSnapshotSummary>;
  uploadReplacementZip(repositoryId: string, file: File): Promise<UploadSnapshotSummary>;
  getRepository(): Promise<{ repository: Repository | null }>;
  getRepositoryStatus(): Promise<RepositoryStatus>;
  syncRepository(): Promise<SnapshotSummary>;
  getProjectChanges(projectId: string): Promise<{ change: SnapshotChangeSummary | null }>;
  getProjectKnowledgeQuality(projectId: string): Promise<ProjectKnowledgeQuality>;
  listBuilds(pagination: PaginationParams): Promise<{ builds: Build[] } & PaginatedResponse>;
  startBuild(snapshotId: string): Promise<{ build: Build; created: boolean }>;
  cancelBuild(id: string): Promise<{ build: Build }>;
  listReleases(pagination: PaginationParams): Promise<{ releases: Release[] } & PaginatedResponse>;
  getRelease(id: string): Promise<{ release: Release }>;
  currentRelease(): Promise<{ release: Release }>;
  createRelease(buildId: string, version: string): Promise<{ release: Release }>;
  publishRelease(id: string): Promise<{ release: Release }>;
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
  createMcpToken(name: string, projectId: string): Promise<McpToken & { token: string }>;
  revokeMcpToken(id: string): Promise<{ token: McpToken }>;
  getModelConfig(): Promise<{ config: ModelConfig | null }>;
  updateModelConfig(input: { provider: ModelProvider; model: string; apiKey: string }): Promise<{ config: ModelConfig }>;
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
  uploadZip: (file) => {
    const data = new FormData();
    data.append("file", file, file.name);
    return request("/api/repositories/current/uploads", { method: "POST", body: data });
  },
  uploadReplacementZip: (repositoryId, file) => {
    const data = new FormData();
    data.append("file", file, file.name);
    return request(`/api/repositories/${encodeURIComponent(repositoryId)}/uploads`, { method: "POST", body: data });
  },
  createResumableUpload: (input) => request<ResumableUploadStatus>("/api/uploads/resumable", { method: "POST", body: json(input) }),
  getResumableUpload: (id) => request<ResumableUploadStatus>(`/api/uploads/resumable/${encodeURIComponent(id)}`),
  uploadResumableChunk: (id, index, content) => request<ResumableUploadStatus>(
    `/api/uploads/resumable/${encodeURIComponent(id)}/chunks/${index}`,
    {
      method: "PUT",
      body: content,
      headers: {
        "content-type": "application/octet-stream",
        "x-upload-chunk-size": String(content.size)
      }
    }
  ),
  importResumableUpload: (projectId, id) => request(
    `/api/projects/${encodeURIComponent(projectId)}/uploads/resumable/${encodeURIComponent(id)}/import`,
    { method: "POST" }
  ),
  importResumableReplacementUpload: (repositoryId, id) => request(
    `/api/repositories/${encodeURIComponent(repositoryId)}/uploads/resumable/${encodeURIComponent(id)}/import`,
    { method: "POST" }
  ),
  getRepository: () => request("/api/repositories/current"),
  getRepositoryStatus: () => request("/api/repositories/current/status"),
  syncRepository: () => request("/api/repositories/current/sync", { method: "POST" }),
  getProjectChanges: (projectId) => request(`/api/projects/${projectId}/changes`),
  getProjectKnowledgeQuality: (projectId) => request(`/api/projects/${projectId}/knowledge-quality`),
  listBuilds: (pagination) => request(listPath("/api/builds", pagination)),
  startBuild: (snapshotId) => request("/api/builds", { method: "POST", body: json({ snapshotId }) }),
  cancelBuild: (id) => request(`/api/builds/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  listReleases: (pagination) => request(listPath("/api/releases", pagination)),
  getRelease: (id) => request(`/api/releases/${encodeURIComponent(id)}`),
  currentRelease: () => request("/api/releases/current"),
  createRelease: (buildId, version) => request("/api/releases", { method: "POST", body: json({ buildId, version }) }),
  publishRelease: (id) => request(`/api/releases/${encodeURIComponent(id)}/publish`, { method: "POST" }),
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
  createMcpToken: (name, projectId) => request("/api/mcp/tokens", { method: "POST", body: json({ name, projectId }) }),
  revokeMcpToken: (id) => request(`/api/mcp/tokens/${id}/revoke`, { method: "POST" }),
  getModelConfig: () => request("/api/settings/model"),
  updateModelConfig: (input) => request("/api/settings/model", { method: "PUT", body: json(input) })
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}
