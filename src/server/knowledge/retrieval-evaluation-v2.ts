import type { Citation } from "./intelligence.js";

export const retrievalEvaluationCategories = [
  "symbol",
  "path",
  "command",
  "natural-language",
  "table",
  "cross-project",
  "error-feedback",
  "no-result"
] as const;

export type RetrievalEvaluationCategory = typeof retrievalEvaluationCategories[number];
export type RetrievalEvaluationSource = "fixture" | "admin-approved-sanitized-feedback";

export interface RetrievalEvaluationCase {
  id: string;
  query: string;
  project: string;
  expectedTitles: string[];
  expectedPaths: string[];
  expectEmpty: boolean;
  category: RetrievalEvaluationCategory;
  source: RetrievalEvaluationSource;
  approvalId?: string;
  sanitizedAt?: string;
}

export interface EvaluationSearchResult {
  title: string;
  citations: Citation[];
}

export interface RetrievalEvaluationMetrics {
  total: number;
  evaluated: number;
  emptyCases: number;
  recallAt5: number;
  mrr: number;
  citationValidity: number;
  falsePositiveEmptyRate: number;
}

export interface RetrievalEvaluationFailure {
  id: string;
  category: RetrievalEvaluationCategory;
  kind: "expected-result-missing" | "unexpected-empty-result" | "invalid-citation";
}

export interface RetrievalEvaluationReport {
  metrics: RetrievalEvaluationMetrics;
  failures: RetrievalEvaluationFailure[];
}

export const retrievalQualityThresholds = Object.freeze({
  recallAt5: 0.9,
  mrr: 0.75,
  citationValidity: 1,
  falsePositiveEmptyRate: 0.05
});

function stringArray(value: unknown, field: string, id: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Retrieval evaluation case ${id} has invalid ${field}`);
  }
  return value.map((item) => item.trim());
}

function record(value: unknown, line: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Retrieval evaluation line ${line} must be an object`);
  }
  return value as Record<string, unknown>;
}

function category(value: unknown, id: string): RetrievalEvaluationCategory {
  if (typeof value !== "string" || !retrievalEvaluationCategories.includes(value as RetrievalEvaluationCategory)) {
    throw new Error(`Retrieval evaluation case ${id} has invalid category`);
  }
  return value as RetrievalEvaluationCategory;
}

function source(value: unknown, id: string): RetrievalEvaluationSource {
  if (value !== "fixture" && value !== "admin-approved-sanitized-feedback") {
    throw new Error(`Retrieval evaluation case ${id} has invalid source`);
  }
  return value;
}

export function parseRetrievalCases(input: string): RetrievalEvaluationCase[] {
  const lines = input.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("Retrieval evaluation dataset must not be empty");
  const ids = new Set<string>();
  return lines.map((line, index) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = record(JSON.parse(line), index + 1);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Retrieval evaluation line ${index + 1} is not valid JSON`, { cause: error });
      }
      throw error;
    }
    const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
    const query = typeof parsed.query === "string" ? parsed.query.trim() : "";
    const project = typeof parsed.project === "string" ? parsed.project.trim() : "";
    if (!id || !query || !project) throw new Error(`Retrieval evaluation line ${index + 1} requires id, query, and project`);
    if (ids.has(id)) throw new Error(`Retrieval evaluation dataset has duplicate id: ${id}`);
    ids.add(id);
    const expectedTitles = stringArray(parsed.expectedTitles, "expectedTitles", id);
    const expectedPaths = stringArray(parsed.expectedPaths, "expectedPaths", id);
    const expectEmpty = parsed.expectEmpty === true;
    const itemCategory = category(parsed.category, id);
    const itemSource = source(parsed.source, id);
    const approvalId = typeof parsed.approvalId === "string" ? parsed.approvalId.trim() : "";
    const sanitizedAt = typeof parsed.sanitizedAt === "string" ? parsed.sanitizedAt.trim() : "";
    if (itemSource === "admin-approved-sanitized-feedback"
      && (!approvalId || Number.isNaN(Date.parse(sanitizedAt)))) {
      throw new Error(`Retrieval evaluation case ${id} requires approvalId and sanitizedAt for approved feedback`);
    }
    if (expectEmpty && (expectedTitles.length || expectedPaths.length)) {
      throw new Error(`Retrieval evaluation case ${id} expects empty results and must not declare expected titles or paths`);
    }
    if (!expectEmpty && !expectedTitles.length && !expectedPaths.length) {
      throw new Error(`Retrieval evaluation case ${id} must declare an expected title or path`);
    }
    return {
      id, query, project, expectedTitles, expectedPaths, expectEmpty,
      category: itemCategory,
      source: itemSource,
      ...(itemSource === "admin-approved-sanitized-feedback" ? { approvalId, sanitizedAt } : {})
    };
  });
}

function resultMatches(item: RetrievalEvaluationCase, result: EvaluationSearchResult): boolean {
  return item.expectedTitles.includes(result.title)
    || result.citations.some((citation) => item.expectedPaths.includes(citation.path));
}

function validCitation(citation: Citation): boolean {
  return Boolean(citation.path)
    && citation.startLine >= 1
    && citation.endLine >= citation.startLine
    && /^[a-f0-9]{40}$/iu.test(citation.commitSha)
    && /^[a-f0-9]{64}$/iu.test(citation.blobHash);
}

export async function evaluateRetrievalCases(
  cases: RetrievalEvaluationCase[],
  search: (item: RetrievalEvaluationCase) => Promise<EvaluationSearchResult[]>
): Promise<RetrievalEvaluationMetrics> {
  return (await evaluateRetrievalCasesWithDetails(cases, search)).metrics;
}

export async function evaluateRetrievalCasesWithDetails(
  cases: RetrievalEvaluationCase[],
  search: (item: RetrievalEvaluationCase) => Promise<EvaluationSearchResult[]>
): Promise<RetrievalEvaluationReport> {
  let evaluated = 0;
  let emptyCases = 0;
  let recalls = 0;
  let reciprocalRanks = 0;
  let citations = 0;
  let validCitations = 0;
  let falsePositiveEmpty = 0;
  const failures: RetrievalEvaluationFailure[] = [];

  for (const item of cases) {
    const results = await search(item);
    if (item.expectEmpty) {
      emptyCases += 1;
      if (results.length) {
        falsePositiveEmpty += 1;
        failures.push({ id: item.id, category: item.category, kind: "unexpected-empty-result" });
      }
      continue;
    }
    evaluated += 1;
    const topFive = results.slice(0, 5);
    const rank = results.findIndex((result) => resultMatches(item, result));
    if (topFive.some((result) => resultMatches(item, result))) recalls += 1;
    else failures.push({ id: item.id, category: item.category, kind: "expected-result-missing" });
    if (rank >= 0) reciprocalRanks += 1 / (rank + 1);
    let hasInvalidCitation = false;
    for (const citation of topFive.flatMap((result) => result.citations)) {
      citations += 1;
      if (validCitation(citation)) validCitations += 1;
      else hasInvalidCitation = true;
    }
    if (hasInvalidCitation) failures.push({ id: item.id, category: item.category, kind: "invalid-citation" });
  }

  return {
    metrics: {
      total: cases.length,
      evaluated,
      emptyCases,
      recallAt5: evaluated ? recalls / evaluated : 0,
      mrr: evaluated ? reciprocalRanks / evaluated : 0,
      citationValidity: citations ? validCitations / citations : 0,
      falsePositiveEmptyRate: emptyCases ? falsePositiveEmpty / emptyCases : 0
    },
    failures
  };
}

export function assertRetrievalQuality(report: RetrievalEvaluationReport): void {
  const { metrics } = report;
  const violations = [
    metrics.recallAt5 < retrievalQualityThresholds.recallAt5
      ? `Recall@5 ${metrics.recallAt5.toFixed(4)} < ${retrievalQualityThresholds.recallAt5.toFixed(2)}` : null,
    metrics.mrr < retrievalQualityThresholds.mrr
      ? `MRR ${metrics.mrr.toFixed(4)} < ${retrievalQualityThresholds.mrr.toFixed(2)}` : null,
    metrics.citationValidity < retrievalQualityThresholds.citationValidity
      ? `citation validity ${metrics.citationValidity.toFixed(4)} < ${retrievalQualityThresholds.citationValidity.toFixed(2)}` : null,
    metrics.falsePositiveEmptyRate > retrievalQualityThresholds.falsePositiveEmptyRate
      ? `false-positive empty rate ${metrics.falsePositiveEmptyRate.toFixed(4)} > ${retrievalQualityThresholds.falsePositiveEmptyRate.toFixed(2)}` : null
  ].filter((value): value is string => Boolean(value));
  if (!violations.length && !report.failures.length) return;
  const failedCaseIds = report.failures.map((failure) => failure.id).join(", ") || "none";
  const message = violations.length ? `${violations.join("; ")}. ` : "";
  throw new Error(`Knowledge retrieval quality gate failed: ${message}Failed cases: ${failedCaseIds}`);
}

export function graphRankingImproves(
  baseline: Pick<RetrievalEvaluationMetrics, "recallAt5" | "mrr">,
  candidate: Pick<RetrievalEvaluationMetrics, "recallAt5" | "mrr">
): boolean {
  return candidate.recallAt5 >= baseline.recallAt5
    && candidate.mrr >= baseline.mrr
    && (candidate.recallAt5 - baseline.recallAt5 >= 0.01 || candidate.mrr - baseline.mrr >= 0.01);
}
