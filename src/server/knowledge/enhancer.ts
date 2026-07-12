import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type LanguageModel } from "ai";
import type { BuildPurpose } from "./build-service.js";
import type { Citation } from "./intelligence.js";

export interface EnhancementRequest {
  slug: string;
  title: string;
  deterministicBody: string;
  citations: Citation[];
  buildPurpose: BuildPurpose;
}

export interface KnowledgeEnhancer {
  enhance(request: EnhancementRequest): Promise<string>;
}

export class UnsafeKnowledgeEnhancementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeKnowledgeEnhancementError";
  }
}

const englishProse = /\b[A-Za-z]+(?:\s+[A-Za-z]+)+\b/;
const chineseCharacter = /\p{Script=Han}/u;

export function validateKnowledgeEnhancement(
  deterministicBody: string,
  enhancedBody: string
): void {
  if (!enhancedBody.includes(deterministicBody)) {
    throw new UnsafeKnowledgeEnhancementError(
      "Knowledge enhancement must preserve the deterministic body verbatim"
    );
  }
  const addedText = enhancedBody.replace(deterministicBody, "").trim();
  if (addedText && (!chineseCharacter.test(addedText) || englishProse.test(addedText))) {
    throw new UnsafeKnowledgeEnhancementError(
      "Knowledge enhancement must add Simplified Chinese prose only"
    );
  }
}

export class AiSdkKnowledgeEnhancer implements KnowledgeEnhancer {
  constructor(private readonly model: LanguageModel) {}

  async enhance(request: EnhancementRequest): Promise<string> {
    const feedbackContext = request.buildPurpose.kind === "feedback"
      ? `\n\nAcknowledged feedback context:\n${JSON.stringify(request.buildPurpose.feedbackContext)}`
      : "";
    const result = await generateText({
      model: this.model,
      system: "使用简体中文提升清晰度，不得添加事实。必须逐字保留原始内容，并且只能补充简体中文说明；不得翻译或更改代码标识、文件路径、命令、Commit SHA、Blob Hash 或引用字段。",
      prompt: `${request.deterministicBody}\n\nCitations (preserve exactly):\n${JSON.stringify(request.citations)}${feedbackContext}`
    });
    return result.text.trim() || request.deterministicBody;
  }
}

export function openAiCompatibleEnhancer(options: {
  apiKey: string;
  model: string;
  baseUrl?: string;
}): KnowledgeEnhancer {
  const provider = createOpenAI({ apiKey: options.apiKey, baseURL: options.baseUrl });
  return new AiSdkKnowledgeEnhancer(provider(options.model));
}

export function anthropicEnhancer(options: { apiKey: string; model: string }): KnowledgeEnhancer {
  const provider = createAnthropic({ apiKey: options.apiKey });
  return new AiSdkKnowledgeEnhancer(provider(options.model));
}
