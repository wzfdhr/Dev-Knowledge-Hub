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

const ANALYZER_ID = "visualization-core";
const ANALYZER_VERSION = "1.0.0";
const PARSER_CONFIG_DIGEST = frontendAnalyzerConfigDigest(ANALYZER_ID, ANALYZER_VERSION, `typescript@${ts.version}:echarts5-6`);

function scriptKind(sourcePath: string): ts.ScriptKind {
  return path.posix.extname(sourcePath).toLowerCase() === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function visualizationEntity(
  input: TypeScriptAnalyzerInput,
  name: string,
  node: ts.Node,
  facet: Record<string, unknown>,
  complete = true
): FrontendEntity {
  const identity = namedFrontendIdentity(`visualization:echarts:${name}`);
  return {
    schemaVersion: 2,
    id: createFrontendEntityId({ kind: "visualization", packageKey: input.packageKey, canonicalPath: input.path, identity }),
    kind: "visualization",
    name,
    qualifiedName: `${input.path}#${name}`,
    completeness: complete ? "complete" : "partial",
    packageKey: input.packageKey,
    canonicalPath: input.path,
    identity,
    facets: { [ANALYZER_ID]: facet },
    attributes: { library: { state: "known", value: "echarts" } },
    sourceRefs: [frontendSourceRef(input, node.getStart(), node.end)],
    provenance: frontendAnalyzerProvenance(input, ANALYZER_ID, ANALYZER_VERSION, PARSER_CONFIG_DIGEST)
  };
}

function componentEntity(input: TypeScriptAnalyzerInput, name: string, node: ts.Node): FrontendEntity {
  const identity = namedFrontendIdentity(`component:${name}`);
  return {
    schemaVersion: 2,
    id: createFrontendEntityId({ kind: "component", packageKey: input.packageKey, canonicalPath: input.path, identity }),
    kind: "component",
    name,
    qualifiedName: `${input.path}#${name}`,
    completeness: "partial",
    packageKey: input.packageKey,
    canonicalPath: input.path,
    identity,
    facets: { [ANALYZER_ID]: { chartWrapper: true } },
    attributes: { componentType: { state: "unknown", reason: "unresolved" } },
    sourceRefs: [frontendSourceRef(input, node.getStart(), node.end)],
    provenance: frontendAnalyzerProvenance(input, ANALYZER_ID, ANALYZER_VERSION, PARSER_CONFIG_DIGEST)
  };
}

function visualizesEdge(input: TypeScriptAnalyzerInput, componentId: string, chartId: string, node: ts.Node): FrontendEdge {
  const canonicalEvidenceKey = `${input.path}:${node.getStart()}:visualizes`;
  const base = { kind: "visualizes" as const, fromEntityId: componentId, toEntityId: chartId, canonicalEvidenceKey };
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

function namedProperty(object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | null {
  return object.properties.find((item) => item.name?.getText().replace(/^['"]|['"]$/gu, "") === name) ?? null;
}

function propertyExpression(object: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  const item = namedProperty(object, name);
  return item && ts.isPropertyAssignment(item) ? item.initializer : null;
}

function optionFacts(object: ts.ObjectLiteralExpression, source: ts.SourceFile) {
  const seriesValue = propertyExpression(object, "series");
  const series = seriesValue && ts.isArrayLiteralExpression(seriesValue)
    ? seriesValue.elements.flatMap((item) => {
        if (!ts.isObjectLiteralExpression(item)) return [];
        const type = propertyExpression(item, "type");
        return type && ts.isStringLiteralLike(type) ? [{ type: type.text }] : [{ type: "unknown" }];
      }) : [];
  const axes = ["xAxis", "yAxis", "radar", "parallelAxis"].filter((name) => namedProperty(object, name));
  const features = ["visualMap", "dataZoom", "brush"].filter((name) => namedProperty(object, name)).sort();
  return {
    datasets: namedProperty(object, "dataset") ? 1 : 0,
    series,
    axes,
    features,
    optionText: object.getText(source).slice(0, 4_000)
  };
}

function returnedObject(node: ts.FunctionLikeDeclaration): ts.ObjectLiteralExpression | null {
  if (!node.body) return null;
  if (ts.isObjectLiteralExpression(node.body)) return node.body;
  if (ts.isParenthesizedExpression(node.body) && ts.isObjectLiteralExpression(node.body.expression)) return node.body.expression;
  if (!ts.isBlock(node.body)) return null;
  for (const statement of node.body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression && ts.isObjectLiteralExpression(statement.expression)) return statement.expression;
  }
  return null;
}

function ownerFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  let current = node.parent;
  while (current) {
    if ((ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current))
      && ownerName(current)) return current;
    current = current.parent;
  }
  return null;
}

function ownerName(node: ts.FunctionLikeDeclaration | null): string | null {
  if (!node) return null;
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return null;
}

export function analyzeVisualizationSource(inputValue: TypeScriptAnalyzerInput): FrontendAnalyzerOutput {
  const input = { ...inputValue, path: normalizeFrontendCanonicalPath(inputValue.path) };
  const source = ts.createSourceFile(input.path, input.content, ts.ScriptTarget.Latest, true, scriptKind(input.path));
  const entities = new Map<string, FrontendEntity>();
  const edges = new Map<string, FrontendEdge>();

  const addBuilder = (name: string, node: ts.FunctionLikeDeclaration): void => {
    const object = returnedObject(node);
    if (!object || !namedProperty(object, "series")) return;
    const chart = visualizationEntity(input, name, node, { optionBuilder: true, ...optionFacts(object, source) });
    entities.set(chart.id, chart);
  };
  const collectBuilders = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) addBuilder(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) addBuilder(node.name.text, node.initializer);
    ts.forEachChild(node, collectBuilders);
  };
  collectBuilders(source);

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)
      && /(?:^|\.)init$/u.test(node.initializer.expression.getText(source))) {
      const chartName = node.name.text;
      const owner = ownerFunction(node);
      const scope = owner ?? source;
      let option: ts.ObjectLiteralExpression | null = null;
      let dynamicOption = false;
      let disposes = false;
      let resizes = false;
      const events = new Set<string>();
      const scopeVisit = (candidate: ts.Node): void => {
        if (ts.isCallExpression(candidate) && ts.isPropertyAccessExpression(candidate.expression)
          && candidate.expression.expression.getText(source) === chartName) {
          const method = candidate.expression.name.text;
          if (method === "setOption") {
            const value = candidate.arguments[0];
            if (value && ts.isObjectLiteralExpression(value)) option = value;
            else dynamicOption = true;
          }
          if (method === "dispose") disposes = true;
          if (method === "resize") resizes = true;
          if (method === "on" && candidate.arguments[0] && ts.isStringLiteralLike(candidate.arguments[0])) events.add(candidate.arguments[0].text);
        }
        ts.forEachChild(candidate, scopeVisit);
      };
      scopeVisit(scope);
      const chart = visualizationEntity(input, chartName, node, {
        initialized: true,
        ...(option ? optionFacts(option, source) : { datasets: 0, series: [], axes: [], features: [] }),
        events: [...events].sort(),
        disposes,
        resizes,
        dynamicOption
      }, !dynamicOption);
      entities.set(chart.id, chart);
      const name = ownerName(owner);
      if (name && /^[A-Z]/u.test(name)) {
        const component = componentEntity(input, name, owner!);
        entities.set(component.id, component);
        const relation = visualizesEdge(input, component.id, chart.id, node);
        edges.set(relation.id, relation);
      }
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
