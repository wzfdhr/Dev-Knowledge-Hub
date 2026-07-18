import { z } from "zod";

import { sourceRefSchema } from "./api-contracts.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u, "Expected a SHA-256 digest");
const unknownReasonSchema = z.enum(["dynamic", "unresolved", "limit", "unsupported", "unsupported_version"]);
const canonicalPathSchema = z.string().min(1).superRefine((value, context) => {
  const segments = value.split("/");
  if (value.startsWith("/") || value.includes("\\") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    context.addIssue({ code: "custom", message: "canonicalPath must be a normalized relative path" });
  }
});

function knowledgeValue<T extends z.ZodType>(valueSchema: T) {
  return z.discriminatedUnion("state", [
    z.object({ state: z.literal("known"), value: valueSchema }).strict(),
    z.object({ state: z.literal("unknown"), reason: unknownReasonSchema }).strict()
  ]);
}

export const frontendEntityIdentitySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("named"), semanticKey: z.string().min(1) }).strict(),
  z.object({
    type: z.literal("anonymous"),
    enclosingSemanticKey: z.string().min(1),
    astOrdinal: z.number().int().nonnegative()
  }).strict()
]);

export const frontendAnalyzerProvenanceSchema = z.object({
  analyzerId: z.string().min(1),
  analyzerVersion: z.string().min(1),
  parserConfigDigest: digestSchema,
  sourceBlobHashes: z.array(digestSchema).min(1).transform((items) => [...new Set(items)].sort())
}).strict();

const commonEntityFields = {
  schemaVersion: z.literal(2),
  id: digestSchema,
  name: z.string().min(1),
  qualifiedName: z.string().min(1),
  completeness: z.enum(["complete", "partial"]),
  packageKey: z.string().min(1),
  canonicalPath: canonicalPathSchema,
  identity: frontendEntityIdentitySchema,
  facets: z.record(z.string().min(1), z.record(z.string(), z.unknown())),
  sourceRefs: z.array(sourceRefSchema).min(1),
  provenance: z.array(frontendAnalyzerProvenanceSchema).min(1)
};

export const frontendEntitySchema = z.discriminatedUnion("kind", [
  z.object({ ...commonEntityFields, kind: z.literal("workspace_package"), attributes: z.object({ packageManager: knowledgeValue(z.enum(["npm", "pnpm", "yarn", "bun", "unknown"])), version: knowledgeValue(z.string().min(1)) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("application_entry"), attributes: z.object({ runtime: knowledgeValue(z.enum(["spa", "ssr", "ssg", "worker", "server", "client"])) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("route"), attributes: z.object({ path: knowledgeValue(z.string()), dynamic: knowledgeValue(z.boolean()) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("layout"), attributes: z.object({ nestingDepth: knowledgeValue(z.number().int().nonnegative()) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("page"), attributes: z.object({ routePath: knowledgeValue(z.string()) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("component"), attributes: z.object({ componentType: knowledgeValue(z.enum(["function", "class", "unknown"])) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("hook_or_composable"), attributes: z.object({ effectful: knowledgeValue(z.boolean()) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("state_store"), attributes: z.object({ library: knowledgeValue(z.string().min(1)) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("state_field"), attributes: z.object({ fieldType: knowledgeValue(z.string().min(1)) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("api_operation"), attributes: z.object({ method: knowledgeValue(z.string().min(1)), path: knowledgeValue(z.string().min(1)) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("data_schema"), attributes: z.object({ schemaKind: knowledgeValue(z.string().min(1)) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("style_token"), attributes: z.object({ tokenValue: knowledgeValue(z.string()) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("style_scope"), attributes: z.object({ scopeKind: knowledgeValue(z.enum(["global", "module", "scoped", "utility", "css-in-js"])) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("visualization"), attributes: z.object({ library: knowledgeValue(z.string().min(1)) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("test_case"), attributes: z.object({ testKind: knowledgeValue(z.enum(["unit", "component", "integration", "e2e"])) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("test_fixture"), attributes: z.object({ fixtureKind: knowledgeValue(z.string().min(1)) }) }),
  z.object({ ...commonEntityFields, kind: z.literal("tooling_config"), attributes: z.object({ tool: knowledgeValue(z.string().min(1)) }) })
]);

const commonEdgeFields = {
  schemaVersion: z.literal(2),
  id: digestSchema,
  kind: z.enum(["contains", "imports", "exports", "renders", "routes_to", "lazy_loads", "provides", "injects", "reads_state", "writes_state", "requests", "subscribes", "styles", "visualizes", "tests", "configures", "depends_on"]),
  fromEntityId: digestSchema,
  toEntityId: digestSchema,
  canonicalEvidenceKey: z.string().min(1),
  provenance: z.array(frontendAnalyzerProvenanceSchema).min(1)
};

export const frontendEdgeSchema = z.discriminatedUnion("evidenceClass", [
  z.object({ ...commonEdgeFields, evidenceClass: z.literal("fact"), confidence: z.literal(1), sourceRefs: z.array(sourceRefSchema).min(1) }),
  z.object({ ...commonEdgeFields, evidenceClass: z.literal("candidate"), candidateReason: z.string().min(1).max(240), confidence: z.number().min(0).max(1), sourceRefs: z.array(sourceRefSchema) })
]);

export const frontendAnalyzerManifestEntrySchema = z.object({
  analyzerId: z.string().min(1),
  analyzerVersion: z.string().min(1),
  parserConfigDigest: digestSchema,
  sourceBlobHashes: z.array(digestSchema)
}).strict();

export const frontendIrSchema = z.object({
  schemaVersion: z.literal(2),
  snapshotId: z.string().min(1),
  analyzerManifestDigest: digestSchema,
  analyzerManifest: z.array(frontendAnalyzerManifestEntrySchema),
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

export type FrontendEntityIdentity = z.infer<typeof frontendEntityIdentitySchema>;
export type FrontendAnalyzerProvenance = z.infer<typeof frontendAnalyzerProvenanceSchema>;
export type FrontendAnalyzerManifestEntry = z.infer<typeof frontendAnalyzerManifestEntrySchema>;
export type FrontendEntity = z.infer<typeof frontendEntitySchema>;
export type FrontendEdge = z.infer<typeof frontendEdgeSchema>;
export type FrontendIR = z.infer<typeof frontendIrSchema>;
