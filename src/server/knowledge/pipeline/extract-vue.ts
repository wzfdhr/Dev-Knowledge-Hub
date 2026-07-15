import { createHash } from "node:crypto";
import path from "node:path";

import { parse } from "@vue/compiler-sfc";

import type { KnowledgeIR, LintIssue, SourceRef } from "../../../shared/api-contracts.js";
import { extractWebSource, type WebSourceInput } from "./extract-web.js";

export type VueSourceInput = WebSourceInput;

export interface VueExtractionResult {
  ir: KnowledgeIR;
  lintIssues: LintIssue[];
}

function reference(input: VueSourceInput, startLine: number, endLine: number): SourceRef {
  return { snapshotId: input.snapshotId, path: input.path, startLine, endLine, blobHash: input.blobHash };
}

function issue(input: VueSourceInput, rule: string, message: string, sourceRef: SourceRef): LintIssue {
  return {
    id: createHash("sha256").update(`${input.path}:${rule}:${sourceRef.startLine}`).digest("hex"),
    buildId: "pending", rule, severity: "warning", targetKind: "knowledge", targetId: input.path,
    message, sourceRefs: [sourceRef], remediationState: "open"
  };
}

export function extractVueSfc(input: VueSourceInput): VueExtractionResult {
  const parsed = parse(input.content, { filename: input.path });
  const fullRef = reference(input, 1, Math.max(1, input.content.split(/\r?\n/).length));
  const ir: KnowledgeIR = {
    schemaVersion: 1,
    snapshotId: input.snapshotId,
    files: [{ path: input.path, language: "vue", contentDigest: input.blobHash, lineCount: fullRef.endLine, sourceRef: fullRef }],
    symbols: [{
      id: createHash("sha256").update(`${input.path}:component`).digest("hex"),
      kind: "component", name: path.posix.basename(input.path, ".vue"),
      qualifiedName: path.posix.basename(input.path, ".vue"), signature: null, sourceRef: fullRef
    }],
    imports: [], documents: [], tables: [], sourceRefs: [fullRef]
  };
  const lintIssues: LintIssue[] = parsed.errors.map((error) =>
    issue(input, "VUE_PARSE_DIAGNOSTIC", typeof error === "string" ? error : error.message, fullRef)
  );
  const descriptor = parsed.descriptor;
  for (const block of [descriptor.script, descriptor.scriptSetup].filter((value): value is NonNullable<typeof value> => Boolean(value))) {
    const blockRef = reference(input, block.loc.start.line, block.loc.end.line);
    if (block.src) {
      lintIssues.push(issue(input, "VUE_REMOTE_SRC_IGNORED", "Vue script blocks with src are not fetched", blockRef));
      continue;
    }
    const extracted = extractWebSource({
      snapshotId: input.snapshotId, path: input.path, content: block.content, blobHash: input.blobHash,
      lineOffset: block.loc.start.line - 1
    });
    ir.symbols.push(...extracted.ir.symbols);
    ir.imports.push(...extracted.ir.imports);
    ir.sourceRefs.push(...extracted.ir.sourceRefs.slice(1));
    lintIssues.push(...extracted.lintIssues);
  }
  if (descriptor.template) {
    const template = descriptor.template;
    const templateRef = reference(input, template.loc.start.line, template.loc.end.line);
    if (template.src) {
      lintIssues.push(issue(input, "VUE_REMOTE_SRC_IGNORED", "Vue template blocks with src are not fetched", templateRef));
    } else {
      const tags = [...new Set([...template.content.matchAll(/<([A-Za-z][\w.-]*)\b/g)].map((match) => match[1]))];
      if (tags.length) {
        ir.documents.push({
          id: createHash("sha256").update(`${input.path}:template-tags`).digest("hex"),
          title: "Template static tags", text: tags.join(", "), sourceRef: templateRef
        });
        ir.sourceRefs.push(templateRef);
      }
    }
  }
  for (const block of descriptor.customBlocks) {
    lintIssues.push(issue(
      input,
      "VUE_CUSTOM_BLOCK_IGNORED",
      `Vue custom block <${block.type}> is retained as source only and is not transformed`,
      reference(input, block.loc.start.line, block.loc.end.line)
    ));
  }
  return { ir, lintIssues };
}
