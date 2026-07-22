export const FRONTEND_EXPERIENCE_CAPABILITIES = [
  "chart_drilldown",
  "form_validation",
  "state_data_flow",
  "component_styling",
  "frontend_testing"
] as const;

export type FrontendExperienceCapability = (typeof FRONTEND_EXPERIENCE_CAPABILITIES)[number];

const keywords: Record<FrontendExperienceCapability, readonly string[]> = {
  chart_drilldown: ["echarts", "chart", "drilldown", "下钻", "图表", "可视化"],
  form_validation: ["form", "validation", "validate", "表单", "校验", "验证"],
  state_data_flow: ["state", "query", "request", "cache", "状态", "请求", "缓存", "数据流"],
  component_styling: ["component", "style", "token", "组件", "样式", "设计令牌"],
  frontend_testing: ["test", "testing", "vitest", "jest", "playwright", "测试"]
};

export function classifyFrontendExperienceIntent(query: string): FrontendExperienceCapability[] {
  const normalized = query.trim().toLocaleLowerCase();
  return FRONTEND_EXPERIENCE_CAPABILITIES.filter((capability) =>
    keywords[capability].some((keyword) => normalized.includes(keyword))
  );
}

export function frontendExperienceIntentDigest(query: string): string {
  const normalized = query.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
  const capabilities = classifyFrontendExperienceIntent(normalized);
  return createHash("sha256").update(JSON.stringify({ normalized, capabilities }), "utf8").digest("hex");
}
import { createHash } from "node:crypto";
