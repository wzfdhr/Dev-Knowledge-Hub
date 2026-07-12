import { createHash } from "node:crypto";

import { validateKnowledgeEnhancement, type KnowledgeEnhancer } from "./enhancer.js";
import type { Citation, CodeIndex, CodeSymbol } from "./intelligence.js";
import type { BuildPurpose } from "./build-service.js";

export interface KnowledgeChunk {
  id: string;
  heading: string | null;
  content: string;
  citations: Citation[];
}

export interface KnowledgePageDraft {
  id: string;
  slug: string;
  title: string;
  body: string;
  citations: Citation[];
  chunks: KnowledgeChunk[];
  kind: "required" | "module" | "symbol" | "feedback";
}

export interface KnowledgeWarning {
  code: "ENHANCER_FAILED";
  message: string;
}

export interface KnowledgeOutput {
  pages: KnowledgePageDraft[];
  warnings: KnowledgeWarning[];
}

const requiredSlugs = [
  "architecture-overview",
  "conventions",
  "run-test-guide",
  "dependency-summary"
] as const;

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function uniqueCitations(citations: Citation[]): Citation[] {
  return [...new Map(citations.map((citation) => [
    `${citation.path}:${citation.startLine}:${citation.endLine}:${citation.blobHash}`,
    citation
  ])).values()];
}

function page(
  slug: string,
  title: string,
  body: string,
  citations: Citation[],
  kind: KnowledgePageDraft["kind"]
): KnowledgePageDraft {
  const draft = { id: stableId(slug), slug, title, body, citations: uniqueCitations(citations), kind };
  return { ...draft, chunks: chunkPage(draft) };
}

function symbolsByKind(index: CodeIndex): string {
  const counts = new Map<string, number>();
  for (const symbol of index.symbols) counts.set(symbol.kind, (counts.get(symbol.kind) ?? 0) + 1);
  return [...counts].sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `- ${kind}: ${count}`)
    .join("\n");
}

function requiredPages(index: CodeIndex): KnowledgePageDraft[] {
  const fallback = index.files[0];
  if (!fallback) return [];
  const modules = index.symbols.filter((symbol) => symbol.kind === "module");
  const scripts = index.symbols.filter((symbol) => symbol.kind === "package-script");
  const dependencies = index.edges.filter((edge) =>
    edge.kind === "package-dependency" || edge.kind === "module-dependency"
  );
  const conventionCitations = [...index.configs, ...index.documents];
  return [
    page(
      "architecture-overview",
      "架构概览",
      `# 架构概览\n\n本快照包含 ${modules.length} 个模块和 ${index.symbols.length} 个已索引符号。\n\n## 符号清单\n\n${symbolsByKind(index)}`,
      modules.length ? modules : [fallback],
      "required"
    ),
    page(
      "conventions",
      "开发约定",
      `# 开发约定\n\n配置和贡献指南定义在 ${conventionCitations.map((citation) => citation.path).join(", ") || fallback.path}。`,
      conventionCitations.length ? conventionCitations : [fallback],
      "required"
    ),
    page(
      "run-test-guide",
      "运行与测试指南",
      `# 运行与测试指南\n\n${scripts.length
        ? scripts.map((script) => `- ${script.name}`).join("\n")
        : "未检测到 package scripts。"}`,
      scripts.length ? scripts : [fallback],
      "required"
    ),
    page(
      "dependency-summary",
      "依赖摘要",
      `# 依赖摘要\n\n${dependencies.length
        ? dependencies.map((edge) => `- ${edge.source} -> ${edge.target}`).join("\n")
        : "未检测到依赖关系。"}`,
      dependencies.length ? dependencies.map((edge) => edge.citation) : [fallback],
      "required"
    )
  ];
}

function modulePages(index: CodeIndex): KnowledgePageDraft[] {
  return index.symbols.filter((symbol) => symbol.kind === "module").map((module) => {
    const owned = index.symbols.filter((symbol) => symbol.path === module.path && symbol.kind !== "module");
    const edges = index.edges.filter((edge) => edge.source === module.path);
    const body = `# 模块：${module.path}\n\n## 符号\n\n${owned.length
      ? owned.map((symbol) => `- ${symbol.kind} ${symbol.name} (${symbol.startLine}-${symbol.endLine})`).join("\n")
      : "未检测到声明。"}\n\n## 依赖关系\n\n${edges.length
      ? edges.map((edge) => `- ${edge.kind}: ${edge.target}`).join("\n")
      : "未检测到模块依赖。"}`;
    return page(`modules/${slugify(module.path)}`, `模块：${module.path}`, body, [module], "module");
  });
}

function symbolPages(index: CodeIndex): KnowledgePageDraft[] {
  const seen = new Set<string>();
  return index.symbols.filter((symbol) => symbol.kind !== "module").flatMap((symbol: CodeSymbol) => {
    const base = `symbols/${slugify(symbol.name)}`;
    let slug = base;
    if (seen.has(slug)) {
      slug = `${base}-${slugify(symbol.path)}-l${symbol.startLine}-${symbol.endLine}-${symbol.kind}`;
    }
    if (seen.has(slug)) {
      slug = `${slug}-${stableId([
        symbol.name, symbol.path, symbol.startLine, symbol.endLine, symbol.kind, symbol.signature ?? ""
      ].join(":"))}`;
    }
    seen.add(slug);
    const body = `# ${symbol.name}\n\n- 类型：${symbol.kind}\n- 源码：${symbol.path}:${symbol.startLine}-${symbol.endLine}${symbol.signature ? `\n- 签名：${symbol.signature}` : ""}`;
    return [page(slug, symbol.name, body, [symbol], "symbol")];
  });
}

function feedbackPages(index: CodeIndex, purpose: BuildPurpose): KnowledgePageDraft[] {
  if (purpose.kind !== "feedback") return [];
  const files = new Map(index.files.map((file) => [file.path, file]));
  const citations = uniqueCitations(purpose.feedbackContext.flatMap((feedback) =>
    feedback.citations.filter((citation) => {
      const source = files.get(citation.path);
      return source
        && citation.commitSha === source.commitSha
        && citation.blobHash === source.blobHash
        && citation.startLine >= 1
        && citation.endLine >= citation.startLine
        && citation.endLine <= source.endLine;
    })
  ));
  const fallback = index.files[0];
  if (!citations.length && !fallback) return [];
  const body = [
    "# 反馈重建上下文",
    ...purpose.feedbackContext.flatMap((feedback) => [
      `## 反馈 ${feedback.feedbackId}`,
      `- 查询：${feedback.query}`,
      `- 原因：${feedback.reason}`,
      `- 期望：${feedback.expected ?? "未提供"}`,
      `- 引用：${feedback.citations.map((citation) =>
        `${citation.path}:${citation.startLine}-${citation.endLine}`).join(", ") || "未提供"}`
    ])
  ].join("\n\n");
  return [page(
    "feedback-rebuild-context",
    "反馈重建上下文",
    body,
    citations.length ? citations : [fallback!],
    "feedback"
  )];
}

function splitLongText(text: string, maximum: number): string[] {
  if (text.length <= maximum) return [text];
  const pieces: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maximum) {
    const boundary = Math.max(1, remaining.lastIndexOf(" ", maximum));
    pieces.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) pieces.push(remaining);
  return pieces;
}

export function chunkPage(
  source: Omit<KnowledgePageDraft, "chunks" | "kind"> | Omit<KnowledgePageDraft, "chunks">,
  maximum = 1_500
): KnowledgeChunk[] {
  const paragraphs = source.body.split(/\n{2,}/).flatMap((paragraph) => splitLongText(paragraph, maximum));
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maximum && current) {
      chunks.push(current);
      current = paragraph;
    } else current = candidate;
  }
  if (current) chunks.push(current);
  return chunks.map((content, index) => ({
    id: stableId(`${source.id}:${index}:${content}`),
    heading: /^#{1,6}\s+(.+)$/m.exec(content)?.[1] ?? null,
    content,
    citations: source.citations
  }));
}

export async function generateKnowledge(
  index: CodeIndex,
  enhancer?: KnowledgeEnhancer,
  context: { purpose: BuildPurpose } = {
    purpose: { kind: "standard", feedbackIds: [], feedbackContext: [] }
  }
): Promise<KnowledgeOutput> {
  const pages = [
    ...requiredPages(index),
    ...feedbackPages(index, context.purpose),
    ...modulePages(index),
    ...symbolPages(index)
  ];
  const warnings: KnowledgeWarning[] = [];
  if (enhancer) {
    for (const draft of pages) {
      try {
        const enhancedBody = await enhancer.enhance({
          slug: draft.slug,
          title: draft.title,
          deterministicBody: draft.body,
          citations: draft.citations,
          buildPurpose: context.purpose
        });
        validateKnowledgeEnhancement(draft.body, enhancedBody);
        draft.body = enhancedBody;
        draft.chunks = chunkPage(draft);
      } catch (error) {
        warnings.push({
          code: "ENHANCER_FAILED",
          message: error instanceof Error ? error.message : "Knowledge enhancement failed"
        });
        break;
      }
    }
  }
  return { pages, warnings };
}

export class KnowledgeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeValidationError";
  }
}

export function validateKnowledge(output: KnowledgeOutput, index: CodeIndex): void {
  const files = new Map(index.files.map((file) => [file.path, file]));
  for (const slug of requiredSlugs) {
    const required = output.pages.find((candidate) => candidate.slug === slug);
    if (!required?.body.trim()) throw new KnowledgeValidationError(`Required page ${slug} is empty`);
  }
  for (const draft of output.pages) {
    if (!draft.body.trim() || !draft.chunks.length) {
      throw new KnowledgeValidationError(`Page ${draft.slug} is empty`);
    }
    for (const chunk of draft.chunks) {
      if (!chunk.content.trim()) throw new KnowledgeValidationError(`Chunk ${chunk.id} is empty`);
      if (!chunk.citations.length) throw new KnowledgeValidationError(`Chunk ${chunk.id} has no citation`);
      for (const citation of chunk.citations) {
        const source = files.get(citation.path);
        if (!source) throw new KnowledgeValidationError(`Citation path is outside snapshot: ${citation.path}`);
        if (citation.commitSha !== index.commitSha || citation.blobHash !== source.blobHash) {
          throw new KnowledgeValidationError(`Citation does not match snapshot: ${citation.path}`);
        }
        if (citation.startLine < 1 || citation.endLine < citation.startLine
          || citation.endLine > source.endLine) {
          throw new KnowledgeValidationError(`Citation range is invalid: ${citation.path}`);
        }
      }
    }
  }
}
