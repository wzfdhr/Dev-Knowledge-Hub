import { z } from "zod";

import { sourceRefSchema } from "./api-contracts.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u, "Expected a SHA-256 digest");
const unknownReasonSchema = z.enum(["dynamic", "unresolved", "limit", "unsupported"]);
const canonicalPathSchema = z.string().min(1).superRefine((value, context) => {
  const segments = value.split("/");
  if (value.startsWith("/") || value.includes("\\") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    context.addIssue({ code: "custom", message: "canonicalPath must be a normalized relative path" });
  }
});

function knownOrUnknown<T extends z.ZodType>(valueSchema: T) {
  return z.discriminatedUnion("status", [
    z.object({ status: z.literal("known"), value: valueSchema }),
    z.object({ status: z.literal("unknown"), reason: unknownReasonSchema })
  ]);
}

export const frontendAnalyzerProvenanceSchema = z.object({
  analyzerId: z.string().min(1),
  analyzerVersion: z.string().min(1),
  configDigest: digestSchema
});

const commonEntityFields = {
  schemaVersion: z.literal(2),
  id: digestSchema,
  completeness: z.enum(["complete", "partial"]),
  packageKey: z.string().min(1),
  canonicalPath: canonicalPathSchema,
  semanticKey: z.string().min(1),
  facets: z.record(z.string().min(1), z.record(z.string(), z.unknown())),
  sourceRefs: z.array(sourceRefSchema).min(1),
  provenance: z.array(frontendAnalyzerProvenanceSchema).min(1)
};

export const frontendEntitySchema = z.discriminatedUnion("kind", [
  z.object({ ...commonEntityFields, kind: z.literal("package"), attributes: z.object({ name: knownOrUnknown(z.string().min(1)), workspace: knownOrUnknown(z.boolean()) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("module"), attributes: z.object({ name: knownOrUnknown(z.string().min(1)), moduleFormat: knownOrUnknown(z.enum(["esm", "commonjs", "mixed", "script"])) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("component"), attributes: z.object({ name: knownOrUnknown(z.string().min(1)), componentType: knownOrUnknown(z.enum(["function", "class", "unknown"])) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("route"), attributes: z.object({ path: knownOrUnknown(z.string()), routeType: knownOrUnknown(z.enum(["page", "layout", "api", "redirect"])) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("state"), attributes: z.object({ name: knownOrUnknown(z.string().min(1)), scope: knownOrUnknown(z.enum(["local", "context", "global", "server"])) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("data-source"), attributes: z.object({ name: knownOrUnknown(z.string().min(1)), transport: knownOrUnknown(z.enum(["fetch", "axios", "graphql", "websocket", "sse", "other"])) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("style"), attributes: z.object({ name: knownOrUnknown(z.string().min(1)), styleKind: knownOrUnknown(z.enum(["css", "css-module", "sass", "less", "css-in-js", "utility"])) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("visualization"), attributes: z.object({ name: knownOrUnknown(z.string().min(1)), library: knownOrUnknown(z.string().min(1)) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("test"), attributes: z.object({ name: knownOrUnknown(z.string().min(1)), testKind: knownOrUnknown(z.enum(["unit", "component", "integration", "e2e"])) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("config"), attributes: z.object({ name: knownOrUnknown(z.string().min(1)), configKind: knownOrUnknown(z.string().min(1)) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("document"), attributes: z.object({ title: knownOrUnknown(z.string().min(1)) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("asset"), attributes: z.object({ path: knownOrUnknown(z.string().min(1)), assetType: knownOrUnknown(z.enum(["image", "font", "media", "svg"])) }) })
]);

const commonEdgeFields = {
  schemaVersion: z.literal(2),
  id: digestSchema,
  kind: z.enum(["contains", "imports", "exports", "renders", "routes-to", "reads", "writes", "calls", "styles", "visualizes", "tests", "depends-on"]),
  fromEntityId: digestSchema,
  toEntityId: digestSchema,
  provenance: z.array(frontendAnalyzerProvenanceSchema).min(1)
};

export const frontendEdgeSchema = z.discriminatedUnion("evidence", [
  z.object({ ...commonEdgeFields, evidence: z.literal("fact"), confidence: z.literal(1), sourceRefs: z.array(sourceRefSchema).min(1) }),
  z.object({ ...commonEdgeFields, evidence: z.literal("candidate"), reason: z.string().min(1).max(240), confidence: z.number().positive().lt(1), sourceRefs: z.array(sourceRefSchema) })
]);

export const frontendIrSchema = z.object({
  schemaVersion: z.literal(2),
  snapshotId: z.string().min(1),
  analyzerManifestDigest: digestSchema,
  entities: z.array(frontendEntitySchema),
  edges: z.array(frontendEdgeSchema)
}).superRefine((value, context) => {
  for (const [field, items] of [["entity", value.entities], ["edge", value.edges]] as const) {
    const ids = items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: `duplicate ${field} id` });
    if (ids.some((id, index) => index > 0 && ids[index - 1]! > id)) context.addIssue({ code: "custom", message: `${field} ids must be sorted` });
  }
  const entityIds = new Set(value.entities.map((entity) => entity.id));
  if ([...value.entities, ...value.edges].some((item) => item.sourceRefs.some((reference) => reference.snapshotId !== value.snapshotId))) {
    context.addIssue({ code: "custom", message: "Frontend IR references must belong to the same snapshot" });
  }
  if (value.edges.some((edge) => !entityIds.has(edge.fromEntityId) || !entityIds.has(edge.toEntityId))) {
    context.addIssue({ code: "custom", message: "Frontend IR edge has a missing endpoint" });
  }
});

export type FrontendAnalyzerProvenance = z.infer<typeof frontendAnalyzerProvenanceSchema>;
export type FrontendEntity = z.infer<typeof frontendEntitySchema>;
export type FrontendEdge = z.infer<typeof frontendEdgeSchema>;
export type FrontendIR = z.infer<typeof frontendIrSchema>;
