import { describe, expect, test, vi } from "vitest";

const { createOpenAI, provider } = vi.hoisted(() => {
  const provider = vi.fn(() => ({}) as never);
  return { createOpenAI: vi.fn(() => provider), provider };
});

vi.mock("@ai-sdk/openai", () => ({ createOpenAI }));

import { deepseekEnhancer } from "./enhancer";

describe("DeepSeek knowledge enhancement", () => {
  test("uses the fixed official endpoint and flash model", () => {
    const enhancer = deepseekEnhancer("deepseek-key");

    expect(enhancer).toBeDefined();
    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: "deepseek-key",
      baseURL: "https://api.deepseek.com"
    });
    expect(provider).toHaveBeenCalledWith("deepseek-v4-flash");
  });
});
