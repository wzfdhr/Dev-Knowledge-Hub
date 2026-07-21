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
  type FrontendAnalyzerOutput,
  type FrontendAnalyzerSourceInput
} from "./analyzer.js";

const ANALYZER_ID = "typescript-core";
const ANALYZER_VERSION = "1.0.0";
const PARSER_CONFIG_DIGEST = frontendAnalyzerConfigDigest(ANALYZER_ID, ANALYZER_VERSION, `typescript@${ts.version}`);

export interface TypeScriptAnalyzerInput extends FrontendAnalyzerSourceInput {
  resolutions: Array<{ specifier: string; resolvedPath: string | null }>;
}

function scriptKind(sourcePath: string): ts.ScriptKind {
  const extension = path.posix.extname(sourcePath).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].includes(extension)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function moduleEntity(input: TypeScriptAnalyzerInput, canonicalPath: string, node: ts.Node): FrontendEntity {
  const identity = namedFrontendIdentity(`module:${canonicalPath}`);
  return {
    schemaVersion: 2,
    id: createFrontendEntityId({ kind: "application_entry", packageKey: input.packageKey, canonicalPath, identity }),
    kind: "application_entry",
    name: path.posix.basename(canonicalPath),
    qualifiedName: canonicalPath,
    completeness: "partial",
    packageKey: input.packageKey,
    canonicalPath,
    identity,
    facets: { [ANALYZER_ID]: { module: true } },
    attributes: { runtime: { state: "unknown", reason: "unresolved" } },
    sourceRefs: [frontendSourceRef(input, node.getStart(), node.end)],
    provenance: frontendAnalyzerProvenance(input, ANALYZER_ID, ANALYZER_VERSION, PARSER_CONFIG_DIGEST)
  };
}

function componentEntity(input: TypeScriptAnalyzerInput, canonicalPath: string, name: string, node: ts.Node, facet: Record<string, unknown>): FrontendEntity {
  const identity = namedFrontendIdentity(`component:${name}`);
  return {
    schemaVersion: 2,
    id: createFrontendEntityId({ kind: "component", packageKey: input.packageKey, canonicalPath, identity }),
    kind: "component",
    name,
    qualifiedName: `${canonicalPath}#${name}`,
    completeness: "partial",
    packageKey: input.packageKey,
    canonicalPath,
    identity,
    facets: Object.keys(facet).length === 0 ? {} : { [ANALYZER_ID]: facet },
    attributes: { componentType: { state: "unknown", reason: "unresolved" } },
    sourceRefs: [frontendSourceRef(input, node.getStart(), node.end)],
    provenance: frontendAnalyzerProvenance(input, ANALYZER_ID, ANALYZER_VERSION, PARSER_CONFIG_DIGEST)
  };
}

function symbolEntity(
  input: TypeScriptAnalyzerInput,
  source: ts.SourceFile,
  name: string,
  symbolKind: "function" | "class" | "interface" | "type" | "enum" | "variable",
  nodes: readonly ts.Node[],
  facet: Record<string, unknown>,
  partial = false
): FrontendEntity {
  const identity = namedFrontendIdentity(`symbol:${symbolKind}:${name}`);
  return {
    schemaVersion: 2,
    id: createFrontendEntityId({ kind: "symbol", packageKey: input.packageKey, canonicalPath: input.path, identity }),
    kind: "symbol",
    name,
    qualifiedName: `${input.path}#${name}`,
    completeness: partial ? "partial" : "complete",
    packageKey: input.packageKey,
    canonicalPath: input.path,
    identity,
    facets: { [ANALYZER_ID]: {
      ...facet,
      signatures: nodes.map((item) => item.getText(source).split("{")[0]!.trim())
    } },
    attributes: { symbolKind: { state: "known", value: symbolKind } },
    sourceRefs: nodes.map((item) => frontendSourceRef(input, item.getStart(source), item.end)),
    provenance: frontendAnalyzerProvenance(input, ANALYZER_ID, ANALYZER_VERSION, PARSER_CONFIG_DIGEST)
  };
}

function factEdge(
  input: TypeScriptAnalyzerInput,
  kind: FrontendEdge["kind"],
  fromEntityId: string,
  toEntityId: string,
  node: ts.Node,
  evidence: string
): FrontendEdge {
  const canonicalEvidenceKey = `${input.path}:${node.getStart()}:${evidence}`;
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

function exported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) =>
    modifier.kind === ts.SyntaxKind.ExportKeyword
  ) ?? false);
}

function genericParameters(node: ts.Node & { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }): string[] {
  return node.typeParameters?.map((parameter) => parameter.name.text) ?? [];
}

function utilityClasses(node: ts.Node, source: ts.SourceFile): string[] {
  const values = new Set<string>();
  const visit = (candidate: ts.Node): void => {
    if (ts.isJsxAttribute(candidate) && candidate.name.getText(source) === "className"
      && candidate.initializer && ts.isStringLiteral(candidate.initializer)) {
      for (const value of candidate.initializer.text.split(/\s+/).filter(Boolean)) values.add(value);
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return [...values].sort();
}

function containsDynamicExpressionImport(node: ts.Node): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (ts.isCallExpression(candidate) && candidate.expression.kind === ts.SyntaxKind.ImportKeyword
      && (!candidate.arguments[0] || !ts.isStringLiteralLike(candidate.arguments[0]))) found = true;
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

export function analyzeTypeScriptSource(inputValue: TypeScriptAnalyzerInput): FrontendAnalyzerOutput {
  const input = { ...inputValue, path: normalizeFrontendCanonicalPath(inputValue.path) };
  const source = ts.createSourceFile(input.path, input.content, ts.ScriptTarget.Latest, true, scriptKind(input.path));
  const entities = new Map<string, FrontendEntity>();
  const edges = new Map<string, FrontendEdge>();
  const resolutions = new Map(input.resolutions.map((resolution) => [resolution.specifier, resolution.resolvedPath]));
  const root = moduleEntity(input, input.path, source);
  entities.set(root.id, root);
  const importedComponents = new Map<string, { path: string; node: ts.Node }>();
  const functionDeclarations = new Map<string, ts.FunctionDeclaration[]>();

  const addModuleRelation = (node: ts.Node, specifier: string, kind: FrontendEdge["kind"]) => {
    const resolved = resolutions.get(specifier);
    if (!resolved) return;
    const canonicalPath = normalizeFrontendCanonicalPath(resolved);
    const target = moduleEntity(input, canonicalPath, node);
    entities.set(target.id, target);
    const edge = factEdge(input, kind, root.id, target.id, node, specifier);
    edges.set(edge.id, edge);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const group = functionDeclarations.get(node.name.text) ?? [];
      group.push(node);
      functionDeclarations.set(node.name.text, group);
    } else if (ts.isClassDeclaration(node) && node.name) {
      const entity = /^[A-Z]/.test(node.name.text) && exported(node)
          ? componentEntity(input, input.path, node.name.text, node, {
            exported: true,
            declarationKind: "class",
            genericParameters: genericParameters(node),
            utilityClasses: utilityClasses(node, source)
          })
        : symbolEntity(input, source, node.name.text, "class", [node], {
            exported: exported(node), genericParameters: genericParameters(node)
          });
      entities.set(entity.id, entity);
    } else if (ts.isInterfaceDeclaration(node)) {
      const entity = symbolEntity(input, source, node.name.text, "interface", [node], {
        exported: exported(node), genericParameters: genericParameters(node)
      });
      entities.set(entity.id, entity);
    } else if (ts.isTypeAliasDeclaration(node)) {
      const entity = symbolEntity(input, source, node.name.text, "type", [node], {
        exported: exported(node), genericParameters: genericParameters(node)
      });
      entities.set(entity.id, entity);
    } else if (ts.isEnumDeclaration(node)) {
      const entity = symbolEntity(input, source, node.name.text, "enum", [node], { exported: exported(node) });
      entities.set(entity.id, entity);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const variableStatement = node.parent.parent;
      const isExported = ts.isVariableStatement(variableStatement) && exported(variableStatement);
      const tagged = node.initializer && ts.isTaggedTemplateExpression(node.initializer)
        && (node.initializer.tag.getText(source).startsWith("styled.") || node.initializer.tag.getText(source) === "css");
      if (tagged) {
        const identity = namedFrontendIdentity(`style:${node.name.text}`);
        const entity: FrontendEntity = {
          schemaVersion: 2,
          id: createFrontendEntityId({ kind: "style_scope", packageKey: input.packageKey, canonicalPath: input.path, identity }),
          kind: "style_scope",
          name: node.name.text,
          qualifiedName: `${input.path}#${node.name.text}`,
          completeness: node.initializer.template.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ? "complete" : "partial",
          packageKey: input.packageKey,
          canonicalPath: input.path,
          identity,
          facets: { [ANALYZER_ID]: {
            cssInJs: true,
            staticTemplate: node.initializer.template.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral,
            tag: node.initializer.tag.getText(source)
          } },
          attributes: { scopeKind: { state: "known", value: "css-in-js" } },
          sourceRefs: [frontendSourceRef(input, node.getStart(source), node.end)],
          provenance: frontendAnalyzerProvenance(input, ANALYZER_ID, ANALYZER_VERSION, PARSER_CONFIG_DIGEST)
        };
        entities.set(entity.id, entity);
      } else {
        const functionLike = node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
        const kind = functionLike ? "function" : "variable";
        const entity = isExported && /^[A-Z]/.test(node.name.text) && functionLike
          ? componentEntity(input, input.path, node.name.text, node, {
              exported: true,
              declarationKind: "function",
              genericParameters: genericParameters(node.initializer as ts.ArrowFunction),
              utilityClasses: utilityClasses(node, source)
            })
          : symbolEntity(input, source, node.name.text, kind, [node], {
              exported: isExported,
              genericParameters: functionLike ? genericParameters(node.initializer as ts.ArrowFunction) : []
            }, containsDynamicExpressionImport(node));
        entities.set(entity.id, entity);
      }
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      addModuleRelation(node, node.moduleSpecifier.text, "imports");
      const resolved = resolutions.get(node.moduleSpecifier.text);
      if (resolved && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const element of node.importClause.namedBindings.elements) {
          importedComponents.set(element.name.text, { path: normalizeFrontendCanonicalPath(resolved), node });
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      addModuleRelation(node, node.moduleSpecifier.text, "exports");
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!)) {
      addModuleRelation(node, node.arguments[0].text, "lazy_loads");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  for (const [name, nodes] of functionDeclarations) {
    const implementation = nodes.findLast((node) => node.body) ?? nodes[nodes.length - 1]!;
    const entity = /^[A-Z]/.test(name) && exported(implementation)
      ? componentEntity(input, input.path, name, implementation, {
          exported: true,
          declarationKind: "function",
          overloadCount: nodes.length,
          genericParameters: genericParameters(implementation),
          utilityClasses: utilityClasses(implementation, source)
        })
      : symbolEntity(input, source, name, "function", nodes, {
          exported: nodes.some(exported),
          overloadCount: nodes.length,
          genericParameters: genericParameters(implementation)
        }, containsDynamicExpressionImport(implementation));
    entities.set(entity.id, entity);

    if (entity.kind !== "component") continue;
    const jsxVisit = (node: ts.Node): void => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)) {
        const targetImport = importedComponents.get(node.tagName.text);
        if (targetImport) {
          const target = componentEntity(input, targetImport.path, node.tagName.text, targetImport.node, {
            // Import sites establish identity and evidence; the definition owns semantic facets.
          });
          entities.set(target.id, target);
          const edge = factEdge(input, "renders", entity.id, target.id, node, node.tagName.text);
          edges.set(edge.id, edge);
        }
      }
      ts.forEachChild(node, jsxVisit);
    };
    jsxVisit(implementation);
  }

  if (/^(?:tailwind|uno)\.config\.[cm]?[jt]s$/.test(path.posix.basename(input.path))) {
    const tool = path.posix.basename(input.path).startsWith("tailwind") ? "tailwind" : "unocss";
    const identity = namedFrontendIdentity(`tooling:${tool}`);
    const entity: FrontendEntity = {
      schemaVersion: 2,
      id: createFrontendEntityId({ kind: "tooling_config", packageKey: input.packageKey, canonicalPath: input.path, identity }),
      kind: "tooling_config",
      name: tool,
      qualifiedName: `${input.path}#${tool}`,
      completeness: "partial",
      packageKey: input.packageKey,
      canonicalPath: input.path,
      identity,
      facets: { [ANALYZER_ID]: { configurationFile: true } },
      attributes: { tool: { state: "known", value: tool } },
      sourceRefs: [frontendSourceRef(input, 0, input.content.length)],
      provenance: frontendAnalyzerProvenance(input, ANALYZER_ID, ANALYZER_VERSION, PARSER_CONFIG_DIGEST)
    };
    entities.set(entity.id, entity);
  }

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
