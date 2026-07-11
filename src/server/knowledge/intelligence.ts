import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { parse as parseYaml } from "yaml";

export type SymbolKind =
  | "module"
  | "class"
  | "function"
  | "interface"
  | "type"
  | "variable"
  | "export"
  | "package-script";

export type EdgeKind =
  | "imports"
  | "exports"
  | "calls"
  | "test-of"
  | "package-dependency"
  | "module-dependency";

export interface Citation {
  path: string;
  startLine: number;
  endLine: number;
  commitSha: string;
  blobHash: string;
}

export interface CodeSymbol extends Citation {
  name: string;
  kind: SymbolKind;
  signature?: string;
  exported: boolean;
}

export interface CodeEdge {
  kind: EdgeKind;
  source: string;
  target: string;
  targetPath?: string;
  citation: Citation;
}

export interface DocumentInfo extends Citation {
  headings: Array<{ text: string; level: number; line: number }>;
}

export interface ConfigInfo extends Citation {
  kind: "json" | "yaml" | "package" | "tsconfig" | "vitest" | "jest" | "playwright";
  keys: string[];
}

export interface CodeIndex {
  rootPath: string;
  commitSha: string;
  files: Citation[];
  symbols: CodeSymbol[];
  edges: CodeEdge[];
  documents: DocumentInfo[];
  configs: ConfigInfo[];
}

const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

function hash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function lineRange(source: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } {
  return {
    startLine: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    endLine: source.getLineAndCharacterOfPosition(Math.max(node.getStart(source), node.getEnd() - 1)).line + 1
  };
}

function citationFor(
  relativePath: string,
  content: string,
  commitSha: string,
  blobHash: string,
  startLine = 1,
  endLine = Math.max(1, content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0))
): Citation {
  return { path: relativePath, startLine, endLine, commitSha, blobHash };
}

async function walk(root: string, current = root): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return files;
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function scriptKind(filePath: string): ts.ScriptKind {
  const extension = path.extname(filePath);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].includes(extension)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function resolveModulePath(importer: string, specifier: string, knownPaths: Set<string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const candidates = [
    base,
    ...[...codeExtensions].map((extension) => `${base}${extension}`),
    ...[...codeExtensions].map((extension) => `${base}/index${extension}`)
  ];
  return candidates.find((candidate) => knownPaths.has(candidate)) ?? null;
}

function declarationName(node: ts.Node): string | null {
  if ((ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)
    || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) {
    return node.name.text;
  }
  return null;
}

function enclosingCallSource(node: ts.CallExpression): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isMethodDeclaration(current)) {
      const owner = current.parent;
      const className = ts.isClassDeclaration(owner) ? owner.name?.text : undefined;
      return className ? `${className}.${current.name.getText()}` : current.name.getText();
    }
    const name = declarationName(current);
    if (name) return name;
    current = current.parent;
  }
  return node.getSourceFile().fileName;
}

function resolvedCallTarget(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  rootPath: string,
  indexedSourcePaths: ReadonlySet<string>
): { name: string; path: string } | null {
  const declaration = checker.getResolvedSignature(node)?.declaration;
  if (!declaration) return null;
  const absolutePath = path.resolve(declaration.getSourceFile().fileName);
  const canonicalPath = ts.sys.useCaseSensitiveFileNames ? absolutePath : absolutePath.toLowerCase();
  if (!indexedSourcePaths.has(canonicalPath)) return null;
  const relativePath = path.relative(rootPath, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;

  let nameNode: ts.DeclarationName | undefined;
  if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) {
    nameNode = declaration.name;
  } else if (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) {
    if (declaration.name) nameNode = declaration.name;
    else if (ts.isVariableDeclaration(declaration.parent)) nameNode = declaration.parent.name;
    else if (ts.isPropertyAssignment(declaration.parent)) nameNode = declaration.parent.name;
  } else {
    return null;
  }
  if (!nameNode || !ts.isIdentifier(nameNode) && !ts.isStringLiteral(nameNode)) return null;
  return {
    name: nameNode.text,
    path: relativePath.split(path.sep).join("/")
  };
}

function codeSymbolsAndEdges(
  relativePath: string,
  content: string,
  commitSha: string,
  blobHash: string,
  knownPaths: Set<string>,
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  rootPath: string,
  indexedSourcePaths: ReadonlySet<string>
): { symbols: CodeSymbol[]; edges: CodeEdge[]; configKeys: string[] } {
  const baseCitation = citationFor(relativePath, content, commitSha, blobHash);
  const symbols: CodeSymbol[] = [{
    ...baseCitation,
    name: relativePath,
    kind: "module",
    exported: false
  }];
  const edges: CodeEdge[] = [];
  const configKeys = new Set<string>();

  function addSymbol(node: ts.Node, name: string, kind: SymbolKind, exported = isExported(node)) {
    symbols.push({
      ...baseCitation,
      ...lineRange(source, node),
      name,
      kind,
      signature: node.getText(source).split("{")[0]?.trim(),
      exported
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node) && node.name) addSymbol(node, node.name.text, "class");
    else if (ts.isFunctionDeclaration(node) && node.name) addSymbol(node, node.name.text, "function");
    else if (ts.isInterfaceDeclaration(node)) addSymbol(node, node.name.text, "interface");
    else if (ts.isTypeAliasDeclaration(node)) addSymbol(node, node.name.text, "type");
    else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) addSymbol(node, declaration.name.text, "variable");
      }
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = resolveModulePath(relativePath, node.moduleSpecifier.text, knownPaths);
      if (target) {
        const citation = { ...baseCitation, ...lineRange(source, node) };
        edges.push({ kind: "imports", source: relativePath, target, targetPath: target, citation });
        edges.push({ kind: "module-dependency", source: relativePath, target, targetPath: target, citation });
        if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relativePath)) {
          edges.push({ kind: "test-of", source: relativePath, target, targetPath: target, citation });
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const exported of node.exportClause.elements) {
          addSymbol(node, exported.name.text, "export", true);
        }
      }
      const target = resolveModulePath(relativePath, node.moduleSpecifier.text, knownPaths);
      if (target) edges.push({
        kind: "exports",
        source: relativePath,
        target,
        targetPath: target,
        citation: { ...baseCitation, ...lineRange(source, node) }
      });
    } else if (ts.isExportAssignment(node)) {
      addSymbol(node, "default", "export", true);
    } else if (ts.isCallExpression(node)) {
      const target = resolvedCallTarget(node, checker, rootPath, indexedSourcePaths);
      if (target) edges.push({
        kind: "calls",
        source: enclosingCallSource(node),
        target: target.name,
        targetPath: target.path,
        citation: { ...baseCitation, ...lineRange(source, node) }
      });
    } else if (ts.isPropertyAssignment(node)) {
      configKeys.add(node.name.getText(source).replace(/^['"]|['"]$/g, ""));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { symbols, edges, configKeys: [...configKeys].sort() };
}

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    keys.push(fullKey, ...flattenKeys(child, fullKey));
  }
  return keys.sort();
}

function configKind(relativePath: string): ConfigInfo["kind"] | null {
  const name = path.posix.basename(relativePath).toLowerCase();
  if (name === "package.json") return "package";
  if (name === "tsconfig.json" || name.startsWith("tsconfig.")) return "tsconfig";
  if (name.includes("vitest.config")) return "vitest";
  if (name.includes("jest.config")) return "jest";
  if (name.includes("playwright.config")) return "playwright";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return "yaml";
  return null;
}

function packageScriptSymbols(
  relativePath: string,
  content: string,
  commitSha: string,
  blobHash: string
): { symbols: CodeSymbol[]; edges: CodeEdge[] } {
  const source = ts.parseJsonText(relativePath, content);
  const base = citationFor(relativePath, content, commitSha, blobHash);
  const symbols: CodeSymbol[] = [];
  const edges: CodeEdge[] = [];
  let packageName = "package";
  const root = source.statements[0]?.expression;
  if (!root || !ts.isObjectLiteralExpression(root)) return { symbols, edges };
  for (const property of root.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = property.name.getText(source).replace(/^['"]|['"]$/g, "");
    if (key === "name" && ts.isStringLiteral(property.initializer)) packageName = property.initializer.text;
    if (key === "scripts" && ts.isObjectLiteralExpression(property.initializer)) {
      for (const script of property.initializer.properties) {
        if (!ts.isPropertyAssignment(script)) continue;
        symbols.push({
          ...base,
          ...lineRange(source, script),
          name: script.name.getText(source).replace(/^['"]|['"]$/g, ""),
          kind: "package-script",
          exported: false
        });
      }
    }
    if (["dependencies", "devDependencies", "peerDependencies"].includes(key)
      && ts.isObjectLiteralExpression(property.initializer)) {
      for (const dependency of property.initializer.properties) {
        const target = dependency.name?.getText(source).replace(/^['"]|['"]$/g, "");
        if (target) edges.push({
          kind: "package-dependency",
          source: packageName,
          target,
          citation: { ...base, ...lineRange(source, dependency) }
        });
      }
    }
  }
  return { symbols, edges };
}

function defaultCompilerOptions(): ts.CompilerOptions {
  return {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022
  };
}

function repositoryCompilerOptions(rootPath: string): ts.CompilerOptions {
  const defaults = defaultCompilerOptions();
  const configPath = path.join(rootPath, "tsconfig.json");
  if (!ts.sys.fileExists(configPath)) return defaults;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return defaults;
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, rootPath, undefined, configPath);
  if (parsed.errors.length) return defaults;
  return {
    ...defaults,
    ...parsed.options,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true
  };
}

function structuredConfig(content: string, kind: ConfigInfo["kind"]): unknown | null {
  try {
    return kind === "yaml" ? parseYaml(content) : JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

export async function analyzeSnapshot(
  rootPath: string,
  commitSha: string,
  persistedHashes: ReadonlyMap<string, string> = new Map()
): Promise<CodeIndex> {
  const discoveredPaths = (await walk(rootPath)).filter((relativePath) =>
    persistedHashes.size === 0 || persistedHashes.has(relativePath)
  );
  const decoded = new Map<string, { content: string; blobHash: string }>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const relativePath of discoveredPaths) {
    const bytes = await fs.readFile(path.join(rootPath, relativePath));
    try {
      decoded.set(relativePath, {
        content: decoder.decode(bytes),
        blobHash: persistedHashes.get(relativePath) ?? hash(bytes)
      });
    } catch {
      // Invalid UTF-8 is not text knowledge and is excluded from the index.
    }
  }
  const relativePaths = [...decoded.keys()];
  const knownPaths = new Set(relativePaths);
  const rootNames = relativePaths
    .filter((relativePath) => codeExtensions.has(path.extname(relativePath)))
    .map((relativePath) => path.resolve(rootPath, relativePath));
  const indexedSourcePaths = new Set(rootNames.map((absolutePath) =>
    ts.sys.useCaseSensitiveFileNames ? absolutePath : absolutePath.toLowerCase()
  ));
  const program = ts.createProgram({
    rootNames,
    options: repositoryCompilerOptions(rootPath)
  });
  const checker = program.getTypeChecker();
  const files: Citation[] = [];
  const symbols: CodeSymbol[] = [];
  const edges: CodeEdge[] = [];
  const documents: DocumentInfo[] = [];
  const configs: ConfigInfo[] = [];

  for (const relativePath of relativePaths) {
    const { content, blobHash } = decoded.get(relativePath)!;
    const citation = citationFor(relativePath, content, commitSha, blobHash);
    files.push(citation);
    if (codeExtensions.has(path.extname(relativePath))) {
      const source = program.getSourceFile(path.join(rootPath, relativePath))
        ?? ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true, scriptKind(relativePath));
      const extracted = codeSymbolsAndEdges(
        relativePath,
        content,
        commitSha,
        blobHash,
        knownPaths,
        source,
        checker,
        rootPath,
        indexedSourcePaths
      );
      symbols.push(...extracted.symbols);
      edges.push(...extracted.edges);
      const kind = configKind(relativePath);
      if (kind) configs.push({ ...citation, kind, keys: extracted.configKeys });
    }
    if (relativePath.toLowerCase().endsWith(".md")) {
      const headings = content.split(/\r?\n/).flatMap((line, index) => {
        const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
        return match ? [{ text: match[2], level: match[1].length, line: index + 1 }] : [];
      });
      documents.push({ ...citation, headings });
    }
    const kind = configKind(relativePath);
    if (kind && !codeExtensions.has(path.extname(relativePath))) {
      const parsed = structuredConfig(content, kind);
      configs.push({ ...citation, kind, keys: parsed === null ? [] : flattenKeys(parsed) });
      if (kind === "package" && parsed !== null) {
        const packageData = packageScriptSymbols(relativePath, content, commitSha, blobHash);
        symbols.push(...packageData.symbols);
        edges.push(...packageData.edges);
      }
    }
  }

  edges.sort((left, right) =>
    `${left.kind}:${left.source}:${left.target}`.localeCompare(`${right.kind}:${right.source}:${right.target}`)
  );
  symbols.sort((left, right) =>
    `${left.path}:${left.startLine}:${left.kind}:${left.name}`.localeCompare(
      `${right.path}:${right.startLine}:${right.kind}:${right.name}`
    )
  );
  return { rootPath, commitSha, files, symbols, edges, documents, configs };
}
