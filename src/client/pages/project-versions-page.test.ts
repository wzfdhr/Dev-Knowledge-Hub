import { describe, expect, test } from "vitest";

import { canCreateFrontendDraft, canEnableLlmBuild, frontendDraftAvailability, shadowPipelineMessage, shouldPollShadowPipeline, suggestNextReleaseVersion } from "./project-versions-page";

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

describe("ProjectVersionsPage active frontend draft permission", () => {
  test("limits active graph drafts to administrators", () => {
    expect(canCreateFrontendDraft("admin", undefined)).toBe(true);
    expect(canCreateFrontendDraft("member", "admin")).toBe(true);
    expect(canCreateFrontendDraft("member", "member")).toBe(false);
    expect(canCreateFrontendDraft("reader", "admin")).toBe(false);
  });

  test("does not offer an active graph draft after a parser-unavailable extract failure", () => {
    expect(frontendDraftAvailability([
      { id: "extract", buildId: "build", stage: "extract", attempt: 1, status: "failed", inputDigest: "a", outputManifestIds: [], startedAt: null, finishedAt: null, errorCode: "PARSER_RUNTIME_UNAVAILABLE", errorDetail: "Parser service closed the connection" }
    ])).toEqual({ ready: false, reason: "前端候选包未生成：解析器连接暂时中断。重新构建后再创建 active 图谱草稿。" });
  });

  test("offers an active graph draft only after the package stage succeeds", () => {
    expect(frontendDraftAvailability([
      { id: "package", buildId: "build", stage: "package", attempt: 1, status: "succeeded", inputDigest: "a", outputManifestIds: ["artifact"], startedAt: null, finishedAt: null, errorCode: null, errorDetail: null }
    ])).toEqual({ ready: true, reason: null });
  });
});

describe("ProjectVersionsPage release versions", () => {
  test("suggests the next patch version from existing semantic releases", () => {
    expect(suggestNextReleaseVersion([])).toBe("1.0.0");
    expect(suggestNextReleaseVersion([{ version: "1.0.0" }, { version: "1.0.1" }])).toBe("1.0.2");
    expect(suggestNextReleaseVersion([{ version: "1.9.9" }, { version: "2.0.0" }])).toBe("2.0.1");
  });
});
