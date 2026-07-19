import { frontendSourceReferenceIsValid, type FrontendSourceDescriptors } from "./reference-validation.js";

interface Ref { snapshotId: string; path: string; startLine: number; endLine: number; blobHash: string }
interface Entity { id: string; kind: string; canonicalPath: string; name: string; sourceRefs: Ref[] }
interface Edge { id: string; kind: string; fromEntityId: string; toEntityId: string; evidenceClass: "fact" | "candidate"; sourceRefs: Ref[] }

export function compareFrontendKnowledge(input: {
  legacy: { entityKeys: string[]; factKeys: string[]; pageKeys: string[]; searchKeys: string[]; impactPaths: string[]; suggestedTestPaths: string[]; issueCount: number };
  candidate: { snapshotId: string; entities: Entity[]; edges: Edge[]; pageKeys: string[]; searchKeys: string[]; impactPaths: string[]; suggestedTestPaths: string[]; issueCount: number; pageRefs: Ref[]; searchRefs: Ref[]; issueRefs: Ref[]; sources: FrontendSourceDescriptors };
}) {
  const factEdges = input.candidate.edges.filter((edge) => edge.evidenceClass === "fact");
  const references = [
    ...input.candidate.entities.flatMap((entity) => entity.sourceRefs),
    ...factEdges.flatMap((edge) => edge.sourceRefs),
    ...input.candidate.pageRefs, ...input.candidate.searchRefs, ...input.candidate.issueRefs
  ];
  const invalid = references.filter((reference) => !frontendSourceReferenceIsValid(
    reference, input.candidate.snapshotId, input.candidate.sources
  ))
    .map((reference) => `${reference.path}:${reference.startLine}-${reference.endLine}`);
  return {
    legacy: {
      entities: input.legacy.entityKeys.length, factRelations: input.legacy.factKeys.length,
      pages: input.legacy.pageKeys.length, searchDocuments: input.legacy.searchKeys.length,
      impactPaths: input.legacy.impactPaths.length, issues: input.legacy.issueCount
    },
    candidate: {
      entities: input.candidate.entities.length, factRelations: factEdges.length,
      candidateRelations: input.candidate.edges.length - factEdges.length,
      pages: input.candidate.pageKeys.length, searchDocuments: input.candidate.searchKeys.length,
      impactPaths: input.candidate.impactPaths.length, issues: input.candidate.issueCount
    },
    candidateEntityKeys: input.candidate.entities.map((entity) => `${entity.kind}:${entity.canonicalPath}:${entity.name}`).sort(),
    candidateFactKeys: factEdges.map((edge) => `${edge.kind}:${edge.fromEntityId}->${edge.toEntityId}`).sort(),
    impact: {
      legacyPaths: [...input.legacy.impactPaths].sort(),
      candidatePaths: [...input.candidate.impactPaths].sort(),
      legacySuggestedTests: [...input.legacy.suggestedTestPaths].sort(),
      candidateSuggestedTests: [...input.candidate.suggestedTestPaths].sort()
    },
    citations: { valid: invalid.length === 0, checked: references.length, invalid }
  };
}
