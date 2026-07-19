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

const ANALYZER_ID = "react-router-core";
const ANALYZER_VERSION = "1.0.0";
const PARSER_CONFIG_DIGEST = frontendAnalyzerConfigDigest(ANALYZER_ID, ANALYZER_VERSION, `typescript@${ts.version}:react-router6-7`);

function scriptKind(sourcePath: string): ts.ScriptKind {
  return path.posix.extname(sourcePath).toLowerCase() === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
}

function entity(
  input: TypeScriptAnalyzerInput,
  kind: "route" | "layout" | "page" | "application_entry",
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
    qualifiedName: kind === "application_entry" ? canonicalPath : `${canonicalPath}#${semanticKey}`,
    completeness: "complete",
    packageKey: input.packageKey,
    canonicalPath,
    identity,
    facets: { [ANALYZER_ID]: facet },
    attributes,
    sourceRefs: [frontendSourceRef(input, node.getStart(), node.end)],
    provenance: frontendAnalyzerProvenance(input, ANALYZER_ID, ANALYZER_VERSION, PARSER_CONFIG_DIGEST)
  } as FrontendEntity;
}

function edge(
  input: TypeScriptAnalyzerInput,
  kind: FrontendEdge["kind"],
  fromEntityId: string,
  toEntityId: string,
  node: ts.Node,
  evidence: string
): FrontendEdge {
  const canonicalEvidenceKey = `${input.path}:${node.getStart()}:router:${evidence}`;
  const base = { kind, fromEntityId, toEntityId, canonicalEvidenceKey };
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

function routePath(parentPath: string | null, segment: string | null, index: boolean): string {
  if (index) return `${parentPath || "/"}#index`;
  if (!segment) return parentPath || "/";
  if (segment.startsWith("/")) return segment.replace(/\/+$/u, "") || "/";
  const parent = (parentPath || "").replace(/\/+$/u, "");
  return `${parent}/${segment}`.replace(/\/{2,}/gu, "/");
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | null {
  return object.properties.find((item): item is ts.PropertyAssignment =>
    ts.isPropertyAssignment(item) && item.name.getText().replace(/^['"]|['"]$/gu, "") === name
  ) ?? null;
}

function staticText(node: ts.Expression | undefined): string | null {
  return node && (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

function jsxComponentName(node: ts.Expression | undefined): { name: string; guard: string | null } | null {
  if (!node) return null;
  if (ts.isJsxElement(node)) return { name: node.openingElement.tagName.getText(), guard: null };
  if (ts.isJsxSelfClosingElement(node)) return { name: node.tagName.getText(), guard: null };
  if (ts.isConditionalExpression(node)) {
    const whenTrue = jsxComponentName(node.whenTrue);
    const whenFalse = jsxComponentName(node.whenFalse);
    const selected = whenTrue?.name === "Navigate" ? whenFalse : whenTrue;
    return selected ? { ...selected, guard: node.condition.getText() } : null;
  }
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) return { name: node.getText(), guard: null };
  return null;
}

function lazySpecifier(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  let result: string | null = null;
  const visit = (candidate: ts.Node): void => {
    if (ts.isCallExpression(candidate) && candidate.expression.kind === ts.SyntaxKind.ImportKeyword) {
      result = staticText(candidate.arguments[0]);
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return result;
}

export function analyzeReactRouterSource(inputValue: TypeScriptAnalyzerInput): FrontendAnalyzerOutput {
  const input = { ...inputValue, path: normalizeFrontendCanonicalPath(inputValue.path) };
  const source = ts.createSourceFile(input.path, input.content, ts.ScriptTarget.Latest, true, scriptKind(input.path));
  const entities = new Map<string, FrontendEntity>();
  const edges = new Map<string, FrontendEdge>();
  const resolutions = new Map(input.resolutions.map((item) => [item.specifier, item.resolvedPath]));
  const imports = new Map<string, string>();

  source.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier)) return;
    const resolved = resolutions.get(node.moduleSpecifier.text);
    if (!resolved || !node.importClause) return;
    if (node.importClause.name) imports.set(node.importClause.name.text, normalizeFrontendCanonicalPath(resolved));
    if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const item of node.importClause.namedBindings.elements) imports.set(item.name.text, normalizeFrontendCanonicalPath(resolved));
    }
  });

  const addRoute = (
    node: ts.Node,
    fullPath: string,
    component: { name: string; guard: string | null } | null,
    hasChildren: boolean,
    depth: number,
    parentRouteId: string | null,
    loader: string | null,
    action: string | null,
    lazy: string | null
  ): FrontendEntity => {
    const route = entity(
      input,
      "route",
      input.path,
      fullPath,
      `route:${fullPath}`,
      node,
      { loader, action, guard: component?.guard ?? null, lazySpecifier: lazy, nestingDepth: depth },
      {
        path: { state: "known", value: fullPath },
        dynamic: { state: "known", value: /[:*]/u.test(fullPath) }
      }
    );
    entities.set(route.id, route);
    if (parentRouteId) {
      const relation = edge(input, "contains", parentRouteId, route.id, node, fullPath);
      edges.set(relation.id, relation);
    }
    if (component && component.name !== "Navigate") {
      const targetPath = imports.get(component.name) ?? input.path;
      const targetKind = hasChildren ? "layout" as const : "page" as const;
      const target = entity(
        input,
        targetKind,
        targetPath,
        component.name,
        `${targetKind}:${component.name}`,
        node,
        { routerComponent: true },
        targetKind === "layout"
          ? { nestingDepth: { state: "known", value: depth } }
          : { routePath: { state: "known", value: fullPath } }
      );
      entities.set(target.id, target);
      const relation = edge(input, "routes_to", route.id, target.id, node, component.name);
      edges.set(relation.id, relation);
    }
    if (lazy) {
      const resolved = resolutions.get(lazy);
      if (resolved) {
        const targetPath = normalizeFrontendCanonicalPath(resolved);
        const target = entity(
          input,
          "application_entry",
          targetPath,
          path.posix.basename(targetPath),
          `module:${targetPath}`,
          node,
          { lazyRouteModule: true },
          { runtime: { state: "unknown", reason: "unresolved" } }
        );
        target.completeness = "partial";
        entities.set(target.id, target);
        const relation = edge(input, "lazy_loads", route.id, target.id, node, lazy);
        edges.set(relation.id, relation);
      }
    }
    return route;
  };

  const parseObjects = (items: ts.ArrayLiteralExpression, parentPath: string | null, parentRouteId: string | null, depth: number): void => {
    for (const item of items.elements) {
      if (!ts.isObjectLiteralExpression(item)) continue;
      const childrenProperty = property(item, "children");
      const children = childrenProperty?.initializer && ts.isArrayLiteralExpression(childrenProperty.initializer)
        ? childrenProperty.initializer : null;
      const index = property(item, "index")?.initializer.kind === ts.SyntaxKind.TrueKeyword;
      const fullPath = routePath(parentPath, staticText(property(item, "path")?.initializer), index);
      const elementProperty = property(item, "element")?.initializer;
      const componentProperty = property(item, "Component")?.initializer;
      const component = jsxComponentName(elementProperty ?? componentProperty);
      const lazy = lazySpecifier(property(item, "lazy")?.initializer);
      const route = addRoute(
        item,
        fullPath,
        component,
        Boolean(children),
        depth,
        parentRouteId,
        property(item, "loader")?.initializer.getText(source) ?? null,
        property(item, "action")?.initializer.getText(source) ?? null,
        lazy
      );
      if (children) parseObjects(children, fullPath.replace(/#index$/u, ""), route.id, depth + 1);
    }
  };

  const jsxAttribute = (node: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | null =>
    node.attributes.properties.find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText() === name) ?? null;
  const jsxValue = (attribute: ts.JsxAttribute | null): ts.Expression | undefined => {
    if (!attribute?.initializer) return undefined;
    if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer;
    return ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : undefined;
  };
  const parseJsxRoute = (element: ts.JsxElement | ts.JsxSelfClosingElement, parentPath: string | null, parentRouteId: string | null, depth: number): void => {
    const opening = ts.isJsxElement(element) ? element.openingElement : element;
    if (opening.tagName.getText(source) !== "Route") return;
    const index = Boolean(jsxAttribute(opening, "index"));
    const fullPath = routePath(parentPath, staticText(jsxValue(jsxAttribute(opening, "path"))), index);
    const childRoutes = ts.isJsxElement(element)
      ? element.children.filter((child): child is ts.JsxElement | ts.JsxSelfClosingElement =>
          ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child))
      : [];
    const route = addRoute(
      element,
      fullPath,
      jsxComponentName(jsxValue(jsxAttribute(opening, "element"))),
      childRoutes.length > 0,
      depth,
      parentRouteId,
      jsxValue(jsxAttribute(opening, "loader"))?.getText(source) ?? null,
      jsxValue(jsxAttribute(opening, "action"))?.getText(source) ?? null,
      lazySpecifier(jsxValue(jsxAttribute(opening, "lazy")))
    );
    for (const child of childRoutes) parseJsxRoute(child, fullPath.replace(/#index$/u, ""), route.id, depth + 1);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "createBrowserRouter"
      && node.arguments[0] && ts.isArrayLiteralExpression(node.arguments[0])) {
      parseObjects(node.arguments[0], null, null, 0);
    }
    if (ts.isCallExpression(node) && node.expression.getText(source) === "createRoutesFromElements") {
      const argument = node.arguments[0];
      if (argument && (ts.isJsxElement(argument) || ts.isJsxSelfClosingElement(argument))) parseJsxRoute(argument, null, null, 0);
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
