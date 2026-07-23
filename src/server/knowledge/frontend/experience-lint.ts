import { createHash } from "node:crypto";

import type {
  ExperienceReviewItem,
  ExperienceReviewItemInput,
  ExperienceState,
  ProjectPredicate
} from "../../../shared/frontend-experience.js";
import type { SourceRef } from "../../../shared/api-contracts.js";

export const FRONTEND_EXPERIENCE_LINT_RULES = [
  "EXPERIENCE_CITATION_MISSING",
  "EXPERIENCE_BASIS_REVOKED",
  "EXPERIENCE_CONDITION_CONFLICT",
  "EXPERIENCE_EVIDENCE_STALE",
  "EXPERIENCE_OUTCOME_VERSION_MISMATCH",
  "EXPERIENCE_SIGNED_OUTCOME_FAILED",
  "EXPERIENCE_DEPRECATED_RECOMMENDATION",
  "EXPERIENCE_SUPERSESSION_CYCLE"
] as const;

export type FrontendExperienceLintRule = (typeof FRONTEND_EXPERIENCE_LINT_RULES)[number];

export interface ExperienceLintRecord {
  id: string;
  state: ExperienceState;
  supersededById: string | null;
  evidence: Array<{
    id: string;
    contentVersion: string;
    citations: SourceRef[];
    revokedAt: Date | null;
    fresh: boolean;
  }>;
  decisions: Array<{
    id: string;
    decision: "approve" | "reject" | "deprecate" | "standardize";
    basisEvidenceIds: string[];
    applicability: {
      required: ProjectPredicate[];
      forbidden: ProjectPredicate[];
      preferred: ProjectPredicate[];
      unsupportedWhenUnknown: string[];
    };
  }>;
  outcomes: Array<{
    id: string;
    evidenceId: string | null;
    sourceVersion: string;
    authority: "signed_ci" | "admin_confirmed" | "user_reported";
    outcome: "passed" | "failed" | "rolled_back" | "partial";
  }>;
}

export interface FrontendExperienceLintDiagnostic {
  id: string;
  rule: FrontendExperienceLintRule;
  severity: "error" | "warning";
  patternGroupId: string;
  evidenceId: string | null;
  message: string;
}

interface ExperienceLintStore {
  listExperienceLintRecords(workspaceId: string): Promise<ExperienceLintRecord[]>;
  createExperienceReviewItem(input: ExperienceReviewItemInput): Promise<ExperienceReviewItem>;
}

function fingerprint(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function stableUuid(parts: readonly string[]): string {
  const value = fingerprint(parts).slice(0, 32).split("");
  value[12] = "5";
  value[16] = ((Number.parseInt(value[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sameCondition(left: ProjectPredicate, right: ProjectPredicate): boolean {
  return left.key === right.key && left.value.toLocaleLowerCase() === right.value.toLocaleLowerCase()
    && (left.operator === right.operator
      || [left.operator, right.operator].every((operator) => operator === "equals" || operator === "includes"));
}

function diagnostic(input: Omit<FrontendExperienceLintDiagnostic, "id">): FrontendExperienceLintDiagnostic {
  return {
    ...input,
    id: fingerprint([
      input.rule, input.patternGroupId, input.evidenceId ?? "", input.message
    ])
  };
}

export function lintFrontendExperiences(
  records: readonly ExperienceLintRecord[]
): FrontendExperienceLintDiagnostic[] {
  const result: FrontendExperienceLintDiagnostic[] = [];
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const record of records) {
    const evidenceById = new Map(record.evidence.map((item) => [item.id, item]));
    for (const evidence of record.evidence) {
      if (evidence.citations.length === 0) result.push(diagnostic({
        rule: "EXPERIENCE_CITATION_MISSING", severity: "error",
        patternGroupId: record.id, evidenceId: evidence.id,
        message: "Observed experience evidence has no source citation"
      }));
      if (!evidence.fresh) result.push(diagnostic({
        rule: "EXPERIENCE_EVIDENCE_STALE", severity: "warning",
        patternGroupId: record.id, evidenceId: evidence.id,
        message: "Experience evidence is older than the latest source snapshot"
      }));
    }
    for (const decision of record.decisions) {
      const invalidBasis = decision.basisEvidenceIds.find((id) => {
        const evidence = evidenceById.get(id);
        return !evidence || evidence.revokedAt !== null;
      });
      if (invalidBasis) result.push(diagnostic({
        rule: "EXPERIENCE_BASIS_REVOKED", severity: "error",
        patternGroupId: record.id, evidenceId: evidenceById.has(invalidBasis) ? invalidBasis : null,
        message: `Decision ${decision.id} references missing or revoked evidence ${invalidBasis}`
      }));
      const conflict = decision.applicability.required.find((required) =>
        decision.applicability.forbidden.some((forbidden) => sameCondition(required, forbidden))
      );
      if (conflict) result.push(diagnostic({
        rule: "EXPERIENCE_CONDITION_CONFLICT", severity: "error",
        patternGroupId: record.id, evidenceId: decision.basisEvidenceIds[0] ?? null,
        message: `Applicability both requires and forbids ${conflict.key}=${conflict.value}`
      }));
    }
    for (const outcome of record.outcomes) {
      const evidence = outcome.evidenceId ? evidenceById.get(outcome.evidenceId) : undefined;
      if (evidence && evidence.contentVersion !== outcome.sourceVersion) result.push(diagnostic({
        rule: "EXPERIENCE_OUTCOME_VERSION_MISMATCH", severity: "error",
        patternGroupId: record.id, evidenceId: evidence.id,
        message: `Outcome ${outcome.id} targets ${outcome.sourceVersion}, not ${evidence.contentVersion}`
      }));
      if (outcome.authority === "signed_ci" && ["failed", "rolled_back"].includes(outcome.outcome)) {
        result.push(diagnostic({
          rule: "EXPERIENCE_SIGNED_OUTCOME_FAILED", severity: "error",
          patternGroupId: record.id, evidenceId: outcome.evidenceId,
          message: `Signed CI outcome ${outcome.id} reported ${outcome.outcome}`
        }));
      }
    }
    if ((["recommended", "standard"] as ExperienceState[]).includes(record.state)
      && record.supersededById !== null
      || record.state === "deprecated" && record.decisions.some((item) =>
        item.decision === "approve" || item.decision === "standardize"
      )) result.push(diagnostic({
      rule: "EXPERIENCE_DEPRECATED_RECOMMENDATION", severity: "error",
      patternGroupId: record.id, evidenceId: record.evidence[0]?.id ?? null,
      message: "A deprecated or superseded experience still carries an active recommendation basis"
    }));

    const visited = new Set<string>([record.id]);
    let cursor = record.supersededById;
    while (cursor) {
      if (visited.has(cursor)) {
        result.push(diagnostic({
          rule: "EXPERIENCE_SUPERSESSION_CYCLE", severity: "error",
          patternGroupId: record.id, evidenceId: record.evidence[0]?.id ?? null,
          message: `Supersession chain for ${record.id} contains a cycle at ${cursor}`
        }));
        break;
      }
      visited.add(cursor);
      cursor = byId.get(cursor)?.supersededById ?? null;
    }
  }
  return result.sort((left, right) => left.patternGroupId.localeCompare(right.patternGroupId)
    || left.rule.localeCompare(right.rule) || left.id.localeCompare(right.id));
}

export async function runFrontendExperienceLint(
  store: ExperienceLintStore,
  input: { workspaceId: string; actorId: string }
): Promise<{ schemaVersion: 1; diagnostics: FrontendExperienceLintDiagnostic[]; reviewItemIds: string[] }> {
  const records = await store.listExperienceLintRecords(input.workspaceId);
  const diagnostics = lintFrontendExperiences(records);
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const reviewItemIds: string[] = [];
  for (const item of diagnostics.filter((candidate) => candidate.severity === "error")) {
    const record = recordsById.get(item.patternGroupId);
    if (!record) continue;
    const evidence = item.evidenceId
      ? record.evidence.find((candidate) => candidate.id === item.evidenceId)
      : record.evidence[0];
    const id = stableUuid([input.workspaceId, item.id, "frontend-experience-lint@1"]);
    const review = await store.createExperienceReviewItem({
      id, workspaceId: input.workspaceId, patternGroupId: item.patternGroupId,
      evidenceId: evidence?.id ?? null, outcomeId: null, reportedBy: input.actorId,
      kind: "knowledge_lint", priority: "high", feedbackEvent: null, currentProjectId: null,
      sourceVersion: evidence?.contentVersion ?? "frontend-experience-lint@1",
      taskSummary: `${item.rule}: ${item.message}`
    });
    reviewItemIds.push(review.id);
  }
  return { schemaVersion: 1, diagnostics, reviewItemIds };
}
