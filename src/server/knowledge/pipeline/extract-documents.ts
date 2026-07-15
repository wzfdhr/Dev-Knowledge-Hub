import { createHash } from "node:crypto";
import path from "node:path";

import { Parser, type Node } from "commonmark";
import { parseDocument } from "yaml";

import type { KnowledgeIR, LintIssue, SourceRef } from "../../../shared/api-contracts.js";

export interface DocumentSourceInput {
  snapshotId: string;
  path: string;
  content: string;
  blobHash: string;
}

export interface DocumentExtractionResult {
  ir: KnowledgeIR;
  lintIssues: LintIssue[];
}

function reference(input: DocumentSourceInput, startLine: number, endLine: number): SourceRef {
  return { snapshotId: input.snapshotId, path: input.path, startLine, endLine, blobHash: input.blobHash };
}

function documentId(input: DocumentSourceInput, suffix: string): string {
  return createHash("sha256").update(`${input.path}:${suffix}`).digest("hex");
}

function issue(input: DocumentSourceInput, rule: string, message: string, sourceRef: SourceRef): LintIssue {
  return {
    id: documentId(input, `${rule}:${sourceRef.startLine}`), buildId: "pending", rule, severity: "warning",
    targetKind: "knowledge", targetId: input.path, message, sourceRefs: [sourceRef], remediationState: "open"
  };
}

function nodeText(node: Node): string {
  if (node.type === "html_block" || node.type === "html_inline") {
    return (node.literal ?? "").replace(/<[^>]*>/g, "").trim();
  }
  let value = "";
  const walker = node.walker();
  let step = walker.next();
  while (step) {
    if (step.entering && ["text", "code", "html_inline", "html_block"].includes(step.node.type)) value += step.node.literal ?? "";
    if (step.entering && ["softbreak", "linebreak"].includes(step.node.type)) value += "\n";
    step = walker.next();
  }
  return value.trim();
}

function markdownDocuments(input: DocumentSourceInput): KnowledgeIR["documents"] {
  const root = new Parser().parse(input.content);
  const documents: KnowledgeIR["documents"] = [];
  let title: string | null = null;
  const walker = root.walker();
  let step = walker.next();
  while (step) {
    if (step.entering && (step.node.type === "heading" || step.node.type === "paragraph" || step.node.type === "html_block")) {
      const text = nodeText(step.node);
      if (step.node.type === "heading" && !title) title = text || null;
      if (text) {
        const [[startLine], [endLine]] = step.node.sourcepos;
        documents.push({
          id: documentId(input, `markdown:${startLine}:${endLine}`), title: step.node.type === "heading" ? text : title,
          text, sourceRef: reference(input, startLine, endLine)
        });
      }
    }
    step = walker.next();
  }
  return documents;
}

function scalarDocuments(input: DocumentSourceInput, value: unknown, prefix = "", depth = 0): KnowledgeIR["documents"] {
  if (depth > 32 || value === null || value === undefined) return [];
  if (typeof value !== "object") {
    return [{ id: documentId(input, `config:${prefix}`), title: null, text: `${prefix} = ${String(value)}`, sourceRef: reference(input, 1, Math.max(1, input.content.split(/\r?\n/).length)) }];
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => scalarDocuments(input, item, `${prefix}[${index}]`, depth + 1));
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, item]) => scalarDocuments(input, item, prefix ? `${prefix}.${key}` : key, depth + 1));
}

function exceedsDepth(value: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((child) => exceedsDepth(child, depth + 1));
}

export function extractDocumentSource(input: DocumentSourceInput): DocumentExtractionResult {
  const extension = path.posix.extname(input.path).toLowerCase();
  const fullRef = reference(input, 1, Math.max(1, input.content.split(/\r?\n/).length));
  const ir: KnowledgeIR = {
    schemaVersion: 1, snapshotId: input.snapshotId,
    files: [{ path: input.path, language: extension.slice(1) || "text", contentDigest: input.blobHash, lineCount: fullRef.endLine, sourceRef: fullRef }],
    symbols: [], imports: [], documents: [], tables: [], sourceRefs: [fullRef]
  };
  const lintIssues: LintIssue[] = [];
  if (extension === ".md") ir.documents.push(...markdownDocuments(input));
  else if (extension === ".json") {
    try { ir.documents.push(...scalarDocuments(input, JSON.parse(input.content))); }
    catch { lintIssues.push(issue(input, "JSON_PARSE_DIAGNOSTIC", "JSON source could not be parsed", fullRef)); }
  } else if (extension === ".yaml" || extension === ".yml") {
    if (/(?:^|[\s:[{,])(?:[!&*])/.test(input.content)) {
      lintIssues.push(issue(input, "YAML_ALIAS_OR_TAG_IGNORED", "YAML aliases and tags are not accepted", fullRef));
    } else {
      const parsed = parseDocument(input.content, { schema: "failsafe" });
      if (parsed.errors.length) lintIssues.push(issue(input, "YAML_PARSE_DIAGNOSTIC", parsed.errors[0].message, fullRef));
      else {
        const value = parsed.toJS();
        if (exceedsDepth(value)) lintIssues.push(issue(input, "YAML_DEPTH_LIMIT", "YAML nesting exceeds 32 levels", fullRef));
        else ir.documents.push(...scalarDocuments(input, value));
      }
    }
  }
  ir.sourceRefs.push(...ir.documents.map((document) => document.sourceRef));
  return { ir, lintIssues };
}
