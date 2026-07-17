export interface ComparableCitation {
  path: string;
  startLine: number;
  endLine: number;
  commitSha: string;
  blobHash: string;
}

export interface ComparableKnowledgeOutput {
  pages: Array<{ key: string; citations: ComparableCitation[] }>;
  graph: { nodes: string[]; edges: string[] };
  search: Array<{ key: string; citations: ComparableCitation[] }>;
  quality: { issueCount: number; trust: number | null };
}

export interface KnowledgeKernelDifference {
  area: "pages" | "graph_nodes" | "graph_edges" | "search" | "quality" | "citations";
  key: string;
  reason: "missing_in_pipeline" | "additional_in_pipeline" | "invalid_citation" | "quality_changed";
}

export interface KnowledgeKernelComparison {
  blockingDefects: KnowledgeKernelDifference[];
  compatibilityDifferences: KnowledgeKernelDifference[];
  expectedImprovements: KnowledgeKernelDifference[];
  citations: { valid: boolean; total: number; invalid: KnowledgeKernelDifference[] };
}

function ordered(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function compareCoverage(
  area: KnowledgeKernelDifference["area"],
  legacy: Iterable<string>,
  pipeline: Iterable<string>,
  result: KnowledgeKernelComparison
): void {
  const legacyKeys = new Set(legacy);
  const pipelineKeys = new Set(pipeline);
  for (const key of ordered(legacyKeys)) {
    if (!pipelineKeys.has(key)) result.blockingDefects.push({ area, key, reason: "missing_in_pipeline" });
  }
  for (const key of ordered(pipelineKeys)) {
    if (!legacyKeys.has(key)) result.expectedImprovements.push({ area, key, reason: "additional_in_pipeline" });
  }
}

function citationKey(citation: ComparableCitation): string {
  return `${citation.path}:${citation.startLine}:${citation.endLine}`;
}

function citationIsValid(citation: ComparableCitation): boolean {
  return Boolean(citation.path)
    && Number.isInteger(citation.startLine)
    && Number.isInteger(citation.endLine)
    && citation.startLine > 0
    && citation.endLine >= citation.startLine
    && /^[a-f0-9]{40}$/i.test(citation.commitSha)
    && /^[a-f0-9]{64}$/i.test(citation.blobHash);
}

function compareQuality(
  legacy: ComparableKnowledgeOutput["quality"],
  pipeline: ComparableKnowledgeOutput["quality"],
  result: KnowledgeKernelComparison
): void {
  if (legacy.trust === null && pipeline.trust !== null) {
    result.expectedImprovements.push({ area: "quality", key: "trust", reason: "quality_changed" });
  } else if (legacy.trust !== null && pipeline.trust === null) {
    result.compatibilityDifferences.push({ area: "quality", key: "trust", reason: "quality_changed" });
  }
  if (legacy.issueCount !== pipeline.issueCount) {
    result.expectedImprovements.push({ area: "quality", key: "issue_count", reason: "quality_changed" });
  }
}

export function compareKnowledgeKernelOutputs(input: {
  legacy: ComparableKnowledgeOutput;
  pipeline: ComparableKnowledgeOutput;
}): KnowledgeKernelComparison {
  const result: KnowledgeKernelComparison = {
    blockingDefects: [], compatibilityDifferences: [], expectedImprovements: [],
    citations: { valid: true, total: 0, invalid: [] }
  };
  compareCoverage("pages", input.legacy.pages.map((page) => page.key), input.pipeline.pages.map((page) => page.key), result);
  compareCoverage("graph_nodes", input.legacy.graph.nodes, input.pipeline.graph.nodes, result);
  compareCoverage("graph_edges", input.legacy.graph.edges, input.pipeline.graph.edges, result);
  compareCoverage("search", input.legacy.search.map((document) => document.key), input.pipeline.search.map((document) => document.key), result);
  compareQuality(input.legacy.quality, input.pipeline.quality, result);

  const citations = [
    ...input.legacy.pages.flatMap((page) => page.citations),
    ...input.legacy.search.flatMap((document) => document.citations),
    ...input.pipeline.pages.flatMap((page) => page.citations),
    ...input.pipeline.search.flatMap((document) => document.citations)
  ];
  result.citations.total = citations.length;
  for (const citation of citations) {
    if (citationIsValid(citation)) continue;
    const difference: KnowledgeKernelDifference = {
      area: "citations", key: citationKey(citation), reason: "invalid_citation"
    };
    result.blockingDefects.push(difference);
    result.citations.invalid.push(difference);
  }
  result.citations.valid = result.citations.invalid.length === 0;
  return result;
}
