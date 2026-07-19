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

const ANALYZER_ID = "react-core";
const ANALYZER_VERSION = "1.0.0";
const PARSER_CONFIG_DIGEST = frontendAnalyzerConfigDigest(ANALYZER_ID, ANALYZER_VERSION, `typescript@${ts.version}:react18-19`);

function scriptKind(sourcePath: string): ts.ScriptKind {
  return path.posix.extname(sourcePath).toLowerCase() === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
}

function componentEntity(
  input: TypeScriptAnalyzerInput,
  canonicalPath: string,
  name: string,
  node: ts.Node,
  facet: Record<string, unknown>
): FrontendEntity {
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

function hookEntity(input: TypeScriptAnalyzerInput, name: string, node: ts.Node, effectful: boolean): FrontendEntity {
  const identity = namedFrontendIdentity(`hook:${name}`);
  return {
    schemaVersion: 2,
    id: createFrontendEntityId({ kind: "hook_or_composable", packageKey: input.packageKey, canonicalPath: input.path, identity }),
    kind: "hook_or_composable",
    name,
    qualifiedName: `${input.path}#${name}`,
    completeness: "complete",
    packageKey: input.packageKey,
    canonicalPath: input.path,
    identity,
    facets: { [ANALYZER_ID]: { custom: true } },
    attributes: { effectful: { state: "known", value: effectful } },
    sourceRefs: [frontendSourceRef(input, node.getStart(), node.end)],
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
  const canonicalEvidenceKey = `${input.path}:${node.getStart()}:react:${evidence}`;
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
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function collectInterfaceProps(source: ts.SourceFile): Map<string, Map<string, boolean>> {
  const result = new Map<string, Map<string, boolean>>();
  source.forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)) return;
    const members = ts.isInterfaceDeclaration(node)
      ? node.members
      : ts.isTypeLiteralNode(node.type) ? node.type.members : [];
    result.set(node.name.text, new Map(members.flatMap((member) =>
      ts.isPropertySignature(member) && member.name
        ? [[member.name.getText(source).replace(/^['"]|['"]$/gu, ""), Boolean(member.questionToken)] as const]
        : []
    )));
  });
  return result;
}

function componentProps(
  source: ts.SourceFile,
  functionNode: ts.FunctionLikeDeclaration,
  interfaceProps: ReadonlyMap<string, Map<string, boolean>>
): Array<{ name: string; optional: boolean; defaultValue?: string }> {
  const parameter = functionNode.parameters[0];
  if (!parameter || !ts.isObjectBindingPattern(parameter.name)) return [];
  const typeName = parameter.type && ts.isTypeReferenceNode(parameter.type) && ts.isIdentifier(parameter.type.typeName)
    ? parameter.type.typeName.text : null;
  const declared = typeName ? interfaceProps.get(typeName) : undefined;
  return parameter.name.elements.map((element) => {
    const name = element.propertyName?.getText(source) ?? element.name.getText(source);
    const value = element.initializer?.getText(source);
    return {
      name,
      optional: declared?.get(name) ?? Boolean(element.initializer),
      ...(value === undefined ? {} : { defaultValue: value })
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function hookFacts(source: ts.SourceFile, node: ts.Node) {
  const hooks: Array<Record<string, unknown>> = [];
  const states: Array<Record<string, unknown>> = [];
  const conditions = new Set<string>();
  let dynamic = false;
  const visit = (candidate: ts.Node): void => {
    if (ts.isCallExpression(candidate)) {
      const name = candidate.expression.getText(source);
      if (/^use[A-Z\d_]/u.test(name)) {
        const fact: Record<string, unknown> = { name };
        if (name === "useEffect" || name === "useLayoutEffect") {
          const dependencies = candidate.arguments[1];
          fact.dependencies = dependencies && ts.isArrayLiteralExpression(dependencies)
            ? dependencies.elements.map((item) => item.getText(source)) : null;
          const callback = candidate.arguments[0];
          fact.hasCleanup = Boolean(callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
            && callback.body && containsReturnFunction(callback.body));
        }
        hooks.push(fact);
      }
      if (!ts.isIdentifier(candidate.expression) && !ts.isPropertyAccessExpression(candidate.expression)) dynamic = true;
    }
    if (ts.isVariableDeclaration(candidate) && ts.isArrayBindingPattern(candidate.name)
      && candidate.initializer && ts.isCallExpression(candidate.initializer)
      && candidate.initializer.expression.getText(source) === "useState") {
      const stateElement = candidate.name.elements[0];
      const setterElement = candidate.name.elements[1];
      states.push({
        name: stateElement && ts.isBindingElement(stateElement) ? stateElement.name.getText(source) : "unknown",
        setter: setterElement && ts.isBindingElement(setterElement) ? setterElement.name.getText(source) : null
      });
    }
    if (ts.isIfStatement(candidate) || ts.isConditionalExpression(candidate)) {
      const expression = ts.isIfStatement(candidate) ? candidate.expression : candidate.condition;
      const conditionVisit = (item: ts.Node): void => {
        if (ts.isIdentifier(item)) conditions.add(item.text);
        ts.forEachChild(item, conditionVisit);
      };
      conditionVisit(expression);
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  const dedupe = <T extends Record<string, unknown>>(items: T[]) => [...new Map(items.map((item) => [JSON.stringify(item), item])).values()];
  return {
    hooks: dedupe(hooks),
    states: dedupe(states),
    loadingConsumers: [...conditions].filter((name) => /^[a-z_$]/u.test(name) && /loading/iu.test(name)).sort(),
    errorConsumers: [...conditions].filter((name) => /^[a-z_$]/u.test(name) && /error/iu.test(name)).sort(),
    analysisCompleteness: dynamic ? "partial" : "complete"
  };
}

function containsReturnFunction(node: ts.Node): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (ts.isReturnStatement(candidate) && candidate.expression
      && (ts.isArrowFunction(candidate.expression) || ts.isFunctionExpression(candidate.expression))) found = true;
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

function forwardRefFunction(initializer: ts.Expression | undefined): ts.FunctionLikeDeclaration | null {
  if (!initializer || !ts.isCallExpression(initializer) || initializer.expression.getText() !== "forwardRef") return null;
  const callback = initializer.arguments[0];
  return callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ? callback : null;
}

export function analyzeReactSource(inputValue: TypeScriptAnalyzerInput): FrontendAnalyzerOutput {
  const input = { ...inputValue, path: normalizeFrontendCanonicalPath(inputValue.path) };
  const source = ts.createSourceFile(input.path, input.content, ts.ScriptTarget.Latest, true, scriptKind(input.path));
  const entities = new Map<string, FrontendEntity>();
  const edges = new Map<string, FrontendEdge>();
  const resolutions = new Map(input.resolutions.map((item) => [item.specifier, item.resolvedPath]));
  const importedComponents = new Map<string, { path: string; node: ts.Node }>();
  const interfaceProps = collectInterfaceProps(source);

  source.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier)) return;
    const resolved = resolutions.get(node.moduleSpecifier.text);
    if (!resolved || !node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)) return;
    for (const element of node.importClause.namedBindings.elements) {
      importedComponents.set(element.name.text, { path: normalizeFrontendCanonicalPath(resolved), node });
    }
  });

  const addComponent = (name: string, declaration: ts.Node, functionNode: ts.FunctionLikeDeclaration, refMode: "forwardRef" | "ref-prop" | "none") => {
    const props = componentProps(source, functionNode, interfaceProps);
    const facts = hookFacts(source, functionNode);
    const entity = componentEntity(input, input.path, name, declaration, {
      componentKind: "function",
      refMode,
      props,
      ...facts
    });
    entities.set(entity.id, entity);
    const jsxVisit = (node: ts.Node): void => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)
        && /^[A-Z]/u.test(node.tagName.text)) {
        const imported = importedComponents.get(node.tagName.text);
        const targetPath = imported?.path ?? input.path;
        const target = componentEntity(input, targetPath, node.tagName.text, imported?.node ?? node, imported ? {} : {
          componentKind: "function",
          refMode: "none",
          props: [],
          hooks: [],
          states: [],
          loadingConsumers: [],
          errorConsumers: [],
          analysisCompleteness: "complete"
        });
        if (target.id !== entity.id) {
          if (!entities.has(target.id)) entities.set(target.id, target);
          const edge = factEdge(input, "renders", entity.id, target.id, node, node.tagName.text);
          edges.set(edge.id, edge);
        }
      }
      ts.forEachChild(node, jsxVisit);
    };
    jsxVisit(functionNode);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      if (/^use[A-Z\d_]/u.test(node.name.text)) {
        const effectful = hookFacts(source, node).hooks.some((hook) => hook.name === "useEffect" || hook.name === "useLayoutEffect");
        entities.set(hookEntity(input, node.name.text, node, effectful).id, hookEntity(input, node.name.text, node, effectful));
      } else if (/^[A-Z]/u.test(node.name.text) && exported(node)) {
        const hasRefProp = componentProps(source, node, interfaceProps).some((prop) => prop.name === "ref");
        addComponent(node.name.text, node, node, hasRefProp ? "ref-prop" : "none");
      }
    }
    if (ts.isVariableStatement(node) && exported(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !/^[A-Z]/u.test(declaration.name.text)) continue;
        const forwarded = forwardRefFunction(declaration.initializer);
        const direct = declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
          ? declaration.initializer : null;
        if (forwarded) addComponent(declaration.name.text, declaration, forwarded, "forwardRef");
        else if (direct) {
          const hasRefProp = componentProps(source, direct, interfaceProps).some((prop) => prop.name === "ref");
          addComponent(declaration.name.text, declaration, direct, hasRefProp ? "ref-prop" : "none");
        }
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
