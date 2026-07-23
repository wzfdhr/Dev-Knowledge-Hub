import { createHash } from "node:crypto";

import { z } from "zod";

import { sourceRefSchema, type ArtifactManifest } from "../../../shared/api-contracts.js";
import type { FrontendProjectProfile } from "../../../shared/frontend-project-profile.js";
import type { FrontendIR } from "../../../shared/frontend-ir.js";
import type {
  ExperienceSourceEligibility,
  ObservedPatternEvidenceInput
} from "../../../shared/frontend-experience.js";
import type { AppStore, RepositoryRecord, SourceSnapshotRecord } from "../../persistence/store.js";
import { sourceProvenanceForSnapshot } from "../../source-provenance.js";
import { frontendPipelinePackageSchema } from "./compatibility.js";
import type { frontendGraphV2Schema } from "./compatibility.js";
import type { FrontendExperienceCapability } from "./search-intent.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const observedPatternCandidateSchema = z.object({
  candidateId: digestSchema,
  groupKey: digestSchema,
  capability: z.enum([
    "chart_drilldown", "form_validation", "state_data_flow", "component_styling", "frontend_testing"
  ]),
  evidenceType: z.literal("observed_fact"),
  frameworkFamily: z.string().min(1),
  relationKinds: z.array(z.string().min(1)).min(1),
  staticFacetKeys: z.array(z.string().min(1)),
  observedFact: z.string().min(1),
  sourceRefs: z.array(sourceRefSchema).min(1)
}).strict();

export const frontendPatternCandidatesSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: z.string().min(1),
  analyzerManifestDigest: digestSchema,
  profileDigest: digestSchema,
  candidates: z.array(observedPatternCandidateSchema)
}).strict().superRefine((value, context) => {
  if (value.candidates.some((candidate) =>
    candidate.sourceRefs.some((reference) => reference.snapshotId !== value.snapshotId)
  )) context.addIssue({ code: "custom", message: "Frontend pattern candidates cross snapshots" });
});

export type ObservedPatternCandidate = z.infer<typeof observedPatternCandidateSchema>;
export type FrontendPatternCandidates = z.infer<typeof frontendPatternCandidatesSchema>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function candidateGroupKey(input: Pick<
  ObservedPatternCandidate,
  "capability" | "frameworkFamily" | "relationKinds" | "staticFacetKeys"
>): string {
  return createHash("sha256").update(stableJson({
    capability: input.capability,
    framework: input.frameworkFamily,
    relations: [...new Set(input.relationKinds)].sort(),
    facets: [...new Set(input.staticFacetKeys)].sort()
  }), "utf8").digest("hex");
}

function capabilityForRelation(kind: string): FrontendExperienceCapability | null {
  if (kind === "visualizes") return "chart_drilldown";
  if (kind === "tests") return "frontend_testing";
  if (kind === "styles" || kind === "uses_token") return "component_styling";
  if (["requests", "invalidates", "subscribes", "reads_state", "writes_state"].includes(kind)) {
    return "state_data_flow";
  }
  if (kind === "validates" || kind === "guards") return "form_validation";
  return null;
}

function uniqueSourceRefs(references: ObservedPatternCandidate["sourceRefs"]) {
  return [...new Map(references.map((reference) => [
    `${reference.snapshotId}\0${reference.path}\0${reference.startLine}\0${reference.endLine}\0${reference.blobHash}`,
    reference
  ])).values()].sort((left, right) =>
    `${left.path}\0${left.startLine}\0${left.endLine}`.localeCompare(`${right.path}\0${right.startLine}\0${right.endLine}`)
  );
}

export function extractObservedPatterns(input: {
  profile: FrontendProjectProfile;
  graph: z.infer<typeof frontendGraphV2Schema>;
  ir: FrontendIR;
}): FrontendPatternCandidates {
  if (input.profile.snapshotId !== input.graph.snapshotId
    || input.ir.snapshotId !== input.graph.snapshotId
    || input.profile.analyzerManifestDigest !== input.graph.analyzerManifestDigest) {
    throw new Error("Frontend pattern inputs do not share provenance");
  }
  const frameworkFamily = input.profile.framework.state === "known"
    || input.profile.framework.state === "unsupported"
    ? input.profile.framework.value?.name ?? "unknown"
    : "unknown";
  const nodes = new Map(input.ir.entities.map((entity) => [entity.id, entity]));
  const grouped = new Map<FrontendExperienceCapability, {
    relationKinds: Set<string>;
    staticFacetKeys: Set<string>;
    sourceRefs: ObservedPatternCandidate["sourceRefs"];
  }>();
  for (const edge of input.graph.edges) {
    if (edge.evidenceClass !== "fact" || edge.sourceRefs.length === 0) continue;
    const capability = capabilityForRelation(edge.kind);
    if (!capability) continue;
    const group = grouped.get(capability) ?? {
      relationKinds: new Set<string>(),
      staticFacetKeys: new Set<string>(),
      sourceRefs: []
    };
    group.relationKinds.add(edge.kind);
    for (const entityId of [edge.fromEntityId, edge.toEntityId]) {
      const entity = nodes.get(entityId);
      for (const [namespace, facets] of Object.entries(entity?.facets ?? {})) {
        for (const key of Object.keys(facets).sort()) group.staticFacetKeys.add(`${namespace}.${key}`);
      }
    }
    group.sourceRefs.push(...edge.sourceRefs);
    grouped.set(capability, group);
  }
  const candidates = [...grouped.entries()].map(([capability, facts]) => {
    const relationKinds = [...facts.relationKinds].sort();
    const staticFacetKeys = [...facts.staticFacetKeys].sort();
    const groupKey = candidateGroupKey({ capability, frameworkFamily, relationKinds, staticFacetKeys });
    return observedPatternCandidateSchema.parse({
      candidateId: createHash("sha256").update(`${input.graph.snapshotId}:${groupKey}`).digest("hex"),
      groupKey,
      capability,
      evidenceType: "observed_fact",
      frameworkFamily,
      relationKinds,
      staticFacetKeys,
      observedFact: `Observed cited ${relationKinds.join(" + ")} implementation relation`,
      sourceRefs: uniqueSourceRefs(facts.sourceRefs)
    });
  }).sort((left, right) => left.groupKey.localeCompare(right.groupKey));
  return frontendPatternCandidatesSchema.parse({
    schemaVersion: 1,
    snapshotId: input.graph.snapshotId,
    analyzerManifestDigest: input.graph.analyzerManifestDigest,
    profileDigest: input.profile.profileDigest,
    candidates
  });
}

function digestUuid(value: string): string {
  const hex = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function sourceEligibility(
  snapshot: SourceSnapshotRecord,
  repository: RepositoryRecord
): { eligibility: ExperienceSourceEligibility; contentVersion: string } | null {
  const provenance = sourceProvenanceForSnapshot(snapshot, repository);
  if (provenance.kind === "git") return { eligibility: "git", contentVersion: provenance.contentVersion };
  if (provenance.attestation === "git_linked") {
    return { eligibility: "git_linked", contentVersion: provenance.contentVersion };
  }
  if (provenance.attestation === "admin_attested") {
    return { eligibility: "admin_attested", contentVersion: provenance.contentVersion };
  }
  return null;
}

type PublishedPatternStore = Pick<AppStore,
  "getRelease" | "getRepository" | "findSnapshotById" | "findArtifactById" | "saveObservedPatternEvidence"
>;

export async function indexPublishedFrontendPatternEvidence(input: {
  store: PublishedPatternStore;
  reader: { getJson(manifest: ArtifactManifest): Promise<unknown> };
  workspaceId: string;
  releaseId: string;
}): Promise<{ indexed: number; reason?: "RELEASE_NOT_ELIGIBLE" | "SOURCE_NOT_ELIGIBLE" }> {
  const release = await input.store.getRelease(input.workspaceId, input.releaseId);
  if (!release || release.publishedAt === null || release.releaseArtifactFamily !== "frontend-v2"
    || !release.packageArtifactId) return { indexed: 0, reason: "RELEASE_NOT_ELIGIBLE" };
  const repository = await input.store.getRepository(input.workspaceId, release.repositoryId);
  const snapshot = await input.store.findSnapshotById(input.workspaceId, release.snapshotId);
  if (!repository || !snapshot) return { indexed: 0, reason: "RELEASE_NOT_ELIGIBLE" };
  const eligibility = sourceEligibility(snapshot, repository);
  if (!eligibility) return { indexed: 0, reason: "SOURCE_NOT_ELIGIBLE" };
  const packageManifest = await input.store.findArtifactById(release.packageArtifactId);
  if (!packageManifest || packageManifest.kind !== "frontend-pipeline-package"
    || packageManifest.schemaVersion !== 2 || packageManifest.snapshotId !== release.snapshotId) {
    throw new Error("Published frontend package artifact is unavailable");
  }
  const packageValue = frontendPipelinePackageSchema.parse(await input.reader.getJson(packageManifest));
  const candidateManifest = await input.store.findArtifactById(packageValue.patternCandidatesArtifactId);
  if (!candidateManifest || candidateManifest.kind !== "frontend-pattern-candidates"
    || candidateManifest.schemaVersion !== 1 || candidateManifest.snapshotId !== release.snapshotId) {
    throw new Error("Published frontend pattern candidate artifact is unavailable");
  }
  const artifact = frontendPatternCandidatesSchema.parse(await input.reader.getJson(candidateManifest));
  if (artifact.snapshotId !== release.snapshotId || artifact.profileDigest !== packageValue.projectProfileDigest) {
    throw new Error("Published frontend pattern candidates do not match release provenance");
  }
  for (const candidate of artifact.candidates) {
    const evidence: ObservedPatternEvidenceInput = {
      id: digestUuid(`evidence:${release.id}:${candidate.candidateId}`),
      workspaceId: input.workspaceId,
      patternGroupId: digestUuid(`group:${candidate.groupKey}`),
      projectId: repository.projectId,
      releaseId: release.id,
      snapshotId: release.snapshotId,
      capability: candidate.capability,
      sourceEligibility: eligibility.eligibility,
      title: `Observed ${candidate.capability.replaceAll("_", " ")} implementation`,
      observedFact: candidate.observedFact,
      profileDigest: artifact.profileDigest,
      contentVersion: eligibility.contentVersion,
      citations: candidate.sourceRefs
    };
    await input.store.saveObservedPatternEvidence(evidence);
  }
  return { indexed: artifact.candidates.length };
}
