import { z } from "zod";

import { BUILD_JOB_STATUSES, BUILD_STAGES } from "./contracts.js";

const digestSchema = z.string().regex(/^[a-f0-9]{40,64}$/i, "Expected a content digest");
const isoTimestampSchema = z.string().datetime({ offset: true });

export const buildStageSchema = z.enum(BUILD_STAGES);
export const stageStatusSchema = z.enum([
  "queued", "running", "succeeded", "failed", "cancelled", "reused", "skipped"
]);
export const legacyBuildStatusSchema = z.enum(BUILD_JOB_STATUSES);
export const sourceKindSchema = z.enum(["code", "document", "config", "table"]);

export const sourceRefSchema = z.object({
  snapshotId: z.string().min(1),
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  startColumn: z.number().int().positive().optional(),
  endColumn: z.number().int().positive().optional(),
  blobHash: digestSchema
}).superRefine((value, context) => {
  if (value.endLine < value.startLine) context.addIssue({ code: "custom", message: "endLine must not precede startLine" });
  if (value.startColumn !== undefined && value.endColumn !== undefined && value.endLine === value.startLine && value.endColumn < value.startColumn) {
    context.addIssue({ code: "custom", message: "endColumn must not precede startColumn on one line" });
  }
});

export const artifactManifestSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  snapshotId: z.string().min(1),
  buildId: z.string().min(1),
  stage: buildStageSchema,
  kind: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  inputDigest: digestSchema,
  contentDigest: digestSchema,
  storageKey: z.string().min(1),
  sourceRefs: z.array(sourceRefSchema),
  producer: z.enum(["deterministic", "llm"]),
  createdAt: isoTimestampSchema
});

export const stageRunSchema = z.object({
  id: z.string().min(1),
  buildId: z.string().min(1),
  stage: buildStageSchema,
  attempt: z.number().int().positive(),
  status: stageStatusSchema,
  inputDigest: digestSchema,
  outputManifestIds: z.array(z.string().min(1)),
  startedAt: isoTimestampSchema.nullable(),
  finishedAt: isoTimestampSchema.nullable(),
  errorCode: z.string().min(1).nullable(),
  errorDetail: z.string().min(1).max(4_000).nullable()
}).superRefine((value, context) => {
  const terminal = ["succeeded", "failed", "cancelled", "reused", "skipped"].includes(value.status);
  if (value.status === "queued" && (value.startedAt !== null || value.finishedAt !== null)) context.addIssue({ code: "custom", message: "queued runs have no timestamps" });
  if (value.status === "running" && (value.startedAt === null || value.finishedAt !== null)) context.addIssue({ code: "custom", message: "running runs require only startedAt" });
  if (terminal && (value.startedAt === null || value.finishedAt === null)) context.addIssue({ code: "custom", message: "terminal runs require timestamps" });
  if (value.status === "failed" && value.errorCode === null) context.addIssue({ code: "custom", message: "failed runs require errorCode" });
  if (value.status !== "failed" && (value.errorCode !== null || value.errorDetail !== null)) context.addIssue({ code: "custom", message: "only failed runs contain error details" });
});

export const pipelineStageEventSchema = z.object({
  sequence: z.number().int().positive(),
  buildId: z.string().min(1),
  stageRunId: z.string().min(1),
  stage: buildStageSchema,
  status: stageStatusSchema,
  occurredAt: isoTimestampSchema
});

export const tableColumnSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["string", "number", "boolean", "date", "unknown"]),
  nullable: z.boolean(),
  sensitive: z.boolean(),
  formulaLike: z.boolean(),
  sourceRefs: z.array(sourceRefSchema)
});

export const tableSchemaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sourcePath: z.string().min(1),
  sheet: z.string().min(1).optional(),
  columns: z.array(tableColumnSchema),
  rowCount: z.number().int().nonnegative(),
  candidate: z.boolean(),
  sourceRefs: z.array(sourceRefSchema)
});

export const knowledgeIrSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: z.string().min(1),
  files: z.array(z.object({ path: z.string().min(1), language: z.string().min(1), contentDigest: digestSchema, lineCount: z.number().int().positive(), sourceRef: sourceRefSchema })),
  symbols: z.array(z.object({ id: z.string().min(1), kind: z.enum(["module", "function", "class", "interface", "type", "component", "command"]), name: z.string().min(1), qualifiedName: z.string().min(1), signature: z.string().nullable(), sourceRef: sourceRefSchema })),
  imports: z.array(z.object({ fromPath: z.string().min(1), specifier: z.string().min(1), kind: z.enum(["static", "dynamic"]), sourceRef: sourceRefSchema })),
  documents: z.array(z.object({ id: z.string().min(1), title: z.string().nullable(), text: z.string(), sourceRef: sourceRefSchema })),
  tables: z.array(tableSchemaSchema),
  sourceRefs: z.array(sourceRefSchema)
});

export const graphNodeSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  snapshotId: z.string().min(1),
  kind: z.enum(["module", "symbol", "document", "table", "column", "command"]),
  name: z.string().min(1),
  qualifiedName: z.string().min(1),
  candidate: z.boolean(),
  sourceRefs: z.array(sourceRefSchema),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
});

export const graphEdgeSchema = z.object({
  id: z.string().min(1),
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  kind: z.enum(["imports", "exports", "calls", "contains", "documents", "reads", "writes", "depends_on"]),
  candidate: z.boolean(),
  candidateReason: z.string().min(1).max(240).optional(),
  confidence: z.number().min(0).max(1),
  sourceRefs: z.array(sourceRefSchema)
}).superRefine((value, context) => {
  if (value.candidate && !value.candidateReason) {
    context.addIssue({ code: "custom", message: "candidate GraphEdge requires candidateReason" });
  }
  if (!value.candidate && value.candidateReason) {
    context.addIssue({ code: "custom", message: "fact GraphEdge cannot have candidateReason" });
  }
});

export const lintIssueSchema = z.object({
  id: z.string().min(1),
  buildId: z.string().min(1),
  rule: z.string().min(1),
  severity: z.enum(["error", "warning", "info"]),
  targetKind: z.enum(["citation", "knowledge", "graph", "table", "search"]),
  targetId: z.string().min(1),
  message: z.string().min(1),
  sourceRefs: z.array(sourceRefSchema),
  remediationState: z.enum(["open", "accepted", "rebuilding", "resolved", "dismissed"])
});

export const trustScoreSchema = z.object({
  targetKind: z.enum(["knowledge", "graph_edge", "table", "search_result"]),
  targetId: z.string().min(1),
  score: z.number().min(0).max(1),
  citationScore: z.number().min(0).max(1),
  parserScore: z.number().min(0).max(1),
  freshnessScore: z.number().min(0).max(1),
  lintPenalty: z.number().min(0).max(1),
  reasons: z.array(z.string().min(1)).max(20)
});

export const releaseArtifactFamilySchema = z.enum(["knowledge-v1", "frontend-v2"]);
export const frontendReleaseProvenanceSchema = z.object({
  releaseArtifactFamily: z.literal("frontend-v2"),
  packageArtifactId: z.string().min(1),
  packageStageRunId: z.string().min(1),
  frontendIrSchemaVersion: z.literal(2),
  frontendGraphSchemaVersion: z.literal(2),
  analyzerManifestDigest: digestSchema
}).strict();

export type BuildStage = z.infer<typeof buildStageSchema>;
export type StageStatus = z.infer<typeof stageStatusSchema>;
export type LegacyBuildStatus = z.infer<typeof legacyBuildStatusSchema>;
export type SourceKind = z.infer<typeof sourceKindSchema>;
export type SourceRef = z.infer<typeof sourceRefSchema>;
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
export type StageRun = z.infer<typeof stageRunSchema>;
export type PipelineStageEvent = z.infer<typeof pipelineStageEventSchema>;
export type KnowledgeIR = z.infer<typeof knowledgeIrSchema>;
export type TableSchema = z.infer<typeof tableSchemaSchema>;
export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphEdge = z.infer<typeof graphEdgeSchema>;
export type LintIssue = z.infer<typeof lintIssueSchema>;
export type TrustScore = z.infer<typeof trustScoreSchema>;
export type ReleaseArtifactFamily = z.infer<typeof releaseArtifactFamilySchema>;
export type FrontendReleaseProvenance = z.infer<typeof frontendReleaseProvenanceSchema>;

export type {
  FrontendAnalyzerProvenance,
  FrontendAnalyzerManifestEntry,
  FrontendEdge,
  FrontendEntity,
  FrontendEntityIdentity,
  FrontendFacetPatch,
  FrontendIR
} from "./frontend-ir.js";
