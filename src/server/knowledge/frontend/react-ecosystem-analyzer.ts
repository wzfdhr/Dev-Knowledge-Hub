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

const ANALYZER_ID = "react-ecosystem-core";
const ANALYZER_VERSION = "1.0.0";
const PARSER_CONFIG_DIGEST = frontendAnalyzerConfigDigest(
  ANALYZER_ID,
  ANALYZER_VERSION,
  `typescript@${ts.version}:react-trial-v1`
);

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
    qualifiedName: `${canonicalPath}#${name}`,
    completeness,
    packageKey: input.packageKey,
    canonicalPath,
    identity,
    facets: Object.keys(facet).length ? { [ANALYZER_ID]: facet } : {},
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
  const canonicalEvidenceKey = `${input.path}:${node.getStart()}:react-ecosystem:${evidence}`;
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

function propertyName(node: ts.PropertyName): string {
  return node.getText().replace(/^['"]|['"]$/gu, "");
}

function objectProperty(object: ts.ObjectLiteralExpression | null | undefined, name: string): ts.Expression | null {
  if (!object) return null;
  const property = object.properties.find((item): item is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
    (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) && propertyName(item.name) === name
  );
  if (!property) return null;
  return ts.isPropertyAssignment(property) ? property.initializer : property.name;
}

function objectLiteral(value: ts.Expression | null | undefined): ts.ObjectLiteralExpression | null {
  return value && ts.isObjectLiteralExpression(value) ? value : null;
}

function objectKeys(value: ts.Expression | null): string[] {
  return objectLiteral(value)?.properties.flatMap((item) => item.name ? [propertyName(item.name)] : []).sort() ?? [];
}

function arrayLength(value: ts.Expression | null): number {
  return value && ts.isArrayLiteralExpression(value) ? value.elements.length : 0;
}

type NamedFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
type ImportBinding = {
  importedName: string;
  specifier: string;
  resolvedPath: string | null;
  node: ts.ImportDeclaration;
};

function functionName(node: NamedFunction): string | null {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return null;
}

function enclosingFunction(node: ts.Node): NamedFunction | null {
  let current = node.parent;
  while (current) {
    if ((ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current)) && functionName(current)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function walk(node: ts.Node, visit: (candidate: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function jsxTag(node: ts.JsxOpeningLikeElement): string | null {
  return ts.isIdentifier(node.tagName) ? node.tagName.text : null;
}

function jsxStringAttribute(node: ts.JsxOpeningLikeElement, name: string): string | null {
  const attribute = node.attributes.properties.find((item): item is ts.JsxAttribute =>
    ts.isJsxAttribute(item) && item.name.getText() === name
  );
  return attribute?.initializer && ts.isStringLiteral(attribute.initializer) ? attribute.initializer.text : null;
}

function templateText(node: ts.TaggedTemplateExpression): string | null {
  return ts.isNoSubstitutionTemplateLiteral(node.template) ? node.template.text : null;
}

export function analyzeReactEcosystemSource(inputValue: TypeScriptAnalyzerInput): FrontendAnalyzerOutput {
  const input = { ...inputValue, path: normalizeFrontendCanonicalPath(inputValue.path) };
  const source = ts.createSourceFile(input.path, input.content, ts.ScriptTarget.Latest, true, scriptKind(input.path));
  const entities = new Map<string, FrontendEntity>();
  const edges = new Map<string, FrontendEdge>();
  const imports = new Map<string, ImportBinding>();
  const functions = new Map<string, NamedFunction>();
  const components = new Map<string, FrontendEntity>();
  const validators = new Map<string, FrontendEntity>();
  const forms = new Map<string, FrontendEntity>();
  const guards = new Map<string, { entity: FrontendEntity; permissionKeys: Set<string> }>();

  source.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && node.importClause) {
      const specifier = node.moduleSpecifier.text;
      const resolved = input.resolutions.find((item) => item.specifier === specifier)?.resolvedPath ?? null;
      if (node.importClause.name) {
        imports.set(node.importClause.name.text, { importedName: "default", specifier, resolvedPath: resolved, node });
      }
      if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const item of node.importClause.namedBindings.elements) {
          imports.set(item.name.text, {
            importedName: item.propertyName?.text ?? item.name.text,
            specifier,
            resolvedPath: resolved,
            node
          });
        }
      }
      if (node.importClause.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) {
        imports.set(node.importClause.namedBindings.name.text, {
          importedName: "*",
          specifier,
          resolvedPath: resolved,
          node
        });
      }
    }
  });

  const importedBinding = (
    localName: string,
    specifier: (value: string) => boolean,
    importedNames: readonly string[]
  ): ImportBinding | null => {
    const binding = imports.get(localName);
    return binding && specifier(binding.specifier) && importedNames.includes(binding.importedName) ? binding : null;
  };
  const openApiClients = new Map<string, ImportBinding>();
  for (const [localName, binding] of imports) {
    if (/openapi/iu.test(binding.specifier)) openApiClients.set(localName, binding);
  }
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isCallExpression(declaration.initializer)
        || !ts.isIdentifier(declaration.initializer.expression)) continue;
      const factory = importedBinding(declaration.initializer.expression.text, (value) => /openapi/iu.test(value), ["default", "createClient"]);
      if (factory) openApiClients.set(declaration.name.text, factory);
    }
  }

  walk(source, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      functions.set(node.name.text, node.initializer);
    }
  });

  const ownerEntity = (node: ts.Node): FrontendEntity | null => {
    const ownerNode = enclosingFunction(node);
    const name = ownerNode ? functionName(ownerNode) : null;
    if (!ownerNode || !name) return null;
    const previous = components.get(name);
    if (previous) return previous;
    const kind = /^[A-Z]/u.test(name) ? "component" as const : /^use[A-Z\d_]/u.test(name) ? "hook_or_composable" as const : "symbol" as const;
    const attributes = kind === "component"
      ? { componentType: { state: "known" as const, value: "function" as const } }
      : kind === "hook_or_composable"
        ? { effectful: { state: "known" as const, value: true } }
        : { symbolKind: { state: "known" as const, value: "function" as const } };
    const entity = makeEntity(input, kind, input.path, name, `${kind}:${name}`, ownerNode, "complete", {}, attributes);
    entities.set(entity.id, entity);
    components.set(name, entity);
    return entity;
  };

  for (const node of source.statements) {
    if (!ts.isVariableStatement(node)) continue;
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (ts.isCallExpression(declaration.initializer) && ts.isPropertyAccessExpression(declaration.initializer.expression)
        && declaration.initializer.expression.name.text === "object"
        && ts.isIdentifier(declaration.initializer.expression.expression)
        && importedBinding(declaration.initializer.expression.expression.text, (value) => value === "zod", ["z", "*"])) {
        const shape = objectLiteral(declaration.initializer.arguments[0]);
        const validator = makeEntity(
          input,
          "data_schema",
          input.path,
          declaration.name.text,
          `validator:${declaration.name.text}`,
          declaration,
          shape ? "complete" : "partial",
          { role: "validator", library: "zod", fields: shape ? objectKeys(shape) : [] },
          { schemaKind: { state: "known", value: "zod" } }
        );
        entities.set(validator.id, validator);
        validators.set(declaration.name.text, validator);
      }
      if (ts.isTaggedTemplateExpression(declaration.initializer)
        && ts.isIdentifier(declaration.initializer.tag)
        && importedBinding(
          declaration.initializer.tag.text,
          (value) => value === "graphql-tag" || value === "@apollo/client" || value === "graphql-request",
          ["default", "gql"]
        )) {
        const document = templateText(declaration.initializer);
        const operation = document ? /\b(query|mutation|subscription)\s+([A-Za-z_]\w*)/u.exec(document) : null;
        if (operation) {
          const operationEntity = makeEntity(
            input,
            "api_operation",
            input.path,
            operation[2]!,
            `api:graphql:${operation[1]}:${operation[2]}`,
            declaration,
            "complete",
            { protocol: "graphql", operationType: operation[1], documentVariable: declaration.name.text },
            { method: { state: "known", value: "GRAPHQL" }, path: { state: "known", value: operation[2]! } }
          );
          entities.set(operationEntity.id, operationEntity);
        }
        if (document) {
          for (const match of document.matchAll(/\bfragment\s+([A-Za-z_]\w*)\s+on\s+([A-Za-z_]\w*)/gu)) {
            const schema = makeEntity(
              input,
              "data_schema",
              input.path,
              match[1]!,
              `schema:graphql-fragment:${match[1]}`,
              declaration,
              "complete",
              { protocol: "graphql", targetType: match[2] },
              { schemaKind: { state: "known", value: "graphql-fragment" } }
            );
            entities.set(schema.id, schema);
          }
        }
      }
    }
  }

  for (const [name, node] of functions) {
    let hasForm = false;
    let hasReactHookForm = false;
    let resolverName: string | null = null;
    const fields = new Map<string, ts.CallExpression>();
    walk(node, (candidate) => {
      if ((ts.isJsxOpeningElement(candidate) || ts.isJsxSelfClosingElement(candidate)) && jsxTag(candidate) === "form") hasForm = true;
      if (ts.isCallExpression(candidate) && ts.isIdentifier(candidate.expression)
        && importedBinding(candidate.expression.text, (value) => value === "react-hook-form", ["useForm"])) {
        hasReactHookForm = true;
        const options = objectLiteral(candidate.arguments[0]);
        const resolver = objectProperty(options, "resolver");
        if (resolver && ts.isCallExpression(resolver) && ts.isIdentifier(resolver.expression)
          && importedBinding(resolver.expression.text, (value) => value.startsWith("@hookform/resolvers/"), ["zodResolver"])
          && resolver.arguments[0] && ts.isIdentifier(resolver.arguments[0])) resolverName = resolver.arguments[0].text;
      }
      if (ts.isCallExpression(candidate) && candidate.expression.getText(source) === "register"
        && candidate.arguments[0] && ts.isStringLiteralLike(candidate.arguments[0])) {
        fields.set(candidate.arguments[0].text, candidate);
      }
    });
    if (!hasForm || !hasReactHookForm) continue;
    const form = makeEntity(input, "form", input.path, name, `form:${name}`, node, "partial", {
      library: "react-hook-form",
      submitHandler: true
    }, { method: { state: "known", value: "submit" }, action: { state: "unknown", reason: "dynamic" } });
    entities.set(form.id, form);
    forms.set(name, form);
    for (const [fieldName, fieldNode] of fields) {
      const field = makeEntity(input, "state_field", input.path, fieldName, `form-field:${name}:${fieldName}`, fieldNode, "partial", {
        role: "form-field", formName: name,
        registration: "react-hook-form"
      }, { fieldType: { state: "unknown", reason: "unresolved" } });
      entities.set(field.id, field);
      const relation = makeEdge(input, "contains", form.id, field.id, fieldNode, `form-field:${name}:${fieldName}`);
      edges.set(relation.id, relation);
    }
    const validator = resolverName ? validators.get(resolverName) : null;
    if (validator) {
      const relation = makeEdge(input, "validates", validator.id, form.id, node, `${validator.name}:${name}`);
      edges.set(relation.id, relation);
    }
  }

  for (const [name, node] of functions) {
    if (!/(?:Guard|ProtectedRoute)$/u.test(name)) continue;
    const guard = makeEntity(input, "component", input.path, name, `component:${name}`, node, "partial", {
      role: "permission-guard", guardType: name.endsWith("Route") ? "route" : "component", permissionKeys: []
    }, { componentType: { state: "known", value: "function" } });
    entities.set(guard.id, guard);
    guards.set(name, { entity: guard, permissionKeys: new Set() });
  }

  walk(source, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
    const tag = jsxTag(node);
    if (!tag) return;
    const guard = guards.get(tag);
    if (!guard) return;
    const key = jsxStringAttribute(node, "permission");
    if (key) guard.permissionKeys.add(key);
    const owner = enclosingFunction(node);
    const ownerName = owner ? functionName(owner) : null;
    const form = ownerName ? forms.get(ownerName) : null;
    if (form && key) {
      const relation = makeEdge(input, "guards", guard.entity.id, form.id, node, `${tag}:${ownerName}`);
      edges.set(relation.id, relation);
    }
  });
  for (const guard of guards.values()) {
    guard.entity.completeness = guard.permissionKeys.size > 0 ? "complete" : "partial";
    guard.entity.facets[ANALYZER_ID] = {
      role: "permission-guard",
      guardType: guard.entity.name.endsWith("Route") ? "route" : "component",
      permissionKeys: [...guard.permissionKeys].sort()
    };
  }

  walk(source, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer || !ts.isCallExpression(node.initializer)
      || !ts.isIdentifier(node.initializer.expression)
      || !importedBinding(node.initializer.expression.text, (value) => value === "react", ["forwardRef"])) return;
    const primitiveNames = new Set<string>();
    walk(node.initializer, (candidate) => {
      if ((ts.isJsxOpeningElement(candidate) || ts.isJsxSelfClosingElement(candidate))) {
        const tag = jsxTag(candidate);
        if (tag && imports.has(tag)) primitiveNames.add(tag);
      }
    });
    const primitiveName = [...primitiveNames].sort()[0];
    if (!primitiveName) return;
    const imported = imports.get(primitiveName)!;
    const primitivePath = imported.resolvedPath ? normalizeFrontendCanonicalPath(imported.resolvedPath) : input.path;
    const primitive = makeEntity(input, "component", primitivePath, primitiveName, `component:${primitiveName}`, imported.node, "partial", {
      package: imported.specifier
    }, { componentType: { state: "unknown", reason: "unresolved" } });
    const wrapper = makeEntity(input, "component", input.path, node.name.text, `component:${node.name.text}`, node, "complete", {
      encapsulation: "component-library-wrapper",
      primitive: primitiveName,
      package: imported.specifier
    }, { componentType: { state: "known", value: "function" } });
    entities.set(primitive.id, primitive);
    entities.set(wrapper.id, wrapper);
    components.set(wrapper.name, wrapper);
    const relation = makeEdge(input, "wraps", wrapper.id, primitive.id, node, `${wrapper.name}:${primitiveName}`);
    edges.set(relation.id, relation);
  });

  if (/\.stories\.[jt]sx?$/u.test(input.path)) {
    const variables = new Map<string, {
      node: ts.VariableDeclaration;
      value: ts.ObjectLiteralExpression;
      exportedNames: Set<string>;
    }>();
    let meta: ts.ObjectLiteralExpression | null = null;
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer)) {
            variables.set(declaration.name.text, {
              node: declaration,
              value: declaration.initializer,
              exportedNames: new Set(exported ? [declaration.name.text] : [])
            });
          }
        }
      }
      if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) meta = variables.get(statement.expression.text)?.value ?? null;
    }
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier
        || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        const localName = element.propertyName?.text ?? element.name.text;
        variables.get(localName)?.exportedNames.add(element.name.text);
      }
    }
    const componentValue = objectProperty(meta, "component");
    const componentName = componentValue && ts.isIdentifier(componentValue) ? componentValue.text : null;
    let component = componentName ? components.get(componentName) : null;
    const importedComponent = componentName ? imports.get(componentName) : null;
    if (!component && componentName && importedComponent?.resolvedPath) {
      component = makeEntity(
        input,
        "component",
        normalizeFrontendCanonicalPath(importedComponent.resolvedPath),
        componentName,
        `component:${componentName}`,
        importedComponent.node,
        "partial",
        {},
        { componentType: { state: "unknown", reason: "unresolved" } }
      );
      entities.set(component.id, component);
    }
    const metaDecorators = arrayLength(objectProperty(meta, "decorators"));
    if (component) {
      for (const record of variables.values()) {
        if (record.value === meta) continue;
        const storyKeys = new Set(["args", "decorators", "loaders", "parameters", "play", "render", "tags"]);
        const storyShaped = record.value.properties.some((property) => property.name && storyKeys.has(propertyName(property.name)));
        for (const exportedName of [...record.exportedNames].sort()) {
          const story = makeEntity(input, "test_fixture", input.path, exportedName, `component-story:${exportedName}`, record.node,
            storyShaped ? "complete" : "partial", {
            role: "component-story", storyShape: storyShaped ? "csf-object" : "unknown",
            args: objectKeys(objectProperty(record.value, "args")),
            decorators: arrayLength(objectProperty(record.value, "decorators")) + metaDecorators,
            component: component.name
          }, {
            fixtureKind: storyShaped
              ? { state: "known", value: "storybook-csf" }
              : { state: "unknown", reason: "unresolved" }
          });
          entities.set(story.id, story);
          if (storyShaped) {
            const relation = makeEdge(input, "documents", story.id, component.id, record.node, `${exportedName}:${component.name}`);
            edges.set(relation.id, relation);
          }
        }
      }
    }
  }

  walk(source, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const method = node.expression.name.text.toUpperCase();
    if (!new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).has(method)) return;
    const receiver = node.expression.expression;
    if (!ts.isIdentifier(receiver)) return;
    const imported = openApiClients.get(receiver.text);
    if (!imported) return;
    const endpoint = node.arguments[0];
    const endpointValue = endpoint && ts.isStringLiteralLike(endpoint) ? endpoint.text : null;
    const operation = makeEntity(input, "api_operation", input.path, `${method} ${endpointValue ?? "dynamic"}`,
      `api:openapi:${method}:${endpointValue ?? node.getStart()}`, node, endpointValue ? "complete" : "partial", {
        protocol: "openapi",
        generatedClient: true,
        clientModule: imported.specifier
      }, {
        method: { state: "known", value: method },
        path: endpointValue ? { state: "known", value: endpointValue } : { state: "unknown", reason: "dynamic" }
      });
    entities.set(operation.id, operation);
    const owner = ownerEntity(node);
    if (owner) {
      const relation = makeEdge(input, "requests", owner.id, operation.id, node, `${method}:${endpointValue ?? "dynamic"}`);
      edges.set(relation.id, relation);
    }
  });

  const deferredPackages = new Map<string, { name: string; packages: Set<string>; node: ts.ImportDeclaration }>();
  for (const imported of imports.values()) {
    const name = /(?:^|\/)i18next$|react-i18next/u.test(imported.specifier) ? "i18n"
      : /(?:axe-core|@axe-core\/react)/u.test(imported.specifier) ? "accessibility"
        : /(?:^|\/)@sentry\//u.test(imported.specifier) ? "error-monitoring"
          : imported.specifier === "web-vitals" ? "web-vitals"
            : null;
    if (!name) continue;
    const record = deferredPackages.get(name) ?? { name, packages: new Set<string>(), node: imported.node };
    record.packages.add(imported.specifier);
    deferredPackages.set(name, record);
  }
  for (const record of deferredPackages.values()) {
    const value = makeEntity(input, "tooling_config", input.path, record.name, `tooling:${record.name}`, record.node, "partial", {
      supportLevel: "basic-recognition",
      target: "V1.1",
      packages: [...record.packages].sort()
    }, { tool: { state: "known", value: record.name } });
    entities.set(value.id, value);
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
