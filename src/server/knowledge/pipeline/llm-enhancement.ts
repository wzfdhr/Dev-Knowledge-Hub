import { z } from "zod";

import type { Citation } from "../intelligence.js";

const citationSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/i),
  blobHash: z.string().regex(/^[a-f0-9]{64}$/i)
}).refine((value) => value.endLine >= value.startLine, "Citation line range is invalid");

const responseSchema = z.object({
  summary: z.string().trim().min(1).max(4_000).refine((value) => /\p{Script=Han}/u.test(value), "Summary must contain Chinese prose"),
  aliases: z.array(z.string().trim().min(1).max(120)).max(20),
  citations: z.array(citationSchema).min(1).max(20)
});

export interface StructuredEnhancementRequest {
  inputDigest: string;
  deterministicBody: string;
  citations: readonly Citation[];
}

export interface StructuredEnhancementProvider {
  complete(request: StructuredEnhancementRequest): Promise<unknown>;
}

export type StructuredEnhancementResult = {
  mode: "enhanced";
  summary: string;
  aliases: string[];
  citations: Citation[];
} | {
  mode: "fallback";
  summary: null;
  aliases: [];
  citations: Citation[];
  warning: "LLM_TIMEOUT" | "LLM_INVALID_RESPONSE" | "CITATION_INVALID" | "LLM_PROVIDER_FAILED";
};

class ProviderTimeoutError extends Error {
  constructor() {
    super("LLM provider exceeded its deadline");
    this.name = "ProviderTimeoutError";
  }
}

function citationKey(citation: Citation): string {
  return `${citation.path}:${citation.startLine}:${citation.endLine}:${citation.commitSha}:${citation.blobHash}`;
}

function parseResponse(response: unknown): z.infer<typeof responseSchema> {
  const value = typeof response === "string" ? JSON.parse(response) as unknown : response;
  return responseSchema.parse(value);
}

async function beforeDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderTimeoutError()), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class StructuredKnowledgeEnhancer {
  private readonly cache = new Map<string, StructuredEnhancementResult>();
  private readonly timeoutMs: number;

  constructor(
    private readonly provider: StructuredEnhancementProvider,
    options: { timeoutMs?: number } = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async enhance(request: StructuredEnhancementRequest): Promise<StructuredEnhancementResult> {
    const cached = this.cache.get(request.inputDigest);
    if (cached) return cached;
    try {
      const parsed = parseResponse(await beforeDeadline(this.provider.complete(request), this.timeoutMs));
      const allowed = new Set(request.citations.map(citationKey));
      if (parsed.citations.some((citation) => !allowed.has(citationKey(citation)))) {
        return this.fallback(request, "CITATION_INVALID");
      }
      const result: StructuredEnhancementResult = {
        mode: "enhanced",
        summary: parsed.summary,
        aliases: [...new Set(parsed.aliases)],
        citations: parsed.citations
      };
      this.cache.set(request.inputDigest, result);
      return result;
    } catch (error) {
      if (error instanceof ProviderTimeoutError) return this.fallback(request, "LLM_TIMEOUT");
      if (error instanceof z.ZodError || error instanceof SyntaxError) return this.fallback(request, "LLM_INVALID_RESPONSE");
      return this.fallback(request, "LLM_PROVIDER_FAILED");
    }
  }

  private fallback(
    request: StructuredEnhancementRequest,
    warning: Extract<StructuredEnhancementResult, { mode: "fallback" }>["warning"]
  ): StructuredEnhancementResult {
    return { mode: "fallback", summary: null, aliases: [], citations: [...request.citations], warning };
  }
}
