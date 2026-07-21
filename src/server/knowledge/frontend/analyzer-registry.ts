import type { z } from "zod";

import {
  frontendAnalyzerManifestEntrySchema,
  frontendAnalyzerManifestDigest,
  frontendAnalyzerProvenanceSchema,
  frontendEdgeSchema,
  frontendEntitySchema,
  frontendFacetPatchSchema,
  frontendIrSchema,
  type FrontendAnalyzerManifestEntry,
  type FrontendAnalyzerProvenance,
  type FrontendEdge,
  type FrontendEntity,
  type FrontendFacetPatch,
  type FrontendIR
} from "../../../shared/frontend-ir.js";
import {
  createFrontendEdgeId,
  createFrontendEntityId,
  normalizeFrontendCanonicalPath,
  type FrontendAnalyzerOutput
} from "./analyzer.js";

export interface FrontendAnalyzerRegistration {
  id: string;
  version: string;
  role: "core" | "framework";
  facetSchema: z.ZodType<Record<string, unknown>>;
}

export interface FrontendMergeIssue {
  rule: "FRONTEND_CANONICAL_CONFLICT" | "FRONTEND_EDGE_CONFLICT" | "FRONTEND_FACET_CONFLICT" | "FRONTEND_FACET_TARGET_MISSING";
  severity: "error";
  targetId: string;
  message: string;
}

export type FrontendMergeResult =
  | { valid: true; ir: FrontendIR; lintIssues: [] }
  | { valid: false; ir: null; lintIssues: FrontendMergeIssue[] };

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

type SourceRefs = FrontendEntity["sourceRefs"];

function referenceKey(value: SourceRefs[number]): string {
  return stableJson(value);
}

function mergeReferences(left: SourceRefs, right: SourceRefs): SourceRefs {
  return [...new Map([...left, ...right].map((item) => [referenceKey(item), item])).values()]
    .sort((a, b) => referenceKey(a).localeCompare(referenceKey(b)));
}

function mergeProvenance(left: FrontendAnalyzerProvenance[], right: FrontendAnalyzerProvenance[]): FrontendAnalyzerProvenance[] {
  return [...new Map([...left, ...right].map((item) => [stableJson(item), item])).values()]
    .sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
}

function canonicalEntity(value: FrontendEntity): string {
  return stableJson({
    kind: value.kind,
    name: value.name,
    qualifiedName: value.qualifiedName,
    packageKey: value.packageKey,
    canonicalPath: value.canonicalPath,
    identity: value.identity,
    completeness: value.completeness,
    attributes: value.attributes
  });
}

function canonicalEdge(value: FrontendEdge): string {
  return stableJson({
    kind: value.kind,
    fromEntityId: value.fromEntityId,
    toEntityId: value.toEntityId,
    canonicalEvidenceKey: value.canonicalEvidenceKey,
    evidenceClass: value.evidenceClass,
    confidence: value.confidence,
    candidateReason: value.evidenceClass === "candidate" ? value.candidateReason : undefined
  });
}

function outputManifest(output: FrontendAnalyzerOutput): FrontendAnalyzerManifestEntry {
  return frontendAnalyzerManifestEntrySchema.parse({
    analyzerId: output.analyzerId,
    analyzerVersion: output.analyzerVersion,
    parserConfigDigest: output.parserConfigDigest,
    sourceBlobHashes: [...new Set(output.sourceBlobHashes)].sort()
  });
}

function outputProvenance(output: FrontendAnalyzerOutput): FrontendAnalyzerProvenance {
  return frontendAnalyzerProvenanceSchema.parse(outputManifest(output));
}

function normalizeEntity(value: FrontendEntity): FrontendEntity {
  return {
    ...value,
    facets: canonicalValue(value.facets) as FrontendEntity["facets"],
    sourceRefs: mergeReferences([], value.sourceRefs),
    provenance: mergeProvenance([], value.provenance)
  } as FrontendEntity;
}

function normalizeEdge(value: FrontendEdge): FrontendEdge {
  return {
    ...value,
    sourceRefs: mergeReferences([], value.sourceRefs),
    provenance: mergeProvenance([], value.provenance)
  } as FrontendEdge;
}

export class AnalyzerRegistry {
  readonly #registrations = new Map<string, FrontendAnalyzerRegistration>();

  register(registration: FrontendAnalyzerRegistration): void {
    if (this.#registrations.has(registration.id)) throw new Error(`Frontend analyzer already registered: ${registration.id}`);
    this.#registrations.set(registration.id, registration);
  }

  emptyIr(snapshotId: string): FrontendIR {
    const analyzerManifest: FrontendAnalyzerManifestEntry[] = [];
    return frontendIrSchema.parse({
      schemaVersion: 2,
      snapshotId,
      analyzerManifestDigest: frontendAnalyzerManifestDigest(analyzerManifest),
      analyzerManifest,
      entities: [],
      edges: []
    });
  }

  validateOutput(output: FrontendAnalyzerOutput): void {
    const registration = this.#registrations.get(output.analyzerId);
    if (!registration || registration.version !== output.analyzerVersion) {
      throw new Error(`Frontend analyzer is not registered at requested version: ${output.analyzerId}@${output.analyzerVersion}`);
    }
    const expectedProvenance = output.entities.length > 0 || output.edges.length > 0 || output.facetPatches.length > 0
      ? outputProvenance(output) : null;
    if (registration.role === "framework" && (output.entities.length > 0 || output.edges.length > 0)) {
      throw new Error(`Framework analyzer ${output.analyzerId} cannot create canonical entities or edges`);
    }
    if (registration.role === "core" && output.facetPatches.length > 0) {
      throw new Error(`Core analyzer ${output.analyzerId} cannot submit framework facet patches`);
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
      if (entity.provenance.length !== 1 || stableJson(entity.provenance[0]) !== stableJson(expectedProvenance)) {
        throw new Error(`Frontend entity ${entity.id} contains foreign analyzer provenance`);
      }
      const blobs = new Set(output.sourceBlobHashes);
      if (entity.sourceRefs.some((reference) => !blobs.has(reference.blobHash))) {
        throw new Error(`Frontend entity ${entity.id} references a blob absent from analyzer provenance`);
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
      if (edge.provenance.length !== 1 || stableJson(edge.provenance[0]) !== stableJson(expectedProvenance)) {
        throw new Error(`Frontend edge ${edge.id} contains foreign analyzer provenance`);
      }
      const blobs = new Set(output.sourceBlobHashes);
      if (edge.sourceRefs.some((reference) => !blobs.has(reference.blobHash))) {
        throw new Error(`Frontend edge ${edge.id} references a blob absent from analyzer provenance`);
      }
    }
    for (const raw of output.facetPatches) {
      const patch = frontendFacetPatchSchema.parse(raw);
      registration.facetSchema.parse(patch.facet);
      if (patch.sourceRefs.some((reference) => reference.snapshotId !== output.snapshotId)) {
        throw new Error(`Frontend facet patch ${patch.entityId} crosses snapshots`);
      }
      const blobs = new Set(output.sourceBlobHashes);
      if (patch.sourceRefs.some((reference) => !blobs.has(reference.blobHash))) {
        throw new Error(`Frontend facet patch ${patch.entityId} references a blob absent from analyzer provenance`);
      }
    }
  }

  mergeOutputs(outputs: FrontendAnalyzerOutput[]): FrontendMergeResult {
    if (outputs.length === 0) throw new Error("Frontend analyzer output list must not be empty");
    for (const output of outputs) this.validateOutput(output);
    const snapshotIds = new Set(outputs.map((output) => output.snapshotId));
    if (snapshotIds.size !== 1) throw new Error("Frontend analyzer outputs must belong to exactly one snapshot");
    const issues: FrontendMergeIssue[] = [];
    const entities = new Map<string, FrontendEntity>();
    const edges = new Map<string, FrontendEdge>();
    const ordered = [...outputs].sort((a, b) => stableJson(outputManifest(a)).localeCompare(stableJson(outputManifest(b))));
    for (const output of ordered.filter((item) => this.#registrations.get(item.analyzerId)?.role === "core")) {
      const registration = this.#registrations.get(output.analyzerId)!;
      for (const raw of output.entities) {
        const parsed = frontendEntitySchema.parse(raw);
        const ownFacet = parsed.facets[output.analyzerId];
        const entity = normalizeEntity({
          ...parsed,
          facets: ownFacet === undefined
            ? {}
            : { [output.analyzerId]: registration.facetSchema.parse(ownFacet) }
        });
        const previous = entities.get(entity.id);
        if (!previous) entities.set(entity.id, entity);
        else if (canonicalEntity(previous) !== canonicalEntity(entity)) {
          issues.push({ rule: "FRONTEND_CANONICAL_CONFLICT", severity: "error", targetId: entity.id, message: "Core analyzers disagree on canonical entity fields" });
        } else {
          for (const [namespace, facet] of Object.entries(entity.facets)) {
            const existingFacet = previous.facets[namespace];
            if (existingFacet !== undefined && stableJson(existingFacet) !== stableJson(facet)) {
              issues.push({ rule: "FRONTEND_FACET_CONFLICT", severity: "error", targetId: entity.id, message: "Core analyzer returned conflicting facet values" });
            }
          }
          entities.set(entity.id, {
            ...previous,
            facets: canonicalValue({ ...previous.facets, ...entity.facets }) as FrontendEntity["facets"],
            sourceRefs: mergeReferences(previous.sourceRefs, entity.sourceRefs),
            provenance: mergeProvenance(previous.provenance, entity.provenance)
          } as FrontendEntity);
        }
      }
      for (const raw of output.edges) {
        const edge = normalizeEdge(frontendEdgeSchema.parse(raw));
        const previous = edges.get(edge.id);
        if (!previous) edges.set(edge.id, edge);
        else if (canonicalEdge(previous) !== canonicalEdge(edge)) {
          issues.push({ rule: "FRONTEND_EDGE_CONFLICT", severity: "error", targetId: edge.id, message: "Core analyzers disagree on canonical edge fields" });
        } else {
          edges.set(edge.id, {
            ...previous,
            sourceRefs: mergeReferences(previous.sourceRefs, edge.sourceRefs),
            provenance: mergeProvenance(previous.provenance, edge.provenance)
          } as FrontendEdge);
        }
      }
    }
    for (const output of ordered.filter((item) => this.#registrations.get(item.analyzerId)?.role === "framework")) {
      if (output.facetPatches.length === 0) continue;
      const registration = this.#registrations.get(output.analyzerId)!;
      const provenance = outputProvenance(output);
      const patches = output.facetPatches.map((raw) => {
        const patch = frontendFacetPatchSchema.parse(raw);
        return { ...patch, facet: registration.facetSchema.parse(patch.facet) };
      }).sort((a, b) => `${a.entityId}:${stableJson(a.facet)}`.localeCompare(`${b.entityId}:${stableJson(b.facet)}`));
      for (const patch of patches) this.#applyFacetPatch(entities, output, provenance, patch, issues);
    }
    if (issues.length > 0) {
      return { valid: false, ir: null, lintIssues: issues.sort((a, b) => `${a.rule}:${a.targetId}`.localeCompare(`${b.rule}:${b.targetId}`)) };
    }
    const analyzerManifest = [...new Map(ordered.map((output) => {
      const manifest = outputManifest(output);
      return [stableJson(manifest), manifest];
    })).values()];
    const ir = frontendIrSchema.parse({
      schemaVersion: 2,
      snapshotId: [...snapshotIds][0],
      analyzerManifestDigest: frontendAnalyzerManifestDigest(analyzerManifest),
      analyzerManifest,
      entities: [...entities.values()].sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id))
    });
    return { valid: true, ir, lintIssues: [] };
  }

  #applyFacetPatch(
    entities: Map<string, FrontendEntity>,
    output: FrontendAnalyzerOutput,
    provenance: FrontendAnalyzerProvenance,
    patch: FrontendFacetPatch,
    issues: FrontendMergeIssue[]
  ): void {
    const entity = entities.get(patch.entityId);
    if (!entity) {
      issues.push({ rule: "FRONTEND_FACET_TARGET_MISSING", severity: "error", targetId: patch.entityId, message: "Framework facet target does not exist" });
      return;
    }
    const previous = entity.facets[output.analyzerId];
    if (previous !== undefined && stableJson(previous) !== stableJson(patch.facet)) {
      issues.push({ rule: "FRONTEND_FACET_CONFLICT", severity: "error", targetId: patch.entityId, message: "Framework analyzer returned conflicting facet values" });
      return;
    }
    entities.set(entity.id, {
      ...entity,
      facets: canonicalValue({ ...entity.facets, [output.analyzerId]: patch.facet }) as FrontendEntity["facets"],
      sourceRefs: mergeReferences(entity.sourceRefs, patch.sourceRefs),
      provenance: mergeProvenance(entity.provenance, [provenance])
    } as FrontendEntity);
  }
}
