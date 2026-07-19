import { createHash } from "node:crypto";
import path from "node:path";

import ts from "typescript";

import {
  analyzeFrontendProjectManifest,
  type FrontendPackageManifest,
  type ProjectManifestSource
} from "./project-manifest.js";

const VIRTUAL_ROOT = "/project";
const MAX_PROGRAM_SOURCES = 10_000;
const MAX_PROGRAM_SOURCE_BYTES = 2 * 1024 * 1024;
const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".d.ts"]);

export interface TypeScriptModuleResolution {
  containingFile: string;
  specifier: string;
  resolvedPath: string | null;
}

export interface RestrictedTypeScriptProgram {
  program: ts.Program;
  checker: ts.TypeChecker;
  rootNames: string[];
  projectReferences: Array<{ from: string; to: string }>;
  resolutions: TypeScriptModuleResolution[];
}

export interface TypeScriptSyntaxFacts {
  schemaVersion: 1;
  declarations: Array<{ kind: string; name: string; start: number; end: number }>;
  imports: Array<{ specifier: string; start: number; end: number; dynamic: boolean }>;
}

export function typeScriptSyntaxParserConfigDigest(sourcePath: string): string {
  const extension = sourcePath.endsWith(".d.ts") ? ".d.ts" : path.posix.extname(sourcePath).toLowerCase();
  return createHash("sha256").update(`typescript-syntax\0${ts.version}\0${extension}\0v1`, "utf8").digest("hex");
}

export function extractTypeScriptSyntaxFacts(content: string, sourcePath = "source.ts"): TypeScriptSyntaxFacts {
  const extension = sourcePath.endsWith(".d.ts") ? ".d.ts" : path.posix.extname(sourcePath).toLowerCase();
  const scriptKind = extension === ".tsx" ? ts.ScriptKind.TSX
    : extension === ".jsx" || extension === ".js" || extension === ".mjs" || extension === ".cjs" ? ts.ScriptKind.JSX
      : ts.ScriptKind.TS;
  const file = ts.createSourceFile(sourcePath, content, ts.ScriptTarget.ES2022, true, scriptKind);
  const declarations: TypeScriptSyntaxFacts["declarations"] = [];
  const imports: TypeScriptSyntaxFacts["imports"] = [];
  const visit = (node: ts.Node): void => {
    const named = (kind: string, name: ts.Node | undefined) => {
      if (name && ts.isIdentifier(name)) {
        declarations.push({ kind, name: name.text, start: node.getStart(file), end: node.end });
      }
    };
    if (ts.isFunctionDeclaration(node)) named("function", node.name);
    else if (ts.isClassDeclaration(node)) named("class", node.name);
    else if (ts.isInterfaceDeclaration(node)) named("interface", node.name);
    else if (ts.isTypeAliasDeclaration(node)) named("type", node.name);
    else if (ts.isEnumDeclaration(node)) named("enum", node.name);
    else if (ts.isVariableDeclaration(node)) named("variable", node.name);
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      imports.push({
        specifier: node.moduleSpecifier.text,
        start: node.moduleSpecifier.getStart(file),
        end: node.moduleSpecifier.end,
        dynamic: false
      });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!)) {
      imports.push({
        specifier: node.arguments[0].text,
        start: node.arguments[0].getStart(file),
        end: node.arguments[0].end,
        dynamic: true
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return {
    schemaVersion: 1,
    declarations: declarations.sort((left, right) => left.start - right.start || left.name.localeCompare(right.name)),
    imports: imports.sort((left, right) => left.start - right.start || left.specifier.localeCompare(right.specifier))
  };
}

function isCodePath(sourcePath: string): boolean {
  if (sourcePath.split("/").includes("node_modules")) return false;
  return sourcePath.endsWith(".d.ts") || codeExtensions.has(path.posix.extname(sourcePath).toLowerCase());
}

function virtualPath(sourcePath: string): string {
  return `${VIRTUAL_ROOT}/${sourcePath}`;
}

function projectPath(fileName: string): string | null {
  const normalized = path.posix.normalize(fileName);
  return normalized.startsWith(`${VIRTUAL_ROOT}/`) ? normalized.slice(VIRTUAL_ROOT.length + 1) : null;
}

function tsExtension(sourcePath: string): ts.Extension {
  if (sourcePath.endsWith(".d.ts")) return ts.Extension.Dts;
  const extension = path.posix.extname(sourcePath).toLowerCase();
  if (extension === ".tsx") return ts.Extension.Tsx;
  if (extension === ".jsx") return ts.Extension.Jsx;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.Extension.Js;
  if (extension === ".mts") return ts.Extension.Mts;
  if (extension === ".cts") return ts.Extension.Cts;
  return ts.Extension.Ts;
}

function candidatePaths(target: string): string[] {
  const normalized = path.posix.normalize(target).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) return [];
  if (isCodePath(normalized)) return [normalized];
  return [
    normalized,
    `${normalized}.ts`,
    `${normalized}.tsx`,
    `${normalized}.mts`,
    `${normalized}.cts`,
    `${normalized}.js`,
    `${normalized}.jsx`,
    `${normalized}/index.ts`,
    `${normalized}/index.tsx`,
    `${normalized}/index.js`,
    `${normalized}/index.jsx`
  ];
}

function firstSourceCandidate(target: string, sources: ReadonlyMap<string, string>): string | null {
  return candidatePaths(target).find((candidate) => sources.has(candidate)) ?? null;
}

function matchAlias(specifier: string, alias: string): string | null {
  const star = alias.indexOf("*");
  if (star < 0) return specifier === alias ? "" : null;
  const prefix = alias.slice(0, star);
  const suffix = alias.slice(star + 1);
  return specifier.startsWith(prefix) && specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length)
    : null;
}

function exportedTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = value as Record<string, unknown>;
  for (const condition of ["types", "import", "default", "node", "browser"]) {
    const target = exportedTarget(entries[condition]);
    if (target) return target;
  }
  return null;
}

function resolvePackageExport(specifier: string, packages: readonly FrontendPackageManifest[]): string | null {
  for (const manifest of packages) {
    if (!manifest.name || (specifier !== manifest.name && !specifier.startsWith(`${manifest.name}/`))) continue;
    const subpath = specifier === manifest.name ? "." : `.${specifier.slice(manifest.name.length)}`;
    let target: string | null = null;
    if (typeof manifest.exports === "string") {
      if (subpath === ".") target = manifest.exports;
    } else if (manifest.exports && typeof manifest.exports === "object" && !Array.isArray(manifest.exports)) {
      const exportsMap = manifest.exports as Record<string, unknown>;
      target = exportedTarget(exportsMap[subpath]);
      if (!target && subpath === ".") target = exportedTarget(manifest.exports);
    }
    if (!target) return null;
    return path.posix.join(manifest.root, target);
  }
  return null;
}

function resolvePackageImport(
  specifier: string,
  containingPath: string,
  packages: readonly FrontendPackageManifest[]
): string | null {
  if (!specifier.startsWith("#")) return null;
  const owner = packages.filter((manifest) => manifest.root === "" || containingPath.startsWith(`${manifest.root}/`))
    .sort((left, right) => right.root.length - left.root.length)[0];
  if (!owner?.imports || typeof owner.imports !== "object" || Array.isArray(owner.imports)) return null;
  const imports = owner.imports as Record<string, unknown>;
  for (const [alias, value] of Object.entries(imports)) {
    const matched = matchAlias(specifier, alias);
    if (matched === null) continue;
    const target = exportedTarget(value);
    if (!target) return null;
    return path.posix.join(owner.root, target.replace("*", matched));
  }
  return null;
}

export function createRestrictedTypeScriptProgram(input: readonly ProjectManifestSource[]): RestrictedTypeScriptProgram {
  const manifest = analyzeFrontendProjectManifest(input);
  const sources = new Map<string, string>();
  for (const source of input) {
    if (!isCodePath(source.path)) continue;
    if (Buffer.byteLength(source.content, "utf8") > MAX_PROGRAM_SOURCE_BYTES) {
      throw new Error(`TypeScript source size limit exceeded: ${source.path}`);
    }
    sources.set(source.path, source.content);
  }
  if (sources.size > MAX_PROGRAM_SOURCES) throw new Error("TypeScript source count limit exceeded");
  const rootNames = [...sources.keys()].sort((left, right) => left.localeCompare(right));
  const resolutions: TypeScriptModuleResolution[] = [];
  const aliases = Object.entries(manifest.tsconfigs.reduce<Record<string, string[]>>(
    (combined, config) => ({ ...combined, ...config.paths }),
    {}
  ))
    .sort(([left], [right]) => right.length - left.length);

  const resolve = (specifier: string, containingPath: string): string | null => {
    if (specifier.startsWith(".")) {
      return firstSourceCandidate(path.posix.join(path.posix.dirname(containingPath), specifier), sources);
    }
    if (specifier.startsWith("/")) return null;
    for (const [alias, targets] of aliases) {
      const matched = matchAlias(specifier, alias);
      if (matched === null) continue;
      for (const target of targets) {
        const candidate = firstSourceCandidate(target.replace("*", matched), sources);
        if (candidate) return candidate;
      }
    }
    const packageImport = resolvePackageImport(specifier, containingPath, manifest.packages);
    if (packageImport) return firstSourceCandidate(packageImport, sources);
    const packageExport = resolvePackageExport(specifier, manifest.packages);
    return packageExport ? firstSourceCandidate(packageExport, sources) : null;
  };

  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    noLib: true,
    skipLibCheck: true,
    strict: false,
    target: ts.ScriptTarget.ES2022
  };
  const host: ts.CompilerHost = {
    fileExists: (fileName) => {
      const relative = projectPath(fileName);
      return relative !== null && sources.has(relative);
    },
    readFile: (fileName) => {
      const relative = projectPath(fileName);
      return relative === null ? undefined : sources.get(relative);
    },
    getSourceFile: (fileName, languageVersion) => {
      const relative = projectPath(fileName);
      const content = relative === null ? undefined : sources.get(relative);
      return content === undefined ? undefined : ts.createSourceFile(fileName, content, languageVersion, true);
    },
    getDefaultLibFileName: () => `${VIRTUAL_ROOT}/lib.d.ts`,
    writeFile: () => undefined,
    getCurrentDirectory: () => VIRTUAL_ROOT,
    getDirectories: () => [],
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    realpath: (fileName) => fileName,
    resolveModuleNames: (moduleNames, containingFile) => {
      const containingPath = projectPath(containingFile);
      if (!containingPath) return moduleNames.map(() => undefined);
      return moduleNames.map((specifier) => {
        const resolvedPath = resolve(specifier, containingPath);
        resolutions.push({ containingFile: containingPath, specifier, resolvedPath });
        return resolvedPath ? {
          resolvedFileName: virtualPath(resolvedPath),
          extension: tsExtension(resolvedPath),
          isExternalLibraryImport: false
        } : undefined;
      });
    }
  };
  const program = ts.createProgram(rootNames.map(virtualPath), options, host);
  resolutions.sort((left, right) => left.containingFile.localeCompare(right.containingFile)
    || left.specifier.localeCompare(right.specifier));
  const projectReferences = manifest.tsconfigs.flatMap((config) =>
    config.references.map((reference) => ({ from: config.path, to: reference }))
  );
  return {
    program,
    checker: program.getTypeChecker(),
    rootNames,
    projectReferences,
    resolutions
  };
}
