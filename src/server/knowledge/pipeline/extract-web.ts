import { createHash } from "node:crypto";
import path from "node:path";

import ts from "typescript";

import type { KnowledgeIR, LintIssue } from "./contracts.js";
import type { SourceRef } from "../../../shared/api-contracts.js";

export interface WebSourceInput {
  snapshotId: string;
  path: string;
  content: string;
  blobHash: string;
}

export interface WebExtractionResult {
  ir: KnowledgeIR;
  lintIssues: LintIssue[];
}

function scriptKind(filePath: string): ts.ScriptKind {
  switch (path.posix.extname(filePath).toLowerCase()) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs": return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function language(filePath: string): string {
  return path.posix.extname(filePath).slice(1).toLowerCase() || "text";
}

function ref(input: WebSourceInput, source: ts.SourceFile, node: ts.Node): SourceRef {
  return refAt(input, source, node.getStart(source), node.getEnd());
}

function refAt(input: WebSourceInput, source: ts.SourceFile, startPosition: number, endPosition: number): SourceRef {
  const start = source.getLineAndCharacterOfPosition(startPosition).line + 1;
  const end = source.getLineAndCharacterOfPosition(Math.max(startPosition, endPosition - 1)).line + 1;
  return { snapshotId: input.snapshotId, path: input.path, startLine: start, endLine: end, blobHash: input.blobHash };
}

function exported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function symbolId(input: WebSourceInput, name: string, node: ts.Node): string {
  return createHash("sha256").update(`${input.path}:${name}:${node.pos}:${node.end}`).digest("hex");
}

export function extractWebSource(input: WebSourceInput): WebExtractionResult {
  const source = ts.createSourceFile(input.path, input.content, ts.ScriptTarget.Latest, true, scriptKind(input.path));
  const sourceRef: SourceRef = {
    snapshotId: input.snapshotId, path: input.path, startLine: 1,
    endLine: Math.max(1, input.content.split(/\r?\n/).length - (input.content.endsWith("\n") ? 1 : 0)),
    blobHash: input.blobHash
  };
  const ir: KnowledgeIR = {
    schemaVersion: 1,
    snapshotId: input.snapshotId,
    files: [{ path: input.path, language: language(input.path), contentDigest: input.blobHash, lineCount: sourceRef.endLine, sourceRef }],
    symbols: [], imports: [], documents: [], tables: [], sourceRefs: [sourceRef]
  };
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  const lintIssues: LintIssue[] = diagnostics.map((diagnostic) => ({
    id: createHash("sha256").update(`${input.path}:${diagnostic.start ?? 0}:${diagnostic.code}`).digest("hex"),
    buildId: "pending", rule: "WEB_PARSE_DIAGNOSTIC", severity: "warning", targetKind: "knowledge",
    targetId: input.path, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    sourceRefs: [diagnostic.start === undefined
      ? sourceRef
      : refAt(input, source, diagnostic.start, diagnostic.start + (diagnostic.length ?? 1))],
    remediationState: "open"
  }));

  const addSymbol = (node: ts.Node, name: string, kind: "function" | "class" | "interface" | "type" | "component") => {
    const nodeRef = ref(input, source, node);
    ir.symbols.push({ id: symbolId(input, name, node), kind, name, qualifiedName: name, signature: node.getText(source).split("{")[0]?.trim() ?? null, sourceRef: nodeRef });
    ir.sourceRefs.push(nodeRef);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) addSymbol(node, node.name.text, "function");
    else if (ts.isClassDeclaration(node) && node.name) addSymbol(node, node.name.text, "class");
    else if (ts.isInterfaceDeclaration(node)) addSymbol(node, node.name.text, "interface");
    else if (ts.isTypeAliasDeclaration(node)) addSymbol(node, node.name.text, "type");
    else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
        const kind = exported(node) && /[A-Z]/.test(name.charAt(0)) ? "component" : "function";
        addSymbol(node, name, kind);
      }
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      ir.imports.push({ fromPath: input.path, specifier: node.moduleSpecifier.text, kind: "static", sourceRef: ref(input, source, node) });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      ir.imports.push({ fromPath: input.path, specifier: node.arguments[0].text, kind: "dynamic", sourceRef: ref(input, source, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { ir, lintIssues };
}
