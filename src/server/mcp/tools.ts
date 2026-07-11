import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ToolAnnotations
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { APP_VERSION, SERVICE_NAME } from "../../shared/contracts.js";
import type { Citation } from "../knowledge/intelligence.js";
import type {
  AppStore,
  KnowledgePageRecord,
  KnowledgeSearchResult,
  ReleaseRecord
} from "../persistence/store.js";

export const MCP_TOOL_NAMES = [
  "dkh_search",
  "dkh_get_architecture",
  "dkh_get_module",
  "dkh_get_symbol",
  "dkh_get_change_context",
  "dkh_get_source",
  "dkh_get_release",
  "dkh_report_gap"
] as const;

export interface McpToolContext {
  store: AppStore;
  workspaceId: string;
}

class McpToolError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "UNPUBLISHED" | "NOT_FOUND" | "CITATIONS_MISSING",
    message: string,
    readonly details?: Array<{ path: string; code: string }>
  ) {
    super(message);
  }
}

function uniqueCitations(citations: Citation[]): Citation[] {
  return [...new Map(citations.map((citation) => [
    `${citation.path}:${citation.startLine}:${citation.endLine}:${citation.commitSha}:${citation.blobHash}`,
    citation
  ])).values()];
}

function pageCitations(page: KnowledgePageRecord): Citation[] {
  return uniqueCitations(page.chunks.flatMap((chunk) => chunk.citations));
}

function successful(
  release: ReleaseRecord,
  commitSha: string,
  result: unknown,
  citations: Citation[],
  requireCitations = true
) {
  if (requireCitations && !citations.length) {
    throw new McpToolError("CITATIONS_MISSING", "Published knowledge has no citations");
  }
  const envelope = { releaseId: release.id, commitSha, result, citations: uniqueCitations(citations) };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
    structuredContent: envelope as Record<string, unknown>
  };
}

function failed(error: unknown) {
  const body = error instanceof McpToolError
    ? {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {})
        }
      }
    : { error: { code: "INTERNAL_ERROR", message: "MCP tool failed" } };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(body) }]
  };
}

async function published(context?: McpToolContext) {
  if (!context) throw new McpToolError("UNPUBLISHED", "MCP knowledge context is unavailable");
  const repository = await context.store.currentRepository(context.workspaceId);
  if (!repository) throw new McpToolError("UNPUBLISHED", "No knowledge release is published");
  const release = await context.store.currentRelease(context.workspaceId, repository.id);
  if (!release?.publishedAt) throw new McpToolError("UNPUBLISHED", "No knowledge release is published");
  const snapshot = await context.store.findSnapshotById(context.workspaceId, release.snapshotId);
  if (!snapshot) throw new McpToolError("NOT_FOUND", "Published snapshot was not found");
  return { context, repository, release, snapshot };
}

async function pagesFor(context: McpToolContext, release: ReleaseRecord) {
  return context.store.listKnowledgePages(context.workspaceId, release.id);
}

const taskStopWords = new Set([
  "a", "an", "and", "change", "for", "in", "of", "on", "the", "to", "update", "with"
]);

function taskTerms(task: string): string[] {
  return [...new Set(task.toLowerCase().match(/[a-z0-9_.-]+/g) ?? [])]
    .filter((term) => term.length >= 3 && !taskStopWords.has(term))
    .slice(0, 12);
}

function mergeSearchResults(results: KnowledgeSearchResult[]): KnowledgeSearchResult[] {
  const merged = new Map<string, KnowledgeSearchResult>();
  for (const result of results) {
    const existing = merged.get(result.pageId);
    if (!existing) {
      merged.set(result.pageId, result);
      continue;
    }
    existing.citations = uniqueCitations([...existing.citations, ...result.citations]);
    if (result.score > existing.score) {
      existing.score = result.score;
      existing.kind = result.kind;
      existing.title = result.title;
      existing.excerpt = result.excerpt;
    }
  }
  return [...merged.values()].sort((left, right) =>
    right.score - left.score || left.title.localeCompare(right.title) || left.pageId.localeCompare(right.pageId));
}

async function readSource(
  context: McpToolContext,
  release: ReleaseRecord,
  filePath: string,
  startLine?: number,
  endLine?: number
) {
  const snapshot = await context.store.findSnapshotById(context.workspaceId, release.snapshotId);
  const sourceFile = await context.store.findSourceFile(context.workspaceId, release.snapshotId, filePath);
  if (!snapshot || !sourceFile) throw new McpToolError("NOT_FOUND", "Source file was not found");
  const root = await fs.realpath(snapshot.storagePath);
  const candidate = await fs.realpath(path.resolve(root, filePath)).catch(() => null);
  if (!candidate || (!candidate.startsWith(`${root}${path.sep}`) && candidate !== root)) {
    throw new McpToolError("NOT_FOUND", "Source file was not found");
  }
  const content = await fs.readFile(candidate, "utf8");
  if (createHash("sha256").update(content).digest("hex") !== sourceFile.contentHash) {
    throw new McpToolError("NOT_FOUND", "Published source no longer matches its citation");
  }
  const lines = content.split(/\r?\n/);
  const first = startLine ?? 1;
  const last = endLine ?? Math.min(lines.length, first + 499);
  if (last < first || last > lines.length || last - first + 1 > 500) {
    throw new McpToolError("NOT_FOUND", "Source range was not found");
  }
  const citation: Citation = {
    path: filePath,
    startLine: first,
    endLine: last,
    commitSha: snapshot.commitSha,
    blobHash: sourceFile.contentHash
  };
  return {
    result: { ...citation, content: lines.slice(first - 1, last).join("\n") },
    citations: [citation]
  };
}

export function createRegisteredMcpServer(context?: McpToolContext): McpServer {
  const server = new McpServer({ name: SERVICE_NAME, version: APP_VERSION });
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  interface ToolDefinition {
    name: string;
    description: string;
    schema: z.ZodType;
    annotations: ToolAnnotations;
    callback: (input: unknown) => Promise<CallToolResult>;
  }
  const tools: ToolDefinition[] = [];
  function register<T extends z.ZodType>(
    name: string,
    description: string,
    schema: T,
    annotations: ToolAnnotations,
    callback: (input: z.infer<T>) => Promise<CallToolResult>
  ) {
    tools.push({
      name,
      description,
      schema,
      annotations,
      callback: (input) => callback(input as z.infer<T>)
    });
  }

  register(
    "dkh_search",
    "Search the current published knowledge release",
    z.strictObject({
      query: z.string().trim().min(1),
      limit: z.number().int().min(1).max(20).optional()
    }),
    readOnly,
    async ({ query, limit }) => {
    try {
      const selected = await published(context);
      const results = (await selected.context.store.searchKnowledge(
        selected.context.workspaceId, selected.repository.id, query, selected.release.id
      )).slice(0, limit ?? 10);
      if (!results.length) throw new McpToolError("NOT_FOUND", "No matching knowledge was found");
      return successful(
        selected.release,
        selected.snapshot.commitSha,
        results,
        results.flatMap((result) => result.citations)
      );
    } catch (error) {
      return failed(error);
    }
    }
  );

  register(
    "dkh_get_architecture",
    "Get the architecture overview from the current published release",
    z.strictObject({}),
    readOnly,
    async () => {
    try {
      const selected = await published(context);
      const page = (await pagesFor(selected.context, selected.release))
        .find((candidate) => candidate.slug === "architecture-overview");
      if (!page) throw new McpToolError("NOT_FOUND", "Architecture knowledge was not found");
      return successful(selected.release, selected.snapshot.commitSha, page, pageCitations(page));
    } catch (error) {
      return failed(error);
    }
    }
  );

  register(
    "dkh_get_module",
    "Get a module from the current published release",
    z.strictObject({ moduleId: z.string().trim().min(1) }),
    readOnly,
    async ({ moduleId }) => {
    try {
      const selected = await published(context);
      const page = (await pagesFor(selected.context, selected.release)).find((candidate) =>
        candidate.title === `Module: ${moduleId}` || candidate.slug === moduleId
      );
      if (!page) throw new McpToolError("NOT_FOUND", "Module knowledge was not found");
      return successful(selected.release, selected.snapshot.commitSha, page, pageCitations(page));
    } catch (error) {
      return failed(error);
    }
    }
  );

  register(
    "dkh_get_symbol",
    "Get a symbol from the current published release",
    z.strictObject({
      name: z.string().trim().min(1),
      path: z.string().trim().min(1).optional()
    }),
    readOnly,
    async ({ name, path: symbolPath }) => {
    try {
      const selected = await published(context);
      const page = (await pagesFor(selected.context, selected.release)).find((candidate) =>
        candidate.title === name
        && (!symbolPath || pageCitations(candidate).some((citation) => citation.path === symbolPath))
      );
      if (!page) throw new McpToolError("NOT_FOUND", "Symbol knowledge was not found");
      return successful(selected.release, selected.snapshot.commitSha, page, pageCitations(page));
    } catch (error) {
      return failed(error);
    }
    }
  );

  register(
    "dkh_get_change_context",
    "Get cited context for a proposed code change",
    z.strictObject({
      task: z.string().trim().min(1),
      paths: z.array(z.string().trim().min(1)).max(20).optional()
    }),
    readOnly,
    async ({ task, paths }) => {
    try {
      const selected = await published(context);
      const terms = taskTerms(task);
      const queries = [...new Set([task, ...terms, ...(paths ?? [])])];
      const groups = await Promise.all(queries.map((query) => selected.context.store.searchKnowledge(
        selected.context.workspaceId, selected.repository.id, query, selected.release.id
      )));
      const initial = mergeSearchResults(groups.flat());
      const discoveredPaths = new Set(initial.flatMap((result) =>
        result.citations.map((citation) => citation.path.toLowerCase())));
      const metadata = await selected.context.store.knowledgeMetadata(
        selected.context.workspaceId, selected.release.id
      );
      const relatedQueries = metadata.dependencies.flatMap((dependency) => {
        const values = [dependency.source, dependency.target, dependency.path];
        const related = values.some((value) => {
          const normalized = value.toLowerCase();
          return discoveredPaths.has(normalized) || terms.some((term) => normalized.includes(term));
        });
        return related ? values : [];
      }).slice(0, 20);
      const relatedGroups = await Promise.all([...new Set(relatedQueries)].map((query) =>
        selected.context.store.searchKnowledge(
          selected.context.workspaceId, selected.repository.id, query, selected.release.id
        )));
      const discovered = mergeSearchResults([...initial, ...relatedGroups.flat()]);
      if (!discovered.length) throw new McpToolError("NOT_FOUND", "Change context was not found");
      const pages = await pagesFor(selected.context, selected.release);
      const support = pages.filter((page) =>
        page.slug === "conventions" || page.slug === "run-test-guide"
      ).map((page): KnowledgeSearchResult => ({
        kind: "page",
        title: page.title,
        excerpt: page.body.slice(0, 240),
        score: 10,
        pageId: page.id,
        releaseId: selected.release.id,
        citations: pageCitations(page)
      }));
      const supportIds = new Set(support.map((result) => result.pageId));
      const results = [
        ...discovered.filter((result) => !supportIds.has(result.pageId)).slice(0, 18),
        ...support
      ].slice(0, 20);
      return successful(
        selected.release,
        selected.snapshot.commitSha,
        { task, paths: paths ?? [], matches: results },
        results.flatMap((result) => result.citations)
      );
    } catch (error) {
      return failed(error);
    }
    }
  );

  register(
    "dkh_get_source",
    "Read a bounded source excerpt from the current published snapshot",
    z.strictObject({
      path: z.string().trim().min(1),
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional()
    }).refine((value) => {
      if (value.endLine === undefined) return true;
      const first = value.startLine ?? 1;
      return value.endLine >= first && value.endLine - first + 1 <= 500;
    }),
    readOnly,
    async ({ path: filePath, startLine, endLine }) => {
    try {
      const selected = await published(context);
      const source = await readSource(selected.context, selected.release, filePath, startLine, endLine);
      return successful(
        selected.release,
        selected.snapshot.commitSha,
        source.result,
        source.citations
      );
    } catch (error) {
      return failed(error);
    }
    }
  );

  register(
    "dkh_get_release",
    "Get metadata for the current published release",
    z.strictObject({}),
    readOnly,
    async () => {
    try {
      const selected = await published(context);
      const pages = await pagesFor(selected.context, selected.release);
      return successful(
        selected.release,
        selected.snapshot.commitSha,
        selected.release,
        pages.flatMap(pageCitations)
      );
    } catch (error) {
      return failed(error);
    }
    }
  );

  register(
    "dkh_report_gap",
    "Report missing or inadequate published knowledge",
    z.strictObject({
      query: z.string().trim().min(1),
      reason: z.string().trim().min(1),
      expected: z.string().trim().min(1).optional()
    }),
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ query, reason, expected }) => {
    try {
      const selected = await published(context);
      const matches = await selected.context.store.searchKnowledge(
        selected.context.workspaceId,
        selected.repository.id,
        query,
        selected.release.id
      );
      const citations = uniqueCitations(matches.flatMap((match) => match.citations)).slice(0, 8);
      const feedback = await selected.context.store.reportFeedbackWithAudit({
        workspaceId: selected.context.workspaceId,
        releaseId: selected.release.id,
        query,
        reason,
        citations,
        ...(expected ? { expected } : {})
      });
      return successful(
        selected.release,
        selected.snapshot.commitSha,
        { feedback },
        citations,
        false
      );
    } catch (error) {
      return failed(error);
    }
    }
  );

  server.server.registerCapabilities({ tools: {} });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.schema) as { type: "object" },
      annotations: tool.annotations
    }))
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((candidate) => candidate.name === request.params.name);
    if (!tool) throw new McpError(ErrorCode.MethodNotFound, "Unknown MCP tool");
    const parsed = tool.schema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => ({
        path: issue.path.length ? issue.path.map(String).join(".") : "$",
        code: issue.code
      })).sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code));
      return failed(new McpToolError("INVALID_INPUT", "Tool input is invalid", details));
    }
    return tool.callback(parsed.data);
  });

  return server;
}
