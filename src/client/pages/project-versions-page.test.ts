import { describe, expect, test } from "vitest";

import { canEnableLlmBuild, shadowPipelineMessage, shouldPollShadowPipeline } from "./project-versions-page";

describe("ProjectVersionsPage shadow pipeline status", () => {
  test("explains a failed shadow stage without reporting a formal build failure", () => {
    expect(shadowPipelineMessage("failed")).toEqual({
      title: "影子验证发现问题",
      detail: "正式版本保持不变；请检查失败阶段后重试影子验证。"
    });
  });

  test("keeps polling a shadow pipeline after the legacy build is ready", () => {
    expect(shouldPollShadowPipeline("ready", "queued")).toBe(true);
  });
});

describe("ProjectVersionsPage LLM build permission", () => {
  test("shows the LLM opt-in only to workspace or project administrators", () => {
    expect(canEnableLlmBuild("admin", undefined)).toBe(true);
    expect(canEnableLlmBuild("member", "admin")).toBe(true);
    expect(canEnableLlmBuild("member", "member")).toBe(false);
    expect(canEnableLlmBuild("reader", "reader")).toBe(false);
  });
});
