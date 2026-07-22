import path from "node:path";

import ts from "typescript";

import type { FrontendEdge, FrontendEntity } from "../../../shared/frontend-ir.js";
import {
  createFrontendEdgeId,
  createFrontendEntityId,
  frontendAnalyzerConfigDigest,
  frontendAnalyzerProvenance,
  frontendSourceRef,
  namedFrontendIdentity,
  normalizeFrontendCanonicalPath,
  type FrontendAnalyzerOutput
} from "./analyzer.js";
import type { TypeScriptAnalyzerInput } from "./typescript-analyzer.js";

const ANALYZER_ID = "tooling-test-core";
const ANALYZER_VERSION = "1.0.0";
const PARSER_CONFIG_DIGEST = frontendAnalyzerConfigDigest(ANALYZER_ID, ANALYZER_VERSION, `typescript@${ts.version}:vite-tests-storybook-v2`);

function scriptKind(sourcePath: string): ts.ScriptKind {
  const extension = path.posix.extname(sourcePath).toLowerCase();
  return extension === ".tsx" || extension === ".jsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function entity(
  input: TypeScriptAnalyzerInput,
  kind: "tooling_config" | "test_case" | "test_fixture" | "component",
  canonicalPath: string,
  name: string,
  semanticKey: string,
  node: ts.Node,
  facet: Record<string, unknown>,
  attributes: FrontendEntity["attributes"]
): FrontendEntity {
  const identity = namedFrontendIdentity(semanticKey);
  return {
    schemaVersion: 2,
    id: createFrontendEntityId({ kind, packageKey: input.packageKey, canonicalPath, identity }),
    kind,
    name,
    qualifiedName: `${canonicalPath}#${name}`,
    completeness: kind === "component" ? "partial" : "complete",
    packageKey: input.packageKey,
    canonicalPath,
    identity,
    facets: Object.keys(facet).length ? { [ANALYZER_ID]: facet } : {},
    attributes,
    sourceRefs: [frontendSourceRef(input, node.getStart(), node.end)],
    provenance: frontendAnalyzerProvenance(input, ANALYZER_ID, ANALYZER_VERSION, PARSER_CONFIG_DIGEST)
  } as FrontendEntity;
}

function testsEdge(input: TypeScriptAnalyzerInput, fromEntityId: string, toEntityId: string, node: ts.Node): FrontendEdge {
  const canonicalEvidenceKey = `${input.path}:${node.getStart()}:tests`;
  const base = { kind: "tests" as const, fromEntityId, toEntityId, canonicalEvidenceKey };
  return {
    schemaVersion: 2,
    id: createFrontendEdgeId(base),
    ...base,
    evidenceClass: "fact",
    confidence: 1,
    sourceRefs: [frontendSourceRef(input, node.getStart(), node.end)],
    provenance: frontendAnalyzerProvenance(input, ANALYZER_ID, ANALYZER_VERSION, PARSER_CONFIG_DIGEST)
  };
}

function objectProperty(object: ts.ObjectLiteralExpression | null, name: string): ts.Expression | null {
  if (!object) return null;
  const item = object.properties.find((property): property is ts.PropertyAssignment =>
    ts.isPropertyAssignment(property) && property.name.getText().replace(/^['"]|['"]$/gu, "") === name
  );
  return item?.initializer ?? null;
}

function objectValue(value: ts.Expression | null): ts.ObjectLiteralExpression | null {
  return value && ts.isObjectLiteralExpression(value) ? value : null;
}

function objectKeys(object: ts.ObjectLiteralExpression | null): string[] {
  return object?.properties.flatMap((item) => item.name ? [item.name.getText().replace(/^['"]|['"]$/gu, "")] : []).sort() ?? [];
}

function stringArray(value: ts.Expression | null): string[] {
  if (!value || !ts.isArrayLiteralExpression(value)) return [];
  return value.elements.flatMap((item) => ts.isStringLiteralLike(item) ? [item.text] : []).sort();
}

function stringOrNamedObject(value: ts.Expression | null): string | null {
  if (!value) return null;
  if (ts.isStringLiteralLike(value)) return value.text;
  const object = objectValue(value);
  const name = objectProperty(object, "name");
  return name && ts.isStringLiteralLike(name) ? name.text : null;
}

function stringsFromCalls(node: ts.Node, source: ts.SourceFile, matcher: RegExp): string[] {
  const values = new Set<string>();
  const visit = (candidate: ts.Node): void => {
    if (ts.isCallExpression(candidate) && matcher.test(candidate.expression.getText(source))) {
      const value = candidate.arguments[0];
      if (value && ts.isStringLiteralLike(value)) values.add(value.text);
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return [...values].sort();
}

export function analyzeToolingTestSource(inputValue: TypeScriptAnalyzerInput): FrontendAnalyzerOutput {
  const input = { ...inputValue, path: normalizeFrontendCanonicalPath(inputValue.path) };
  const source = ts.createSourceFile(input.path, input.content, ts.ScriptTarget.Latest, true, scriptKind(input.path));
  const entities = new Map<string, FrontendEntity>();
  const edges = new Map<string, FrontendEdge>();
  const resolutions = new Map(input.resolutions.map((item) => [item.specifier, item.resolvedPath]));
  const importedComponents = new Map<string, { path: string; node: ts.Node }>();

  source.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier)) return;
    const resolved = resolutions.get(node.moduleSpecifier.text);
    if (!resolved || !node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)) return;
    for (const item of node.importClause.namedBindings.elements) {
      if (/^[A-Z]/u.test(item.name.text)) importedComponents.set(item.name.text, { path: normalizeFrontendCanonicalPath(resolved), node });
    }
  });

  if (/^vite\.config\.[cm]?[jt]s$/u.test(path.posix.basename(input.path))) {
    let config: ts.ObjectLiteralExpression | null = null;
    const find = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "defineConfig"
        && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) config = node.arguments[0];
      ts.forEachChild(node, find);
    };
    find(source);
    const resolvedConfig = config as ts.ObjectLiteralExpression | null;
    const pluginArray = objectProperty(resolvedConfig, "plugins");
    const resolve = objectValue(objectProperty(resolvedConfig, "resolve"));
    const build = objectValue(objectProperty(resolvedConfig, "build"));
    const rollup = objectValue(objectProperty(build, "rollupOptions"));
    const output = objectValue(objectProperty(rollup, "output"));
    const server = objectValue(objectProperty(resolvedConfig, "server"));
    const test = objectValue(objectProperty(resolvedConfig, "test"));
    const environment = objectProperty(test, "environment");
    const value = entity(input, "tooling_config", input.path, "vite", "tooling:vite", resolvedConfig ?? source, {
      plugins: pluginArray && ts.isArrayLiteralExpression(pluginArray)
        ? pluginArray.elements.map((item) => item.getText(source).replace(/\(.*$/u, "")).sort() : [],
      aliases: objectKeys(objectValue(objectProperty(resolve, "alias"))),
      proxyPaths: objectKeys(objectValue(objectProperty(server, "proxy"))),
      manualChunks: objectKeys(objectValue(objectProperty(output, "manualChunks"))),
      testEnvironment: environment && ts.isStringLiteralLike(environment) ? environment.text : null,
      sourcemap: objectProperty(build, "sourcemap")?.kind === ts.SyntaxKind.TrueKeyword
    }, { tool: { state: "known", value: "vite" } });
    entities.set(value.id, value);
  }

  if (input.path.includes(".storybook/")) {
    let config: ts.ObjectLiteralExpression | null = null;
    source.forEachChild((node) => {
      if (!ts.isExportAssignment(node)) return;
      const expression = ts.isSatisfiesExpression(node.expression) ? node.expression.expression : node.expression;
      if (ts.isObjectLiteralExpression(expression)) config = expression;
    });
    const storybookConfig = config as ts.ObjectLiteralExpression | null;
    const stories = stringArray(objectProperty(storybookConfig, "stories"));
    const addons = stringArray(objectProperty(storybookConfig, "addons"));
    const framework = stringOrNamedObject(objectProperty(storybookConfig, "framework"));
    const deep = path.posix.basename(input.path).startsWith("main.") && stories.length > 0 && framework !== null;
    const value = entity(input, "tooling_config", input.path, "storybook", "tooling:storybook", storybookConfig ?? source, deep ? {
      supportLevel: "deep",
      stories,
      addons,
      framework
    } : { supportLevel: "basic-recognition", configurationFile: true }, { tool: { state: "known", value: "storybook" } });
    if (!deep) value.completeness = "partial";
    entities.set(value.id, value);
  }

  const basicTool = /(?:^|\/)(?:webpack|rspack)\.config\./u.test(input.path) ? "webpack-family"
      : /(?:^|\/)rollup\.config\./u.test(input.path) ? "rollup"
        : /(?:^|\/)turbo\.json$/u.test(input.path) ? "turborepo"
          : /(?:^|\/)(?:nx\.json|project\.json)$/u.test(input.path) ? "nx"
            : null;
  if (basicTool) {
    const value = entity(input, "tooling_config", input.path, basicTool, `tooling:${basicTool}`, source,
      { supportLevel: "basic-recognition", configurationFile: true }, { tool: { state: "known", value: basicTool } });
    value.completeness = "partial";
    entities.set(value.id, value);
  }

  let testOrdinal = 0;
  const isE2e = /(?:^|\/)(?:e2e|cypress)(?:\/|$)|\.(?:e2e|spec)\.[jt]sx?$/u.test(input.path)
    && (/page\./u.test(input.content) || /cy\./u.test(input.content));
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && ["beforeEach", "afterEach", "beforeAll", "afterAll"].includes(node.expression.text)) {
      const value = entity(input, "test_fixture", input.path, node.expression.text, `test-fixture:${node.expression.text}:${testOrdinal}`, node,
        { frameworkHook: true }, { fixtureKind: { state: "known", value: "lifecycle" } });
      entities.set(value.id, value);
      testOrdinal += 1;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["test", "it"].includes(node.expression.text)) {
      const title = node.arguments[0];
      const name = title && ts.isStringLiteralLike(title) ? title.text : `test-${testOrdinal + 1}`;
      const body = node.arguments[1];
      const renderTargets = new Set<string>();
      if (body) {
        const renderVisit = (candidate: ts.Node): void => {
          if ((ts.isJsxOpeningElement(candidate) || ts.isJsxSelfClosingElement(candidate)) && ts.isIdentifier(candidate.tagName)
            && importedComponents.has(candidate.tagName.text)) renderTargets.add(candidate.tagName.text);
          ts.forEachChild(candidate, renderVisit);
        };
        renderVisit(body);
      }
      const kind = isE2e ? "e2e" as const : renderTargets.size ? "component" as const : "unit" as const;
      const testCase = entity(input, "test_case", input.path, name, `test-case:${testOrdinal}:${name}`, node, {
        framework: /cypress/iu.test(input.path) ? "cypress" : isE2e ? "playwright" : /jest/iu.test(input.content) ? "jest" : "vitest",
        suites: [],
        routes: body ? stringsFromCalls(body, source, /(?:page\.goto|cy\.visit)$/u) : [],
        locators: body ? [...new Set(["getByRole", "getByText", "locator", "getByTestId"].filter((item) => body.getText(source).includes(item)))].sort() : [],
        networkMocks: body ? stringsFromCalls(body, source, /(?:page\.route|cy\.intercept)$/u) : [],
        mocks: body ? stringsFromCalls(body, source, /(?:vi|jest)\.mock$/u) : []
      }, { testKind: { state: "known", value: kind } });
      entities.set(testCase.id, testCase);
      for (const targetName of renderTargets) {
        const imported = importedComponents.get(targetName)!;
        const target = entity(input, "component", imported.path, targetName, `component:${targetName}`, imported.node, {},
          { componentType: { state: "unknown", reason: "unresolved" } });
        entities.set(target.id, target);
        const relation = testsEdge(input, testCase.id, target.id, node);
        edges.set(relation.id, relation);
      }
      testOrdinal += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return {
    snapshotId: input.snapshotId,
    analyzerId: ANALYZER_ID,
    analyzerVersion: ANALYZER_VERSION,
    parserConfigDigest: PARSER_CONFIG_DIGEST,
    sourceBlobHashes: [input.blobHash],
    entities: [...entities.values()],
    edges: [...edges.values()],
    facetPatches: []
  };
}
