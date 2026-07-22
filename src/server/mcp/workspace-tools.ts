import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { APP_VERSION, SERVICE_NAME } from "../../shared/contracts.js";
import type { FrontendProjectProfile } from "../../shared/frontend-project-profile.js";
import { frontendProjectProfileSchema } from "../../shared/frontend-project-profile.js";
import type { FrontendSolutionContext } from "../../shared/frontend-solution-context.js";
import { frontendPipelinePackageSchema } from "../knowledge/frontend/compatibility.js";
import { queryExperienceProjection } from "../knowledge/frontend/experience-query.js";
import type { ArtifactManifest } from "../knowledge/pipeline/contracts.js";
import type { AppStore, WorkspaceMcpTokenScope } from "../persistence/store.js";

export const WORKSPACE_MCP_TOOL_NAMES = [
  "dkh_find_prior_implementations", "dkh_plan_frontend_solution"
] as const;
export type WorkspaceMcpToolName = (typeof WORKSPACE_MCP_TOOL_NAMES)[number];

export type WorkspaceToolErrorCode =
  | "INVALID_INPUT"
  | "PROJECT_ACCESS_DENIED"
  | "WORKSPACE_TOKEN_EXPIRED"
  | "EXPERIENCE_EVIDENCE_REVOKED"
  | "CITATIONS_MISSING"
  | "UNAUTHORIZED"
  | "INTERNAL_ERROR";

export class WorkspaceToolError extends Error {
  constructor(readonly code: WorkspaceToolErrorCode, message: string) {
    super(message);
  }
}

export interface WorkspaceMcpToolContext {
  store: AppStore;
  workspaceId: string;
  userId: string;
  scopes: readonly WorkspaceMcpTokenScope[];
  artifactReader?: { getJson(manifest: ArtifactManifest): Promise<unknown> };
  authorize?: () => Promise<boolean>;
  onUnauthorized?: () => Promise<void> | void;
}

const safePathSchema = z.string().trim().min(1).max(500).refine((value) =>
  !value.startsWith("/") && !value.includes("\\")
  && !value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
"Changed path must be a safe project-relative path");
const findInputSchema = z.object({
  currentProjectId: z.uuid(),
  query: z.string().trim().min(1).max(500)
}).strict();
const solutionInputSchema = z.object({
  currentProjectId: z.uuid(),
  task: z.string().trim().min(1).max(2_000),
  changedPaths: z.array(safePathSchema).max(50).optional().default([])
}).strict();

function stringValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (value && typeof value === "object") return Object.entries(value)
    .map(([key, item]) => `${key}: ${Array.isArray(item) ? item.join(", ") : String(item)}`).join("; ");
  return String(value);
}

async function resolveCurrentProject(input: {
  context: WorkspaceMcpToolContext;
  currentProjectId: string;
}): Promise<{
  currentProject: FrontendSolutionContext["currentProject"];
  profile: FrontendProjectProfile | null;
}> {
  const access = await input.context.store.projectAccess(
    input.context.workspaceId, input.currentProjectId, input.context.userId
  );
  if (!access || access.project.archivedAt !== null) {
    throw new WorkspaceToolError("PROJECT_ACCESS_DENIED", "Current project is not accessible");
  }
  const repository = await input.context.store.currentRepository(
    input.context.workspaceId, input.currentProjectId
  );
  const release = repository
    ? await input.context.store.currentRelease(input.context.workspaceId, repository.id)
    : null;
  if (!repository || !release?.publishedAt) {
    return {
      currentProject: {
        projectId: input.currentProjectId, releaseId: null, sourceVersion: null, status: "no_release"
      },
      profile: null
    };
  }
  const [snapshot, latestSnapshot] = await Promise.all([
    input.context.store.findSnapshotById(input.context.workspaceId, release.snapshotId),
    input.context.store.latestSnapshot(input.context.workspaceId, repository.id)
  ]);
  const base = {
    projectId: input.currentProjectId,
    releaseId: release.id,
    sourceVersion: snapshot?.contentVersion ?? snapshot?.commitSha ?? null
  };
  if (!snapshot || release.releaseArtifactFamily !== "frontend-v2" || !release.packageArtifactId
    || !input.context.artifactReader) {
    return { currentProject: { ...base, status: "unsupported" }, profile: null };
  }
  try {
    const packageManifest = await input.context.store.findArtifactById(release.packageArtifactId);
    if (!packageManifest) throw new Error("package missing");
    const packageValue = frontendPipelinePackageSchema.parse(
      await input.context.artifactReader.getJson(packageManifest)
    );
    const profileManifest = await input.context.store.findArtifactById(packageValue.projectProfileArtifactId);
    if (!profileManifest) throw new Error("profile missing");
    const profile = frontendProjectProfileSchema.parse(
      await input.context.artifactReader.getJson(profileManifest)
    );
    return {
      currentProject: {
        ...base, status: latestSnapshot && latestSnapshot.id !== release.snapshotId ? "stale" : "ready"
      },
      profile
    };
  } catch {
    return { currentProject: { ...base, status: "unsupported" }, profile: null };
  }
}

const profileSections = [
  "framework", "rendering", "router", "state", "data", "formLibrary", "tooling",
  "styles", "visualizations", "tests", "workspace"
] as const;

function profileContext(profile: FrontendProjectProfile | null): Pick<
  FrontendSolutionContext,
  "currentProjectFacts" | "hardConstraints" | "unknowns"
> {
  if (!profile) return {
    currentProjectFacts: [], hardConstraints: [],
    unknowns: [{ key: "frontend-project-profile", reason: "Project profile is unavailable", requiredForRecommendation: true }]
  };
  const currentProjectFacts: FrontendSolutionContext["currentProjectFacts"] = [];
  const hardConstraints: FrontendSolutionContext["hardConstraints"] = [];
  const unknowns: FrontendSolutionContext["unknowns"] = [];
  for (const key of profileSections) {
    const entry = profile[key];
    if (entry.state === "known") {
      currentProjectFacts.push({ key, label: key, value: stringValue(entry.value), citations: profile.sourceRefs });
      if (["framework", "rendering", "tooling", "workspace"].includes(key)) {
        hardConstraints.push({
          key, statement: `Keep the solution compatible with ${key}: ${stringValue(entry.value)}`,
          citations: profile.sourceRefs
        });
      }
    } else {
      unknowns.push({ key, reason: entry.reason, requiredForRecommendation: [
        "framework", "rendering", "tooling"
      ].includes(key) });
    }
  }
  return { currentProjectFacts, hardConstraints, unknowns };
}

export async function buildSolutionContext(input: {
  context: WorkspaceMcpToolContext;
  currentProjectId: string;
  task: string;
  changedPaths: string[];
}): Promise<FrontendSolutionContext> {
  const selected = await resolveCurrentProject(input);
  const profile = profileContext(selected.profile);
  const experiences = selected.profile
    ? await queryExperienceProjection({
      store: input.context.store, workspaceId: input.context.workspaceId,
      userId: input.context.userId, currentProjectId: input.currentProjectId,
      currentProfile: selected.profile, query: input.task
    })
    : { applicableExperiences: [], rejectedExperiences: [] };
  if (experiences.applicableExperiences.some((item) => item.citations.length === 0)) {
    throw new WorkspaceToolError("CITATIONS_MISSING", "Applicable experience has no citation");
  }
  const citations = selected.profile?.sourceRefs ?? [];
  return {
    schemaVersion: 1,
    currentProject: selected.currentProject,
    ...profile,
    applicableExperiences: experiences.applicableExperiences.map((item) => ({
      id: item.id, title: item.title, capability: item.capability, state: item.state,
      observedFacts: item.observedFacts, evidenceCount: item.evidenceCount,
      trustScore: item.trustScore, citations: item.citations
    })),
    rejectedExperiences: experiences.rejectedExperiences,
    changeImpact: input.changedPaths.map((path) => ({
      path, reason: `Task may change ${path}`, citations
    })),
    verificationPlan: [
      { step: "Run focused tests for changed frontend paths", reason: "Verify task behavior", citations },
      { step: "Run typecheck and production build", reason: "Verify project constraints", citations }
    ]
  };
}

export async function executeWorkspaceTool(
  context: WorkspaceMcpToolContext,
  name: WorkspaceMcpToolName,
  rawInput: unknown
): Promise<CallToolResult> {
  const requiredScope: WorkspaceMcpTokenScope = name === "dkh_plan_frontend_solution"
    ? "workspace.solutions.read"
    : "workspace.patterns.read";
  if (!context.scopes.includes(requiredScope)) {
    throw new WorkspaceToolError("UNAUTHORIZED", "Workspace token scope is insufficient");
  }
  const schema = name === "dkh_plan_frontend_solution" ? solutionInputSchema : findInputSchema;
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) throw new WorkspaceToolError("INVALID_INPUT", "Workspace tool input is invalid");
  const value = parsed.data;
  const solution = await buildSolutionContext({
    context, currentProjectId: value.currentProjectId,
    task: "task" in value ? value.task : value.query,
    changedPaths: "changedPaths" in value ? value.changedPaths : []
  });
  const result = name === "dkh_plan_frontend_solution" ? solution : {
    schemaVersion: 1,
    currentProject: solution.currentProject,
    priorImplementations: solution.applicableExperiences,
    rejectedExperiences: solution.rejectedExperiences
  };
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result as unknown as Record<string, unknown>
  };
}

function failed(error: unknown): CallToolResult {
  const value = error instanceof WorkspaceToolError ? error : new WorkspaceToolError("INTERNAL_ERROR", "Workspace MCP tool failed");
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code: value.code, message: value.message } }) }]
  };
}

export function createRegisteredWorkspaceMcpServer(context: WorkspaceMcpToolContext): McpServer {
  const server = new McpServer({ name: `${SERVICE_NAME}-workspace`, version: APP_VERSION });
  const tools = [
    {
      name: "dkh_find_prior_implementations" as const,
      description: "Find applicable prior frontend implementations outside the current project",
      schema: findInputSchema,
      scope: "workspace.patterns.read" as const
    },
    {
      name: "dkh_plan_frontend_solution" as const,
      description: "Build cited current-project facts, constraints, experience references and verification context",
      schema: solutionInputSchema,
      scope: "workspace.solutions.read" as const
    }
  ].filter((tool) => context.scopes.includes(tool.scope));
  server.server.registerCapabilities({ tools: {} });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name, description: tool.description,
      inputSchema: z.toJSONSchema(tool.schema) as { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    }))
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((candidate) => candidate.name === request.params.name);
    if (!tool) throw new McpError(ErrorCode.MethodNotFound, "Unknown workspace MCP tool");
    if (context.authorize && !await context.authorize()) {
      void context.onUnauthorized?.();
      return failed(new WorkspaceToolError("UNAUTHORIZED", "Workspace token is invalid or revoked"));
    }
    try {
      return await executeWorkspaceTool(context, tool.name, request.params.arguments ?? {});
    } catch (error) {
      return failed(error);
    }
  });
  return server;
}
