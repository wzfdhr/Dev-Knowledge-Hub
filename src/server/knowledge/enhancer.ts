import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type LanguageModel } from "ai";
import type { BuildPurpose } from "./build-service.js";

export interface EnhancementRequest {
  slug: string;
  title: string;
  deterministicBody: string;
  buildPurpose: BuildPurpose;
}

export interface KnowledgeEnhancer {
  enhance(request: EnhancementRequest): Promise<string>;
}

export class AiSdkKnowledgeEnhancer implements KnowledgeEnhancer {
  constructor(private readonly model: LanguageModel) {}

  async enhance(request: EnhancementRequest): Promise<string> {
    const feedbackContext = request.buildPurpose.kind === "feedback"
      ? `\n\nAcknowledged feedback context:\n${JSON.stringify(request.buildPurpose.feedbackContext)}`
      : "";
    const result = await generateText({
      model: this.model,
      system: "使用简体中文提升清晰度，不得添加事实。保留标题和带引用的事实陈述；不得翻译代码标识、文件路径、命令、Commit SHA、Blob Hash 或引用字段。",
      prompt: `${request.deterministicBody}${feedbackContext}`
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
