import { createHash } from "node:crypto";

import type { z } from "zod";

import {
  frontendEdgeSchema,
  frontendEntitySchema,
  frontendIrSchema,
  type FrontendAnalyzerProvenance,
  type FrontendEdge,
  type FrontendEntity,
  type FrontendIR
} from "../../../shared/frontend-ir.js";
import { createFrontendEdgeId, createFrontendEntityId, normalizeFrontendCanonicalPath, type FrontendAnalyzerOutput } from "./analyzer.js";

export interface FrontendAnalyzerRegistration {
  id: string;
  version: string;
  facetSchema: z.ZodType;
}

export interface FrontendMergeIssue {
  rule: "FRONTEND_CANONICAL_CONFLICT" | "FRONTEND_EDGE_CONFLICT";
  severity: "error";
  targetId: string;
  message: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

function referenceKey(value: FrontendEntity["sourceRefs"][number]): string {
  return stableJson(value);
}

function mergeReferences(
  left: { sourceRefs: FrontendEntity["sourceRefs"] },
  right: { sourceRefs: FrontendEntity["sourceRefs"] }
): FrontendEntity["sourceRefs"] {
  return [...new Map([...left.sourceRefs, ...right.sourceRefs].map((item) => [referenceKey(item), item])).values()]
    .sort((a, b) => referenceKey(a).localeCompare(referenceKey(b)));
}

function mergeProvenance(left: FrontendAnalyzerProvenance[], right: FrontendAnalyzerProvenance[]): FrontendAnalyzerProvenance[] {
  return [...new Map([...left, ...right].map((item) => [stableJson(item), item])).values()]
    .sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
}

function normalizeEntity(value: FrontendEntity): FrontendEntity {
  return {
    ...value,
    facets: canonicalValue(value.facets) as FrontendEntity["facets"],
    sourceRefs: mergeReferences({ sourceRefs: [] }, value),
    provenance: mergeProvenance([], value.provenance)
  } as FrontendEntity;
}

function normalizeEdge(value: FrontendEdge): FrontendEdge {
  return {
    ...value,
    sourceRefs: mergeReferences({ sourceRefs: [] }, value),
    provenance: mergeProvenance([], value.provenance)
  } as FrontendEdge;
}

function canonicalEntity(value: FrontendEntity): string {
  return stableJson({
    kind: value.kind,
    completeness: value.completeness,
    packageKey: value.packageKey,
    canonicalPath: value.canonicalPath,
    semanticKey: value.semanticKey,
    attributes: value.attributes
  });
}

function canonicalEdge(value: FrontendEdge): string {
  const candidate = value.evidence === "candidate" ? { reason: value.reason } : {};
  return stableJson({
    kind: value.kind,
    fromEntityId: value.fromEntityId,
    toEntityId: value.toEntityId,
    evidence: value.evidence,
    confidence: value.confidence,
    ...candidate
  });
}

export class AnalyzerRegistry {
  readonly #registrations = new Map<string, FrontendAnalyzerRegistration>();

  register(registration: FrontendAnalyzerRegistration): void {
    if (this.#registrations.has(registration.id)) throw new Error(`Frontend analyzer already registered: ${registration.id}`);
    this.#registrations.set(registration.id, registration);
  }

  validateOutput(output: FrontendAnalyzerOutput): void {
    const registration = this.#registrations.get(output.analyzerId);
    if (!registration || registration.version !== output.analyzerVersion) {
      throw new Error(`Frontend analyzer is not registered at requested version: ${output.analyzerId}@${output.analyzerVersion}`);
    }
    if (new Set(output.entities.map((entity) => entity.id)).size !== output.entities.length) {
      throw new Error(`Frontend analyzer ${output.analyzerId} returned duplicate entity ids`);
    }
    if (new Set(output.edges.map((edge) => edge.id)).size !== output.edges.length) {
      throw new Error(`Frontend analyzer ${output.analyzerId} returned duplicate edge ids`);
    }
    for (const raw of output.entities) {
      const entity = frontendEntitySchema.parse(raw);
      if (entity.canonicalPath !== normalizeFrontendCanonicalPath(entity.canonicalPath)) {
        throw new Error(`Frontend entity ${entity.id} canonicalPath is not normalized`);
      }
      if (entity.id !== createFrontendEntityId(entity)) {
        throw new Error(`Frontend entity ${entity.id} does not match its stable identity fields`);
      }
      if (!entity.provenance.length || entity.provenance.some((item) => item.analyzerId !== output.analyzerId
        || item.analyzerVersion !== output.analyzerVersion)) {
        throw new Error(`Frontend entity ${entity.id} contains foreign analyzer provenance`);
      }
      if (!entity.provenance.some((item) => item.analyzerId === output.analyzerId && item.analyzerVersion === output.analyzerVersion)) {
        throw new Error(`Frontend entity ${entity.id} is missing analyzer provenance`);
      }
      const namespaces = Object.keys(entity.facets);
      if (namespaces.some((namespace) => namespace !== output.analyzerId)) {
        throw new Error(`Frontend entity ${entity.id} contains foreign facet namespace`);
      }
      if (output.analyzerId in entity.facets) registration.facetSchema.parse(entity.facets[output.analyzerId]);
    }
    for (const raw of output.edges) {
      const edge = frontendEdgeSchema.parse(raw);
      if (edge.id !== createFrontendEdgeId(edge)) throw new Error(`Frontend edge ${edge.id} does not match its stable identity fields`);
      if (edge.provenance.some((item) => item.analyzerId !== output.analyzerId || item.analyzerVersion !== output.analyzerVersion)) {
        throw new Error(`Frontend edge ${edge.id} contains foreign analyzer provenance`);
      }
    }
  }

  mergeOutputs(outputs: FrontendAnalyzerOutput[]): { ir: FrontendIR; lintIssues: FrontendMergeIssue[]; valid: boolean } {
    for (const output of outputs) this.validateOutput(output);
    const issues: FrontendMergeIssue[] = [];
    const entities = new Map<string, FrontendEntity>();
    const edges = new Map<string, FrontendEdge>();
    const ordered = [...outputs].sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
    for (const output of ordered) {
      for (const entity of output.entities) {
        const normalizedEntity = normalizeEntity(frontendEntitySchema.parse(entity));
        const previous = entities.get(normalizedEntity.id);
        if (!previous) {
          entities.set(normalizedEntity.id, normalizedEntity);
          continue;
        }
        if (canonicalEntity(previous) !== canonicalEntity(normalizedEntity)) {
          issues.push({ rule: "FRONTEND_CANONICAL_CONFLICT", severity: "error", targetId: normalizedEntity.id, message: "Analyzers disagree on canonical entity fields" });
          continue;
        }
        entities.set(normalizedEntity.id, {
          ...previous,
          facets: canonicalValue({ ...previous.facets, ...normalizedEntity.facets }) as FrontendEntity["facets"],
          sourceRefs: mergeReferences(previous, normalizedEntity),
          provenance: mergeProvenance(previous.provenance, normalizedEntity.provenance)
        } as FrontendEntity);
      }
      for (const edge of output.edges) {
        const normalizedEdge = normalizeEdge(frontendEdgeSchema.parse(edge));
        const previous = edges.get(normalizedEdge.id);
        if (!previous) {
          edges.set(normalizedEdge.id, normalizedEdge);
          continue;
        }
        if (canonicalEdge(previous) !== canonicalEdge(normalizedEdge)) {
          issues.push({ rule: "FRONTEND_EDGE_CONFLICT", severity: "error", targetId: normalizedEdge.id, message: "Analyzers disagree on canonical edge fields" });
          continue;
        }
        edges.set(normalizedEdge.id, {
          ...previous,
          sourceRefs: mergeReferences(previous, normalizedEdge),
          provenance: mergeProvenance(previous.provenance, normalizedEdge.provenance)
        } as FrontendEdge);
      }
    }
    const analyzerManifest = [...new Map(ordered.flatMap((output) => [...output.entities, ...output.edges])
      .flatMap((item) => item.provenance).map((item) => [stableJson(item), item])).values()]
      .sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
    const snapshotIds = new Set([...entities.values()].flatMap((entity) => entity.sourceRefs.map((reference) => reference.snapshotId)));
    if (snapshotIds.size !== 1) throw new Error("Frontend analyzer outputs must belong to exactly one snapshot");
    const ir = frontendIrSchema.parse({
      schemaVersion: 2,
      snapshotId: [...snapshotIds][0],
      analyzerManifestDigest: createHash("sha256").update(stableJson(analyzerManifest)).digest("hex"),
      entities: [...entities.values()].sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id))
    });
    return { ir, lintIssues: issues.sort((a, b) => `${a.rule}:${a.targetId}`.localeCompare(`${b.rule}:${b.targetId}`)), valid: issues.length === 0 };
  }
}
