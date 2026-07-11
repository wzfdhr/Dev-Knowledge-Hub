import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { APP_VERSION, SERVICE_NAME } from "../../shared/contracts.js";
import type { Citation } from "../knowledge/intelligence.js";
import type {
  AppStore,
  KnowledgePageRecord,
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
  constructor(readonly code: "UNPUBLISHED" | "NOT_FOUND" | "CITATIONS_MISSING", message: string) {
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

function successful(release: ReleaseRecord, commitSha: string, result: unknown, citations: Citation[]) {
  if (!citations.length) {
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
    ? { error: { code: error.code, message: error.message } }
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
  if (last < first || last > lines.length || last - first > 500) {
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

  server.registerTool("dkh_search", {
    description: "Search the current published knowledge release",
    inputSchema: { query: z.string().trim().min(1), limit: z.number().int().min(1).max(20).optional() },
    annotations: readOnly
  }, async ({ query, limit }) => {
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
  });

  server.registerTool("dkh_get_architecture", {
    description: "Get the architecture overview from the current published release",
    inputSchema: {},
    annotations: readOnly
  }, async () => {
    try {
      const selected = await published(context);
      const page = (await pagesFor(selected.context, selected.release))
        .find((candidate) => candidate.slug === "architecture-overview");
      if (!page) throw new McpToolError("NOT_FOUND", "Architecture knowledge was not found");
      return successful(selected.release, selected.snapshot.commitSha, page, pageCitations(page));
    } catch (error) {
      return failed(error);
    }
  });

  server.registerTool("dkh_get_module", {
    description: "Get a module from the current published release",
    inputSchema: { moduleId: z.string().trim().min(1) },
    annotations: readOnly
  }, async ({ moduleId }) => {
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
  });

  server.registerTool("dkh_get_symbol", {
    description: "Get a symbol from the current published release",
    inputSchema: { name: z.string().trim().min(1), path: z.string().trim().min(1).optional() },
    annotations: readOnly
  }, async ({ name, path: symbolPath }) => {
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
  });

  server.registerTool("dkh_get_change_context", {
    description: "Get cited context for a proposed code change",
    inputSchema: {
      task: z.string().trim().min(1),
      paths: z.array(z.string().trim().min(1)).max(20).optional()
    },
    annotations: readOnly
  }, async ({ task, paths }) => {
    try {
      const selected = await published(context);
      const queries = [task, ...(paths ?? [])];
      const groups = await Promise.all(queries.map((query) => selected.context.store.searchKnowledge(
        selected.context.workspaceId, selected.repository.id, query, selected.release.id
      )));
      const results = [...new Map(groups.flat().map((result) => [result.pageId, result])).values()]
        .slice(0, 20);
      if (!results.length) throw new McpToolError("NOT_FOUND", "Change context was not found");
      return successful(
        selected.release,
        selected.snapshot.commitSha,
        { task, paths: paths ?? [], matches: results },
        results.flatMap((result) => result.citations)
      );
    } catch (error) {
      return failed(error);
    }
  });

  server.registerTool("dkh_get_source", {
    description: "Read a bounded source excerpt from the current published snapshot",
    inputSchema: {
      path: z.string().trim().min(1),
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional()
    },
    annotations: readOnly
  }, async ({ path: filePath, startLine, endLine }) => {
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
  });

  server.registerTool("dkh_get_release", {
    description: "Get metadata for the current published release",
    inputSchema: {},
    annotations: readOnly
  }, async () => {
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
  });

  server.registerTool("dkh_report_gap", {
    description: "Report missing or inadequate published knowledge",
    inputSchema: {
      query: z.string().trim().min(1),
      reason: z.string().trim().min(1),
      expected: z.string().trim().min(1).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ query, reason, expected }) => {
    try {
      const selected = await published(context);
      const feedback = await selected.context.store.createFeedback({
        workspaceId: selected.context.workspaceId,
        releaseId: selected.release.id,
        query,
        reason,
        ...(expected ? { expected } : {})
      });
      await selected.context.store.recordAudit({
        workspaceId: selected.context.workspaceId,
        action: "feedback.reported",
        resourceType: "agent_feedback",
        resourceId: feedback.id,
        metadata: { releaseId: selected.release.id }
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ feedback }) }],
        structuredContent: { feedback } as unknown as Record<string, unknown>
      };
    } catch (error) {
      return failed(error);
    }
  });

  return server;
}
