import type {
  ApiErrorShape, Build, Feedback, McpConnection, McpToken, KnowledgePageRecord,
  KnowledgeMetadata, Release, Repository, RepositoryStatus, SearchResult, Session, SnapshotSummary, SourceExcerpt
} from "./types";
import type { ModelConfig, ModelProvider } from "./types";
import type { AgentFeedbackStatus } from "../../server/persistence/store";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: ApiErrorShape["error"]) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ApiErrorShape | null;
    throw new ApiError(response.status, body?.error.code ?? "REQUEST_FAILED", body?.error.message ?? "Request failed", body?.error);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export interface ApiClient {
  setupStatus(): Promise<{ setupRequired: boolean }>;
  setup(input: { email: string; password: string }): Promise<unknown>;
  login(input: { email: string; password: string }): Promise<Session>;
  session(): Promise<Session>;
  logout(): Promise<void>;
  connectRepository(input: { kind: "local"; name: string; path: string } | { kind: "git"; name: string; url: string; token?: string }): Promise<{ repository: Repository }>;
  getRepository(): Promise<{ repository: Repository }>;
  getRepositoryStatus(): Promise<RepositoryStatus>;
  syncRepository(): Promise<SnapshotSummary>;
  listBuilds(): Promise<{ builds: Build[] }>;
  startBuild(snapshotId: string): Promise<{ build: Build; created: boolean }>;
  cancelBuild(id: string): Promise<{ build: Build }>;
  listReleases(): Promise<{ releases: Release[] }>;
  currentRelease(): Promise<{ release: Release }>;
  createRelease(buildId: string, version: string): Promise<{ release: Release }>;
  publishRelease(id: string): Promise<{ release: Release }>;
  listKnowledgePages(releaseId?: string): Promise<{ pages: KnowledgePageRecord[] }>;
  getKnowledgePage(id: string): Promise<{ page: KnowledgePageRecord }>;
  searchKnowledge(query: string, releaseId?: string): Promise<{ results: SearchResult[] }>;
  getSource(input: { path: string; startLine: number; endLine: number; releaseId?: string }): Promise<SourceExcerpt>;
  getKnowledgeMetadata(releaseId: string): Promise<KnowledgeMetadata>;
  listFeedback(status?: AgentFeedbackStatus): Promise<{ feedback: Feedback[] }>;
  transitionFeedback(id: string, status: AgentFeedbackStatus): Promise<{ feedback: Feedback }>;
  rebuildFeedback(id: string): Promise<{ build: Build; created: boolean }>;
  getMcpConnection(): Promise<McpConnection>;
  listMcpTokens(): Promise<{ tokens: McpToken[] }>;
  createMcpToken(name: string): Promise<McpToken & { token: string }>;
  revokeMcpToken(id: string): Promise<{ token: McpToken }>;
  getModelConfig(): Promise<{ config: ModelConfig | null }>;
  updateModelConfig(input: { provider: ModelProvider; model: string; apiKey: string }): Promise<{ config: ModelConfig }>;
}

const json = (value: unknown) => JSON.stringify(value);
export const api: ApiClient = {
  setupStatus: () => request("/api/setup/status"),
  setup: (input) => request("/api/setup", { method: "POST", body: json(input) }),
  login: (input) => request("/api/session", { method: "POST", body: json(input) }),
  session: () => request("/api/session"),
  logout: () => request("/api/session", { method: "DELETE" }),
  connectRepository: (input) => request("/api/repositories", { method: "POST", body: json(input) }),
  getRepository: () => request("/api/repositories/current"),
  getRepositoryStatus: () => request("/api/repositories/current/status"),
  syncRepository: () => request("/api/repositories/current/sync", { method: "POST" }),
  listBuilds: () => request("/api/builds"),
  startBuild: (snapshotId) => request("/api/builds", { method: "POST", body: json({ snapshotId }) }),
  cancelBuild: (id) => request(`/api/builds/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  listReleases: () => request("/api/releases"),
  currentRelease: () => request("/api/releases/current"),
  createRelease: (buildId, version) => request("/api/releases", { method: "POST", body: json({ buildId, version }) }),
  publishRelease: (id) => request(`/api/releases/${encodeURIComponent(id)}/publish`, { method: "POST" }),
  listKnowledgePages: (releaseId) => request(`/api/knowledge/pages${releaseId ? `?releaseId=${encodeURIComponent(releaseId)}` : ""}`),
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
  listFeedback: (status) => request(`/api/feedback${status ? `?status=${status}` : ""}`),
  transitionFeedback: (id, status) => request(`/api/feedback/${id}`, { method: "PATCH", body: json({ status }) }),
  rebuildFeedback: (id) => request(`/api/feedback/${id}/rebuild`, { method: "POST" }),
  getMcpConnection: () => request("/api/mcp/connection"),
  listMcpTokens: () => request("/api/mcp/tokens"),
  createMcpToken: (name) => request("/api/mcp/tokens", { method: "POST", body: json({ name }) }),
  revokeMcpToken: (id) => request(`/api/mcp/tokens/${id}/revoke`, { method: "POST" }),
  getModelConfig: () => request("/api/settings/model"),
  updateModelConfig: (input) => request("/api/settings/model", { method: "PUT", body: json(input) })
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}
