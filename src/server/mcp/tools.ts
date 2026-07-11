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
import {
  MAX_KNOWLEDGE_CHUNK_CITATIONS,
  MAX_KNOWLEDGE_CHUNK_CONTENT_CHARACTERS,
  MAX_KNOWLEDGE_PAGE_BODY_CHARACTERS,
  MAX_KNOWLEDGE_PAGE_CHUNKS
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
  authorize?: () => Promise<boolean>;
  onUnauthorized?: () => Promise<void> | void;
}

class McpToolError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "UNAUTHORIZED" | "UNPUBLISHED" | "NOT_FOUND" | "CITATIONS_MISSING",
    message: string,
    readonly details?: Array<{ path: string; code: string }>
  ) {
    super(message);
  }
}

const MAX_QUERY_LENGTH = 500;
const MAX_TASK_LENGTH = 2_000;
const MAX_PATH_LENGTH = 500;
const MAX_RESPONSE_CITATIONS = 50;
const MAX_RESULTS = 20;
const MAX_CHANGE_PATHS = 3;
const MAX_CHANGE_TERMS = 6;
const MAX_CHANGE_SEARCHES = 8;

function uniqueCitations(citations: Citation[]): Citation[] {
  return [...new Map(citations.map((citation) => [
    `${citation.path}:${citation.startLine}:${citation.endLine}:${citation.commitSha}:${citation.blobHash}`,
    citation
  ])).values()];
}

function pageCitations(page: KnowledgePageRecord): Citation[] {
  return uniqueCitations(page.chunks.flatMap((chunk) => chunk.citations));
}

function boundedPage(page: KnowledgePageRecord): KnowledgePageRecord {
  return {
    ...page,
    body: page.body.slice(0, MAX_KNOWLEDGE_PAGE_BODY_CHARACTERS),
    chunks: page.chunks.slice(0, MAX_KNOWLEDGE_PAGE_CHUNKS).map((chunk) => ({
      ...chunk,
      content: chunk.content.slice(0, MAX_KNOWLEDGE_CHUNK_CONTENT_CHARACTERS),
      citations: uniqueCitations(chunk.citations).slice(0, MAX_KNOWLEDGE_CHUNK_CITATIONS)
    }))
  };
}

function boundedResults(results: KnowledgeSearchResult[]): KnowledgeSearchResult[] {
  return results.slice(0, MAX_RESULTS).map((result) => ({
    ...result,
    citations: uniqueCitations(result.citations).slice(0, MAX_KNOWLEDGE_CHUNK_CITATIONS)
  }));
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
  const envelope = {
    releaseId: release.id,
    commitSha,
    result,
    citations: uniqueCitations(citations).slice(0, MAX_RESPONSE_CITATIONS)
  };
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

const taskStopWords = new Set([
  "a", "an", "and", "change", "for", "in", "of", "on", "the", "to", "update", "with"
]);

function taskTerms(task: string): string[] {
  return [...new Set(task.toLowerCase().match(/[a-z0-9_.-]+/g) ?? [])]
    .filter((term) => term.length >= 3 && !taskStopWords.has(term))
    .map((term) => term.slice(0, MAX_QUERY_LENGTH))
    .slice(0, MAX_CHANGE_TERMS);
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
  const bytes = await fs.readFile(candidate);
  if (createHash("sha256").update(bytes).digest("hex") !== sourceFile.contentHash) {
    throw new McpToolError("NOT_FOUND", "Published source no longer matches its citation");
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new McpToolError("NOT_FOUND", "Published source is not valid UTF-8 text");
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

async function validCurrentCitations(
  context: McpToolContext,
  release: ReleaseRecord,
  commitSha: string,
  candidates: Citation[]
): Promise<Citation[]> {
  const valid: Citation[] = [];
  for (const citation of uniqueCitations(candidates)) {
    if (valid.length >= MAX_KNOWLEDGE_CHUNK_CITATIONS || citation.commitSha !== commitSha
      || citation.startLine < 1 || citation.endLine < citation.startLine) continue;
    const source = await context.store.findSourceFile(
      context.workspaceId,
      release.snapshotId,
      citation.path
    );
    if (source?.contentHash === citation.blobHash) valid.push(citation);
  }
  return valid;
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
      query: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
      limit: z.number().int().min(1).max(20).optional()
    }),
    readOnly,
    async ({ query, limit }) => {
    try {
      const selected = await published(context);
      const results = boundedResults(await selected.context.store.searchKnowledge(
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
      const page = await selected.context.store.findKnowledgePageBySlug(
        selected.context.workspaceId,
        selected.release.id,
        "architecture-overview"
      );
      if (!page) throw new McpToolError("NOT_FOUND", "Architecture knowledge was not found");
      const bounded = boundedPage(page);
      return successful(selected.release, selected.snapshot.commitSha, bounded, pageCitations(bounded));
    } catch (error) {
      return failed(error);
    }
    }
  );

  register(
    "dkh_get_module",
    "Get a module from the current published release",
    z.strictObject({ moduleId: z.string().trim().min(1).max(MAX_PATH_LENGTH) }),
    readOnly,
    async ({ moduleId }) => {
    try {
      const selected = await published(context);
      const page = await selected.context.store.findKnowledgePageByModule(
        selected.context.workspaceId,
        selected.release.id,
        moduleId
      );
      if (!page) throw new McpToolError("NOT_FOUND", "Module knowledge was not found");
      const bounded = boundedPage(page);
      return successful(selected.release, selected.snapshot.commitSha, bounded, pageCitations(bounded));
    } catch (error) {
      return failed(error);
    }
    }
  );

  register(
    "dkh_get_symbol",
    "Get a symbol from the current published release",
    z.strictObject({
      name: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
      path: z.string().trim().min(1).max(MAX_PATH_LENGTH).optional()
    }),
    readOnly,
    async ({ name, path: symbolPath }) => {
    try {
      const selected = await published(context);
      const page = await selected.context.store.findKnowledgePageBySymbol(
        selected.context.workspaceId,
        selected.release.id,
        name,
        symbolPath
      );
      if (!page) throw new McpToolError("NOT_FOUND", "Symbol knowledge was not found");
      const bounded = boundedPage(page);
      return successful(selected.release, selected.snapshot.commitSha, bounded, pageCitations(bounded));
    } catch (error) {
      return failed(error);
    }
    }
  );

  register(
    "dkh_get_change_context",
    "Get cited context for a proposed code change",
    z.strictObject({
      task: z.string().trim().min(1).max(MAX_TASK_LENGTH),
      paths: z.array(z.string().trim().min(1).max(MAX_PATH_LENGTH)).max(MAX_CHANGE_PATHS).optional()
    }),
    readOnly,
    async ({ task, paths }) => {
    try {
      const selected = await published(context);
      const terms = taskTerms(task);
      const termBatches = Array.from(
        { length: Math.ceil(terms.length / 3) },
        (_, index) => terms.slice(index * 3, index * 3 + 3).join(" ")
      );
      const queries = [...new Set([task, ...termBatches, ...(paths ?? [])])]
        .slice(0, MAX_CHANGE_SEARCHES - 2);
      const groups = await Promise.all(queries.map((query) => selected.context.store.searchKnowledge(
        selected.context.workspaceId, selected.repository.id, query, selected.release.id
      )));
      const initial = mergeSearchResults(groups.flat());
      const discoveredPaths = new Set(initial.flatMap((result) =>
        result.citations.map((citation) => citation.path.toLowerCase())));
      const metadata = await selected.context.store.knowledgeMetadata(
        selected.context.workspaceId, selected.release.id
      );
      const relatedQueries: string[] = [];
      const remainingSearches = MAX_CHANGE_SEARCHES - queries.length;
      for (const dependency of metadata.dependencies) {
        const values = [dependency.source, dependency.target, dependency.path];
        const related = values.some((value) => {
          const normalized = value.toLowerCase();
          return discoveredPaths.has(normalized) || terms.some((term) => normalized.includes(term));
        });
        if (related) {
          for (const value of values) {
            const bounded = value.slice(0, MAX_QUERY_LENGTH);
            if (!relatedQueries.includes(bounded)) relatedQueries.push(bounded);
            if (relatedQueries.length >= remainingSearches) break;
          }
        }
        if (relatedQueries.length >= remainingSearches) break;
      }
      const relatedGroups = await Promise.all(relatedQueries.map((query) =>
        selected.context.store.searchKnowledge(
          selected.context.workspaceId, selected.repository.id, query, selected.release.id
        )));
      const discovered = mergeSearchResults([...initial, ...relatedGroups.flat()]);
      if (!discovered.length) throw new McpToolError("NOT_FOUND", "Change context was not found");
      const supportPages = (await Promise.all(["conventions", "run-test-guide"].map((slug) =>
        selected.context.store.findKnowledgePageBySlug(
          selected.context.workspaceId,
          selected.release.id,
          slug
        )
      ))).filter((page): page is KnowledgePageRecord => Boolean(page));
      const support = supportPages.map((page): KnowledgeSearchResult => ({
        kind: "page",
        title: page.title,
        excerpt: page.body.slice(0, 240),
        score: 10,
        pageId: page.id,
        releaseId: selected.release.id,
        citations: pageCitations(page)
      }));
      const supportIds = new Set(support.map((result) => result.pageId));
      const results = boundedResults([
        ...discovered.filter((result) => !supportIds.has(result.pageId)).slice(0, 18),
        ...support
      ]);
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
      path: z.string().trim().min(1).max(MAX_PATH_LENGTH),
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
      const summary = await selected.context.store.knowledgeReleaseSummary(
        selected.context.workspaceId,
        selected.release.id
      );
      const architecture = await selected.context.store.findKnowledgePageBySlug(
        selected.context.workspaceId,
        selected.release.id,
        "architecture-overview"
      );
      const citations = architecture ? pageCitations(boundedPage(architecture)) : [];
      return successful(
        selected.release,
        selected.snapshot.commitSha,
        {
          id: selected.release.id,
          version: selected.release.version,
          snapshotId: selected.release.snapshotId,
          publishedAt: selected.release.publishedAt,
          ...summary
        },
        citations
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
      query: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
      reason: z.string().trim().min(1).max(MAX_TASK_LENGTH),
      expected: z.string().trim().min(1).max(MAX_TASK_LENGTH).optional()
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
      let citations = await validCurrentCitations(
        selected.context,
        selected.release,
        selected.snapshot.commitSha,
        matches.flatMap((match) => match.citations)
      );
      if (!citations.length) {
        const architecture = await selected.context.store.findKnowledgePageBySlug(
          selected.context.workspaceId,
          selected.release.id,
          "architecture-overview"
        );
        citations = await validCurrentCitations(
          selected.context,
          selected.release,
          selected.snapshot.commitSha,
          architecture ? pageCitations(architecture) : []
        );
      }
      if (!citations.length) {
        throw new McpToolError("CITATIONS_MISSING", "Published knowledge has no valid citation");
      }
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
        citations
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
    if (context?.authorize && !await context.authorize()) {
      void context.onUnauthorized?.();
      return failed(new McpToolError("UNAUTHORIZED", "MCP token is invalid or revoked"));
    }
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
