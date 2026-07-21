import { createRequire } from "node:module";
import path from "node:path";

import postcss, { type AtRule, type ChildNode, type Root, type Rule } from "postcss";
import selectorParser from "postcss-selector-parser";
import scssSyntax from "postcss-scss";

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

const require = createRequire(import.meta.url);
const lessSyntax = require("postcss-less") as { parse(content: string, options?: { from?: string }): Root };

const ANALYZER_ID = "style-core";
const ANALYZER_VERSION = "1.0.0";
const PARSER_CONFIG_DIGEST = frontendAnalyzerConfigDigest(
  ANALYZER_ID,
  ANALYZER_VERSION,
  "postcss@8.5.19:selector@7.1.4:scss@4.0.9:less@6.0.0:token-links-v2"
);

function parseStyle(input: FrontendAnalyzerSourceInput): Root {
  const extension = path.posix.extname(input.path).toLowerCase();
  if (extension === ".scss") return scssSyntax.parse(input.content, { from: input.path });
  if (extension === ".less") return lessSyntax.parse(input.content, { from: input.path });
  return postcss.parse(input.content, { from: input.path });
}

function nodeOffsets(input: FrontendAnalyzerSourceInput, node: ChildNode | Root): [number, number] {
  const start = node.source?.start?.offset ?? 0;
  const end = node.source?.end?.offset;
  return [start, end === undefined ? input.content.length : Math.min(input.content.length, end + 1)];
}

function styleEntity(
  input: FrontendAnalyzerSourceInput,
  kind: "style_scope" | "style_token",
  name: string,
  semanticKey: string,
  node: ChildNode | Root,
  completeness: "complete" | "partial",
  facet: Record<string, unknown>,
  attributes: FrontendEntity["attributes"]
): FrontendEntity {
  const identity = namedFrontendIdentity(semanticKey);
  const [start, end] = nodeOffsets(input, node);
  return {
    schemaVersion: 2,
    id: createFrontendEntityId({ kind, packageKey: input.packageKey, canonicalPath: input.path, identity }),
    kind,
    name,
    qualifiedName: `${input.path}#${semanticKey}`,
    completeness,
    packageKey: input.packageKey,
    canonicalPath: input.path,
    identity,
    facets: { [ANALYZER_ID]: facet },
    attributes,
    sourceRefs: [frontendSourceRef(input, start, end)],
    provenance: frontendAnalyzerProvenance(input, ANALYZER_ID, ANALYZER_VERSION, PARSER_CONFIG_DIGEST)
  } as FrontendEntity;
}

function selectorFacts(selector: string): { classes: string[]; ids: string[]; pseudos: string[] } {
  const classes = new Set<string>();
  const ids = new Set<string>();
  const pseudos = new Set<string>();
  selectorParser((root) => {
    root.walkClasses((node) => { classes.add(node.value); });
    root.walkIds((node) => { ids.add(node.value); });
    root.walkPseudos((node) => { pseudos.add(node.value); });
  }).processSync(selector, { lossless: true });
  return { classes: [...classes].sort(), ids: [...ids].sort(), pseudos: [...pseudos].sort() };
}

function scopeKind(input: FrontendAnalyzerSourceInput) {
  return input.path.includes(".module.") ? "module" as const : "global" as const;
}

function containsEdge(
  input: FrontendAnalyzerSourceInput,
  fromEntityId: string,
  toEntityId: string,
  node: ChildNode,
  ordinal: number
): FrontendEdge {
  const base = {
    kind: "contains" as const,
    fromEntityId,
    toEntityId,
    canonicalEvidenceKey: `${input.path}:${node.source?.start?.offset ?? 0}:token:${ordinal}`
  };
  const [start, end] = nodeOffsets(input, node);
  return {
    schemaVersion: 2,
    id: createFrontendEdgeId(base),
    ...base,
    evidenceClass: "fact",
    confidence: 1,
    sourceRefs: [frontendSourceRef(input, start, end)],
    provenance: frontendAnalyzerProvenance(input, ANALYZER_ID, ANALYZER_VERSION, PARSER_CONFIG_DIGEST)
  };
}

function usesTokenEdge(
  input: FrontendAnalyzerSourceInput,
  fromEntityId: string,
  toEntityId: string,
  node: ChildNode,
  tokenName: string
): FrontendEdge {
  const base = {
    kind: "uses_token" as const,
    fromEntityId,
    toEntityId,
    canonicalEvidenceKey: `${input.path}:${node.source?.start?.offset ?? 0}:uses-token:${tokenName}`
  };
  const [start, end] = nodeOffsets(input, node);
  return {
    schemaVersion: 2,
    id: createFrontendEdgeId(base),
    ...base,
    evidenceClass: "fact",
    confidence: 1,
    sourceRefs: [frontendSourceRef(input, start, end)],
    provenance: frontendAnalyzerProvenance(input, ANALYZER_ID, ANALYZER_VERSION, PARSER_CONFIG_DIGEST)
  };
}

function partialStyleOutput(
  input: FrontendAnalyzerSourceInput,
  reason: "parse-error" | "unsupported-indented-sass"
): FrontendAnalyzerOutput {
  const scope = styleEntity(
    input,
    "style_scope",
    path.posix.basename(input.path),
    `stylesheet:${reason}`,
    { type: "root" } as Root,
    "partial",
    {
      parseError: reason === "parse-error",
      unsupportedSyntax: reason === "unsupported-indented-sass" ? "indented-sass" : null,
      module: input.path.includes(".module.")
    },
    { scopeKind: { state: "known", value: scopeKind(input) } }
  );
  return {
    snapshotId: input.snapshotId,
    analyzerId: ANALYZER_ID,
    analyzerVersion: ANALYZER_VERSION,
    parserConfigDigest: PARSER_CONFIG_DIGEST,
    sourceBlobHashes: [input.blobHash],
    entities: [scope],
    edges: [],
    facetPatches: []
  };
}

export function analyzeStyleSource(inputValue: FrontendAnalyzerSourceInput): FrontendAnalyzerOutput {
  const input = { ...inputValue, path: normalizeFrontendCanonicalPath(inputValue.path) };
  if (path.posix.extname(input.path).toLowerCase() === ".sass") {
    return partialStyleOutput(input, "unsupported-indented-sass");
  }
  let root: Root;
  try {
    root = parseStyle(input);
  } catch {
    return partialStyleOutput(input, "parse-error");
  }

  const entities: FrontendEntity[] = [];
  const edges: FrontendEdge[] = [];
  let ordinal = 0;
  const scopeByNode = new Map<object, FrontendEntity>();
  const tokensByName = new Map<string, FrontendEntity>();

  root.walkRules((rule: Rule) => {
    let facts: ReturnType<typeof selectorFacts>;
    try {
      facts = selectorFacts(rule.selector);
    } catch {
      facts = { classes: [], ids: [], pseudos: [] };
    }
    const utilities: string[] = [];
    rule.walkAtRules("apply", (atRule) => { utilities.push(...atRule.params.split(/\s+/).filter(Boolean)); });
    const entity = styleEntity(
      input,
      "style_scope",
      rule.selector,
      `selector:${ordinal}:${rule.selector}`,
      rule,
      facts.classes.length + facts.ids.length + facts.pseudos.length > 0 ? "complete" : "partial",
      {
        selector: rule.selector,
        ...facts,
        module: input.path.includes(".module."),
        utilityDirectives: [...new Set(utilities)].sort()
      },
      { scopeKind: { state: "known", value: scopeKind(input) } }
    );
    ordinal += 1;
    entities.push(entity);
    scopeByNode.set(rule, entity);
  });

  root.walkAtRules((atRule: AtRule) => {
    const lowerName = atRule.name.toLowerCase();
    const isLessVariable = path.posix.extname(input.path).toLowerCase() === ".less"
      && atRule.raws.afterName?.includes(":") && !["media", "container", "supports", "layer"].includes(lowerName);
    if (isLessVariable) {
      const token = styleEntity(
        input,
        "style_token",
        `@${atRule.name}`,
        `token:@${atRule.name}:${ordinal}`,
        atRule,
        "complete",
        { tokenKind: "less-variable" },
        { tokenValue: { state: "known", value: atRule.params.trim() } }
      );
      ordinal += 1;
      entities.push(token);
      tokensByName.set(token.name, token);
      return;
    }
    if (["media", "container"].includes(lowerName)) {
      const entity = styleEntity(
        input,
        "style_scope",
        `@${lowerName} ${atRule.params}`,
        `at-rule:${ordinal}:${lowerName}:${atRule.params}`,
        atRule,
        "complete",
        { atRule: lowerName, condition: atRule.params.trim(), module: input.path.includes(".module.") },
        { scopeKind: { state: "known", value: scopeKind(input) } }
      );
      ordinal += 1;
      entities.push(entity);
      scopeByNode.set(atRule, entity);
    }
  });

  root.walkDecls((declaration) => {
    const tokenName = declaration.prop.startsWith("--") || declaration.prop.startsWith("$")
      ? declaration.prop
      : null;
    if (!tokenName) return;
    const token = styleEntity(
      input,
      "style_token",
      tokenName,
      `token:${tokenName}:${ordinal}`,
      declaration,
      "complete",
      { tokenKind: tokenName.startsWith("--") ? "custom-property" : "scss-variable" },
      { tokenValue: { state: "known", value: declaration.value.trim() } }
    );
    ordinal += 1;
    entities.push(token);
    tokensByName.set(token.name, token);
    let parent: object | undefined = declaration.parent ?? undefined;
    while (parent && !scopeByNode.has(parent)) {
      parent = "parent" in parent && typeof parent.parent === "object" && parent.parent
        ? parent.parent
        : undefined;
    }
    const scope = parent ? scopeByNode.get(parent) : undefined;
    if (scope) edges.push(containsEdge(input, scope.id, token.id, declaration, ordinal));
  });

  root.walkRules((rule) => {
    const scope = scopeByNode.get(rule);
    if (!scope) return;
    const used = new Set<string>();
    rule.walkDecls((declaration) => {
      for (const match of declaration.value.matchAll(/var\(\s*(--[\w-]+)/gu)) used.add(match[1]!);
    });
    for (const tokenName of [...used].sort()) {
      const token = tokensByName.get(tokenName);
      if (token) edges.push(usesTokenEdge(input, scope.id, token.id, rule, tokenName));
    }
  });

  return {
    snapshotId: input.snapshotId,
    analyzerId: ANALYZER_ID,
    analyzerVersion: ANALYZER_VERSION,
    parserConfigDigest: PARSER_CONFIG_DIGEST,
    sourceBlobHashes: [input.blobHash],
    entities,
    edges,
    facetPatches: []
  };
}
