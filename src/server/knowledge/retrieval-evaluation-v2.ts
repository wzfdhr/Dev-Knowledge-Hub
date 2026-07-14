import type { Citation } from "./intelligence.js";

export interface RetrievalEvaluationCase {
  id: string;
  query: string;
  project: string;
  expectedTitles: string[];
  expectedPaths: string[];
  expectEmpty: boolean;
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
    if (expectEmpty && (expectedTitles.length || expectedPaths.length)) {
      throw new Error(`Retrieval evaluation case ${id} expects empty results and must not declare expected titles or paths`);
    }
    if (!expectEmpty && !expectedTitles.length && !expectedPaths.length) {
      throw new Error(`Retrieval evaluation case ${id} must declare an expected title or path`);
    }
    return { id, query, project, expectedTitles, expectedPaths, expectEmpty };
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
  let evaluated = 0;
  let emptyCases = 0;
  let recalls = 0;
  let reciprocalRanks = 0;
  let citations = 0;
  let validCitations = 0;
  let falsePositiveEmpty = 0;

  for (const item of cases) {
    const results = await search(item);
    if (item.expectEmpty) {
      emptyCases += 1;
      if (results.length) falsePositiveEmpty += 1;
      continue;
    }
    evaluated += 1;
    const topFive = results.slice(0, 5);
    const rank = results.findIndex((result) => resultMatches(item, result));
    if (topFive.some((result) => resultMatches(item, result))) recalls += 1;
    if (rank >= 0) reciprocalRanks += 1 / (rank + 1);
    for (const citation of topFive.flatMap((result) => result.citations)) {
      citations += 1;
      if (validCitation(citation)) validCitations += 1;
    }
  }

  return {
    total: cases.length,
    evaluated,
    emptyCases,
    recallAt5: evaluated ? recalls / evaluated : 0,
    mrr: evaluated ? reciprocalRanks / evaluated : 0,
    citationValidity: citations ? validCitations / citations : 0,
    falsePositiveEmptyRate: emptyCases ? falsePositiveEmpty / emptyCases : 0
  };
}
