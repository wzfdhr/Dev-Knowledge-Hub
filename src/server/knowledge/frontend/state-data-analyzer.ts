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

const ANALYZER_ID = "state-data-core";
const ANALYZER_VERSION = "1.0.0";
const PARSER_CONFIG_DIGEST = frontendAnalyzerConfigDigest(ANALYZER_ID, ANALYZER_VERSION, `typescript@${ts.version}:state-data-v1`);

function scriptKind(sourcePath: string): ts.ScriptKind {
  const extension = path.posix.extname(sourcePath).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].includes(extension)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function makeEntity(
  input: TypeScriptAnalyzerInput,
  kind: FrontendEntity["kind"],
  canonicalPath: string,
  name: string,
  semanticKey: string,
  node: ts.Node,
  completeness: "complete" | "partial",
  facet: Record<string, unknown>,
  attributes: FrontendEntity["attributes"]
): FrontendEntity {
  const identity = namedFrontendIdentity(semanticKey);
  return {
    schemaVersion: 2,
    id: createFrontendEntityId({ kind, packageKey: input.packageKey, canonicalPath, identity }),
    kind,
    name,
    qualifiedName: kind === "application_entry" ? canonicalPath : `${canonicalPath}#${name}`,
    completeness,
    packageKey: input.packageKey,
    canonicalPath,
    identity,
    facets: Object.keys(facet).length === 0 ? {} : { [ANALYZER_ID]: facet },
    attributes,
    sourceRefs: [frontendSourceRef(input, node.getStart(), node.end)],
    provenance: frontendAnalyzerProvenance(input, ANALYZER_ID, ANALYZER_VERSION, PARSER_CONFIG_DIGEST)
  } as FrontendEntity;
}

function makeEdge(
  input: TypeScriptAnalyzerInput,
  kind: FrontendEdge["kind"],
  fromEntityId: string,
  toEntityId: string,
  node: ts.Node,
  evidence: string
): FrontendEdge {
  const canonicalEvidenceKey = `${input.path}:${node.getStart()}:state-data:${evidence}`;
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

function objectFromFactory(call: ts.CallExpression): ts.ObjectLiteralExpression | null {
  const factory = call.arguments[0];
  if (!factory || (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory))) return null;
  if (ts.isObjectLiteralExpression(factory.body)) return factory.body;
  if (ts.isParenthesizedExpression(factory.body) && ts.isObjectLiteralExpression(factory.body.expression)) {
    return factory.body.expression;
  }
  if (!ts.isBlock(factory.body)) return null;
  for (const statement of factory.body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression && ts.isObjectLiteralExpression(statement.expression)) return statement.expression;
  }
  return null;
}

function fieldType(node: ts.Expression): string {
  if (ts.isStringLiteralLike(node)) return "string";
  if (ts.isNumericLiteral(node)) return "number";
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  if (ts.isArrayLiteralExpression(node)) return "array";
  if (ts.isObjectLiteralExpression(node)) return "object";
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return "function";
  return "unknown";
}

function staticEndpoint(node: ts.Expression | undefined): { path: string; complete: boolean } | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { path: node.text, complete: true };
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = span.expression;
      const parameter = ts.isIdentifier(expression) ? expression.text : "dynamic";
      value += `:${parameter}${span.literal.text}`;
    }
    return { path: value, complete: true };
  }
  return { path: "dynamic", complete: false };
}

function stringProperty(object: ts.ObjectLiteralExpression | undefined, name: string): string | null {
  if (!object) return null;
  const item = object.properties.find((property): property is ts.PropertyAssignment =>
    ts.isPropertyAssignment(property) && property.name.getText().replace(/^['"]|['"]$/gu, "") === name
  );
  return item && ts.isStringLiteralLike(item.initializer) ? item.initializer.text : null;
}

type ExecutableFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

function enclosingFunction(node: ts.Node): ExecutableFunction | null {
  let current = node.parent;
  while (current) {
    if ((ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)
      || ts.isArrowFunction(current) || ts.isMethodDeclaration(current)) && functionName(current)) return current;
    current = current.parent;
  }
  return null;
}

function functionName(node: ExecutableFunction): string | null {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return null;
}

export function analyzeStateDataSource(inputValue: TypeScriptAnalyzerInput): FrontendAnalyzerOutput {
  const input = { ...inputValue, path: normalizeFrontendCanonicalPath(inputValue.path) };
  const source = ts.createSourceFile(input.path, input.content, ts.ScriptTarget.Latest, true, scriptKind(input.path));
  const entities = new Map<string, FrontendEntity>();
  const edges = new Map<string, FrontendEdge>();
  const stores = new Map<string, FrontendEntity>();
  const functions = new Map<string, { node: ts.FunctionLikeDeclaration; entity: FrontendEntity }>();
  const browserChannels: Array<Record<string, unknown>> = [];
  const importedSymbols = new Map<string, string>();

  source.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier)) return;
    const specifier = node.moduleSpecifier.text;
    const resolved = input.resolutions.find((item) => item.specifier === specifier)?.resolvedPath;
    if (!resolved || !node.importClause) return;
    const canonicalPath = normalizeFrontendCanonicalPath(resolved);
    if (node.importClause.name) importedSymbols.set(node.importClause.name.text, canonicalPath);
    if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const item of node.importClause.namedBindings.elements) importedSymbols.set(item.name.text, canonicalPath);
    }
  });

  const module = makeEntity(
    input,
    "application_entry",
    input.path,
    path.posix.basename(input.path),
    `module:${input.path}`,
    source,
    "partial",
    { module: true, browserChannels },
    { runtime: { state: "unknown", reason: "unresolved" } }
  );
  entities.set(module.id, module);

  const functionEntity = (node: ts.FunctionLikeDeclaration, name: string): FrontendEntity => {
    if (/^[A-Z]/u.test(name)) {
      return makeEntity(
        input,
        "component",
        input.path,
        name,
        `component:${name}`,
        node,
        "partial",
        { dataConsumer: true },
        { componentType: { state: "unknown", reason: "unresolved" } }
      );
    }
    if (/^use[A-Z\d_]/u.test(name)) {
      return makeEntity(
        input,
        "hook_or_composable",
        input.path,
        name,
        `hook:${name}`,
        node,
        "complete",
        { dataConsumer: true },
        { effectful: { state: "known", value: false } }
      );
    }
    return makeEntity(
      input,
      "symbol",
      input.path,
      name,
      `symbol:function:${name}`,
      node,
      "complete",
      { dataFunction: true },
      { symbolKind: { state: "known", value: "function" } }
    );
  };

  const collectFunctions = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const value = functionEntity(node, node.name.text);
      functions.set(node.name.text, { node, entity: value });
      entities.set(value.id, value);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      const value = functionEntity(node.initializer, node.name.text);
      functions.set(node.name.text, { node: node.initializer, entity: value });
      entities.set(value.id, value);
    }
    ts.forEachChild(node, collectFunctions);
  };
  collectFunctions(source);

  const addStore = (name: string, library: "zustand" | "react-context", node: ts.VariableDeclaration, object: ts.ObjectLiteralExpression | null) => {
    const store = makeEntity(
      input,
      "state_store",
      input.path,
      name,
      `state-store:${name}`,
      node,
      object ? "complete" : "partial",
      { factory: library },
      { library: { state: "known", value: library } }
    );
    entities.set(store.id, store);
    stores.set(name, store);
    if (!object) return;
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) continue;
      const fieldName = property.name.getText(source).replace(/^['"]|['"]$/gu, "");
      const initializer = ts.isPropertyAssignment(property) ? property.initializer : property;
      const field = makeEntity(
        input,
        "state_field",
        input.path,
        fieldName,
        `state-field:${name}:${fieldName}`,
        property,
        "complete",
        { storeName: name },
        { fieldType: { state: "known", value: fieldType(initializer as ts.Expression) } }
      );
      entities.set(field.id, field);
      const relation = makeEdge(input, "contains", store.id, field.id, property, fieldName);
      edges.set(relation.id, relation);
    }
  };

  const collectStores = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression.getText(source);
      if (callee === "create") addStore(node.name.text, "zustand", node, objectFromFactory(node.initializer));
      if (callee === "createContext") {
        const initial = node.initializer.arguments[0];
        addStore(node.name.text, "react-context", node, initial && ts.isObjectLiteralExpression(initial) ? initial : null);
      }
    }
    ts.forEachChild(node, collectStores);
  };
  collectStores(source);

  let operationOrdinal = 0;
  const requestFunctions = new Set<string>();
  const collectOperations = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      const axiosMatch = /^axios\.(get|post|put|patch|delete|head|options)$/iu.exec(callee);
      const isFetch = callee === "fetch";
      if (axiosMatch || isFetch) {
        const endpoint = staticEndpoint(node.arguments[0]);
        if (endpoint) {
          const options = isFetch && node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1]) ? node.arguments[1] : undefined;
          const method = (axiosMatch?.[1] ?? stringProperty(options, "method") ?? "GET").toUpperCase();
          const operation = makeEntity(
            input,
            "api_operation",
            input.path,
            `${method} ${endpoint.path}`,
            `api:${method}:${endpoint.path}`,
            node,
            endpoint.complete ? "complete" : "partial",
            { client: axiosMatch ? "axios" : "fetch", ordinal: operationOrdinal },
            {
              method: { state: "known", value: method },
              path: endpoint.complete ? { state: "known", value: endpoint.path } : { state: "unknown", reason: "dynamic" }
            }
          );
          operationOrdinal += 1;
          entities.set(operation.id, operation);
          const ownerNode = enclosingFunction(node);
          const ownerName = ownerNode ? functionName(ownerNode) : null;
          const owner = ownerName ? functions.get(ownerName)?.entity : module;
          if (owner) {
            const relation = makeEdge(input, "requests", owner.id, operation.id, node, `${method}:${endpoint.path}`);
            edges.set(relation.id, relation);
            if (ownerName) requestFunctions.add(ownerName);
          }
        }
      }
    }
    ts.forEachChild(node, collectOperations);
  };
  collectOperations(source);

  const collectConsumers = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const ownerNode = enclosingFunction(node);
      const ownerName = ownerNode ? functionName(ownerNode) : null;
      const owner = ownerName ? functions.get(ownerName)?.entity : null;
      let store = stores.get(node.expression.text);
      const importedPath = importedSymbols.get(node.expression.text);
      if (!store && importedPath && /^use(?:[A-Z\d_].*)?Store$/u.test(node.expression.text)) {
        store = makeEntity(
          input,
          "state_store",
          importedPath,
          node.expression.text,
          `state-store:${node.expression.text}`,
          node,
          "complete",
          {},
          { library: { state: "known", value: "zustand" } }
        );
        entities.set(store.id, store);
      }
      if (owner && store) {
        const relation = makeEdge(input, "reads_state", owner.id, store.id, node, node.expression.text);
        edges.set(relation.id, relation);
      }
      if (owner && requestFunctions.has(node.expression.text)) {
        const requested = functions.get(node.expression.text)?.entity;
        if (requested && requested.id !== owner.id) {
          const relation = makeEdge(input, "requests", owner.id, requested.id, node, node.expression.text);
          edges.set(relation.id, relation);
        }
      }
      if (owner && importedPath && !store && !/^use[A-Z\d_]/u.test(node.expression.text)) {
        const requested = makeEntity(
          input,
          "symbol",
          importedPath,
          node.expression.text,
          `symbol:function:${node.expression.text}`,
          node,
          "complete",
          {},
          { symbolKind: { state: "known", value: "function" } }
        );
        entities.set(requested.id, requested);
        const relation = makeEdge(input, "requests", owner.id, requested.id, node, node.expression.text);
        edges.set(relation.id, relation);
      }
      if (owner && node.expression.text === "useContext" && node.arguments[0] && ts.isIdentifier(node.arguments[0])) {
        const context = stores.get(node.arguments[0].text);
        if (context) {
          const relation = makeEdge(input, "injects", owner.id, context.id, node, node.arguments[0].text);
          edges.set(relation.id, relation);
        }
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)
      && (node.expression.text === "EventSource" || node.expression.text === "WebSocket")) {
      const endpoint = staticEndpoint(node.arguments?.[0]);
      browserChannels.push({
        kind: node.expression.text === "EventSource" ? "sse" : "websocket",
        endpoint: endpoint?.complete ? endpoint.path : null,
        completeness: endpoint?.complete ? "complete" : "partial"
      });
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ["localStorage", "sessionStorage"].includes(node.expression.expression.getText(source))) {
      const key = staticEndpoint(node.arguments[0]);
      browserChannels.push({
        kind: "storage",
        storage: node.expression.expression.getText(source),
        operation: node.expression.name.text,
        key: key?.complete ? key.path : null,
        completeness: key?.complete ? "complete" : "partial"
      });
    }
    if (ts.isElementAccessExpression(node) && node.expression.getText(source) === "flags") {
      const key = staticEndpoint(node.argumentExpression);
      browserChannels.push({ kind: "feature-flag", key: key?.complete ? key.path : null, completeness: key?.complete ? "complete" : "partial" });
    }
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && ts.isPropertyAccessExpression(node.tagName) && node.tagName.name.text === "Provider"
      && ts.isIdentifier(node.tagName.expression)) {
      const contextName = node.tagName.expression.text;
      let context = stores.get(contextName);
      const importedPath = importedSymbols.get(contextName);
      if (!context && importedPath) {
        context = makeEntity(
          input,
          "state_store",
          importedPath,
          contextName,
          `state-store:${contextName}`,
          node,
          "complete",
          {},
          { library: { state: "known", value: "react-context" } }
        );
        entities.set(context.id, context);
      }
      if (context) {
        const ownerNode = enclosingFunction(node);
        const ownerName = ownerNode ? functionName(ownerNode) : null;
        const owner = ownerName ? functions.get(ownerName)?.entity : module;
        if (owner) {
          const relation = makeEdge(input, "provides", owner.id, context.id, node, contextName);
          edges.set(relation.id, relation);
        }
      }
    }
    ts.forEachChild(node, collectConsumers);
  };
  collectConsumers(source);

  browserChannels.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
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
