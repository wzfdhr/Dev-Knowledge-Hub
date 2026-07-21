import path from "node:path";

import ts from "typescript";
import { parse as parseYaml } from "yaml";

export interface ProjectManifestSource {
  path: string;
  content: string;
}

export interface FrontendWorkspaceManifest {
  kind: "package-json" | "pnpm";
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | null;
  patterns: string[];
}

export interface FrontendPackageManifest {
  path: string;
  root: string;
  name: string | null;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  exports: unknown;
  imports: unknown;
}

export interface FrontendTsconfigManifest {
  path: string;
  extendsPath?: string;
  unresolvedExtends?: string;
  references: string[];
  paths: Record<string, string[]>;
}

export interface FrontendProjectManifest {
  workspace: FrontendWorkspaceManifest | null;
  packages: FrontendPackageManifest[];
  tsconfigs: FrontendTsconfigManifest[];
  ignoredPaths: string[];
}

type JsonObject = Record<string, unknown>;

const excludedSegments = new Set(["node_modules", ".git", ".hg", ".svn"]);

function normalizeSourcePath(sourcePath: string): string {
  if (!sourcePath || sourcePath.includes("\\") || sourcePath.startsWith("/")) {
    throw new Error(`invalid project source path: ${sourcePath}`);
  }
  const segments = sourcePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`invalid project source path: ${sourcePath}`);
  }
  return segments.join("/");
}

function isExcluded(sourcePath: string): boolean {
  return sourcePath.split("/").some((segment) => excludedSegments.has(segment));
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value as JsonObject;
}

function parsePackageJson(source: ProjectManifestSource): JsonObject {
  try {
    return jsonObject(JSON.parse(source.content), source.path);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("must contain a JSON object")) throw error;
    throw new Error(`${source.path} is not valid JSON`, { cause: error });
  }
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string"
  ).sort(([left], [right]) => left.localeCompare(right)));
}

function packageManager(value: unknown): FrontendWorkspaceManifest["packageManager"] {
  if (typeof value !== "string") return null;
  const name = value.split("@", 1)[0];
  return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun" ? name : null;
}

function packageWorkspacePatterns(value: unknown): string[] {
  let patterns: unknown[] = [];
  if (Array.isArray(value)) {
    patterns = value;
  } else if (value && typeof value === "object") {
    const packages = (value as JsonObject).packages;
    if (Array.isArray(packages)) patterns = packages;
  }
  return patterns.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function pnpmWorkspacePatterns(source: ProjectManifestSource): string[] {
  const parsed = parseYaml(source.content) as unknown;
  const object = jsonObject(parsed, source.path);
  if (!Array.isArray(object.packages)) return [];
  return object.packages.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function globPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withGlobstar = escaped.replaceAll("**", "\0");
  const withStar = withGlobstar.replaceAll("*", "[^/]*");
  return new RegExp(`^${withStar.replaceAll("\0", ".*")}$`);
}

function matchesWorkspaceRoot(root: string, patterns: readonly string[]): boolean {
  let included = false;
  for (const rawPattern of patterns) {
    const excluded = rawPattern.startsWith("!");
    const pattern = excluded ? rawPattern.slice(1) : rawPattern;
    if (pattern && globPattern(pattern.replace(/\/$/, "")).test(root)) included = !excluded;
  }
  return included;
}

function resolveProjectPath(fromFile: string, target: string): string | null {
  if (!target.startsWith(".")) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), target));
  if (resolved === ".." || resolved.startsWith("../") || resolved.startsWith("/")) return null;
  return resolved;
}

function resolveConfigFile(
  fromFile: string,
  target: string,
  sources: ReadonlyMap<string, ProjectManifestSource>
): string | null {
  const resolved = resolveProjectPath(fromFile, target);
  if (!resolved) return null;
  const candidates = resolved.endsWith(".json")
    ? [resolved]
    : [resolved, `${resolved}.json`, `${resolved}/tsconfig.json`];
  return candidates.find((candidate) => sources.has(candidate)) ?? null;
}

function parseTsconfig(source: ProjectManifestSource): JsonObject {
  const parsed = ts.parseConfigFileTextToJson(source.path, source.content);
  if (parsed.error) {
    throw new Error(`${source.path} is not a valid tsconfig: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n")}`);
  }
  return jsonObject(parsed.config, source.path);
}

function localPaths(configPath: string, compilerOptions: JsonObject): Record<string, string[]> {
  const baseUrl = typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : ".";
  const base = resolveProjectPath(configPath, baseUrl);
  const paths = compilerOptions.paths;
  if (!base || !paths || typeof paths !== "object" || Array.isArray(paths)) return {};
  return Object.fromEntries(Object.entries(paths).flatMap(([alias, targets]) => {
    if (!Array.isArray(targets)) return [];
    const resolved = targets.flatMap((target) => {
      if (typeof target !== "string") return [];
      const candidate = path.posix.normalize(path.posix.join(base, target));
      return candidate === ".." || candidate.startsWith("../") || candidate.startsWith("/") ? [] : [candidate];
    });
    return resolved.length > 0 ? [[alias, resolved] as const] : [];
  }));
}

function analyzeTsconfigs(sources: ReadonlyMap<string, ProjectManifestSource>): FrontendTsconfigManifest[] {
  const configSources = [...sources.values()].filter((source) =>
    /(^|\/)tsconfig(?:\.[^/]+)?\.json$/i.test(source.path)
  );
  const parsed = new Map(configSources.map((source) => [source.path, parseTsconfig(source)]));

  const mergedPaths = (configPath: string, visiting = new Set<string>()): Record<string, string[]> => {
    if (visiting.has(configPath)) throw new Error(`circular tsconfig extends: ${configPath}`);
    const config = parsed.get(configPath);
    if (!config) return {};
    const next = new Set(visiting).add(configPath);
    const extendsPath = typeof config.extends === "string"
      ? resolveConfigFile(configPath, config.extends, sources)
      : null;
    const inherited = extendsPath ? mergedPaths(extendsPath, next) : {};
    const compilerOptions = config.compilerOptions && typeof config.compilerOptions === "object"
      && !Array.isArray(config.compilerOptions) ? config.compilerOptions as JsonObject : {};
    return { ...inherited, ...localPaths(configPath, compilerOptions) };
  };

  return configSources.sort((left, right) => left.path.localeCompare(right.path)).map((source) => {
    const config = parsed.get(source.path) ?? {};
    const rawExtends = typeof config.extends === "string" ? config.extends : null;
    const extendsPath = rawExtends ? resolveConfigFile(source.path, rawExtends, sources) : null;
    const references = Array.isArray(config.references) ? config.references.flatMap((reference) => {
      if (!reference || typeof reference !== "object" || Array.isArray(reference)) return [];
      const target = (reference as JsonObject).path;
      if (typeof target !== "string") return [];
      const resolved = resolveConfigFile(source.path, target, sources);
      return resolved ? [resolved] : [];
    }) : [];
    return {
      path: source.path,
      ...(extendsPath ? { extendsPath } : {}),
      ...(rawExtends && !extendsPath ? { unresolvedExtends: rawExtends } : {}),
      references,
      paths: mergedPaths(source.path)
    };
  });
}

export function analyzeFrontendProjectManifest(input: readonly ProjectManifestSource[]): FrontendProjectManifest {
  const sources = new Map<string, ProjectManifestSource>();
  const ignoredPaths: string[] = [];
  for (const candidate of input) {
    const sourcePath = normalizeSourcePath(candidate.path);
    if (sources.has(sourcePath)) throw new Error(`duplicate source path: ${sourcePath}`);
    if (isExcluded(sourcePath)) {
      ignoredPaths.push(sourcePath);
      continue;
    }
    sources.set(sourcePath, { path: sourcePath, content: candidate.content });
  }

  const rootPackageSource = sources.get("package.json");
  const rootPackage = rootPackageSource ? parsePackageJson(rootPackageSource) : null;
  const pnpmSource = sources.get("pnpm-workspace.yaml") ?? sources.get("pnpm-workspace.yml");
  const patterns = pnpmSource
    ? pnpmWorkspacePatterns(pnpmSource)
    : packageWorkspacePatterns(rootPackage?.workspaces);
  const workspace: FrontendWorkspaceManifest | null = patterns.length > 0 ? {
    kind: pnpmSource ? "pnpm" : "package-json",
    packageManager: pnpmSource ? "pnpm" : packageManager(rootPackage?.packageManager),
    patterns
  } : null;

  const packageSources = [...sources.values()].filter((source) => source.path === "package.json"
    || source.path.endsWith("/package.json")).sort((left, right) => {
      if (left.path === "package.json") return -1;
      if (right.path === "package.json") return 1;
      return left.path.localeCompare(right.path);
    });
  const packages = packageSources.flatMap((source): FrontendPackageManifest[] => {
    const root = source.path === "package.json" ? "" : path.posix.dirname(source.path);
    if (root && (!workspace || !matchesWorkspaceRoot(root, workspace.patterns))) return [];
    const value = source.path === "package.json" && rootPackage ? rootPackage : parsePackageJson(source);
    return [{
      path: source.path,
      root,
      name: typeof value.name === "string" ? value.name : null,
      scripts: stringMap(value.scripts),
      dependencies: {
        ...stringMap(value.dependencies),
        ...stringMap(value.devDependencies),
        ...stringMap(value.peerDependencies),
        ...stringMap(value.optionalDependencies)
      },
      exports: value.exports ?? null,
      imports: value.imports ?? null
    }];
  });

  return {
    workspace,
    packages,
    tsconfigs: analyzeTsconfigs(sources),
    ignoredPaths: ignoredPaths.sort((left, right) => left.localeCompare(right))
  };
}
