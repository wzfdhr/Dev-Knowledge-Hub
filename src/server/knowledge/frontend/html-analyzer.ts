import path from "node:path";

import { parse, type DefaultTreeAdapterTypes, type ParserError } from "parse5";

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

const ANALYZER_ID = "html-core";
const ANALYZER_VERSION = "1.0.0";
const PARSER_CONFIG_DIGEST = frontendAnalyzerConfigDigest(ANALYZER_ID, ANALYZER_VERSION, "parse5@8.0.1:locations");
const landmarkRoles: Record<string, string> = {
  header: "banner",
  nav: "navigation",
  main: "main",
  aside: "complementary",
  footer: "contentinfo",
  section: "region"
};

type HtmlNode = DefaultTreeAdapterTypes.Node;
type HtmlElement = DefaultTreeAdapterTypes.Element;

function isElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node && typeof node.tagName === "string";
}

function attribute(element: HtmlElement, name: string): string | null {
  return element.attrs.find((item) => item.name === name)?.value ?? null;
}

function offsets(input: FrontendAnalyzerSourceInput, node: HtmlNode): [number, number] {
  const location = node.sourceCodeLocation;
  return location ? [location.startOffset, location.endOffset] : [0, input.content.length];
}

function htmlEntity(
  input: FrontendAnalyzerSourceInput,
  kind: "page" | "dom_landmark" | "form",
  name: string,
  semanticKey: string,
  node: HtmlNode,
  completeness: "complete" | "partial",
  facet: Record<string, unknown>,
  attributes: FrontendEntity["attributes"]
): FrontendEntity {
  const identity = namedFrontendIdentity(semanticKey);
  const [start, end] = offsets(input, node);
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

function containsEdge(input: FrontendAnalyzerSourceInput, pageId: string, entity: FrontendEntity, ordinal: number): FrontendEdge {
  const base = {
    kind: "contains" as const,
    fromEntityId: pageId,
    toEntityId: entity.id,
    canonicalEvidenceKey: `${input.path}:contains:${ordinal}:${entity.identity.type === "named" ? entity.identity.semanticKey : entity.id}`
  };
  return {
    schemaVersion: 2,
    id: createFrontendEdgeId(base),
    ...base,
    evidenceClass: "fact",
    confidence: 1,
    sourceRefs: entity.sourceRefs,
    provenance: frontendAnalyzerProvenance(input, ANALYZER_ID, ANALYZER_VERSION, PARSER_CONFIG_DIGEST)
  };
}

function formControls(form: HtmlElement): Array<Record<string, unknown>> {
  const controls: Array<Record<string, unknown>> = [];
  const visit = (node: HtmlNode): void => {
    if (isElement(node) && ["input", "select", "textarea", "button"].includes(node.tagName)) {
      controls.push({
        tagName: node.tagName,
        name: attribute(node, "name"),
        type: attribute(node, "type"),
        required: node.attrs.some((item) => item.name === "required")
      });
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  for (const child of form.childNodes) visit(child);
  return controls;
}

export function analyzeHtmlSource(inputValue: FrontendAnalyzerSourceInput): FrontendAnalyzerOutput {
  const input = { ...inputValue, path: normalizeFrontendCanonicalPath(inputValue.path) };
  const errors: ParserError[] = [];
  const document = parse(input.content, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => errors.push(error)
  });
  const page = htmlEntity(
    input,
    "page",
    path.posix.basename(input.path),
    "html-document",
    document,
    errors.length === 0 ? "complete" : "partial",
    { language: "html", parseErrors: errors.map((error) => error.code).sort() },
    { routePath: { state: "unknown", reason: "unresolved" } }
  );
  const entities: FrontendEntity[] = [page];
  const edges: FrontendEdge[] = [];
  let ordinal = 0;
  const visit = (node: HtmlNode): void => {
    if (isElement(node)) {
      if (node.tagName in landmarkRoles) {
        const role = attribute(node, "role") ?? landmarkRoles[node.tagName]!;
        const entity = htmlEntity(
          input,
          "dom_landmark",
          node.tagName,
          `landmark:${node.tagName}:${ordinal}`,
          node,
          errors.length === 0 ? "complete" : "partial",
          {
            tagName: node.tagName,
            role,
            ariaLabel: attribute(node, "aria-label"),
            id: attribute(node, "id")
          },
          { tagName: { state: "known", value: node.tagName }, role: { state: "known", value: role } }
        );
        entities.push(entity);
        edges.push(containsEdge(input, page.id, entity, ordinal));
        ordinal += 1;
      }
      if (node.tagName === "form") {
        const method = (attribute(node, "method") ?? "get").toLowerCase();
        const action = attribute(node, "action");
        const entity = htmlEntity(
          input,
          "form",
          attribute(node, "name") ?? attribute(node, "id") ?? `form-${ordinal + 1}`,
          `form:${ordinal}`,
          node,
          errors.length === 0 && action !== null ? "complete" : "partial",
          { method, action, controls: formControls(node) },
          {
            method: { state: "known", value: method },
            action: action === null
              ? { state: "unknown", reason: "unresolved" }
              : { state: "known", value: action }
          }
        );
        entities.push(entity);
        edges.push(containsEdge(input, page.id, entity, ordinal));
        ordinal += 1;
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  visit(document);

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
