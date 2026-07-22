import { describe, expect, test } from "vitest";

import { classifyFrontendExperienceIntent, frontendExperienceIntentDigest } from "./search-intent";

describe("frontend experience search intent", () => {
  test.each([
    ["ECharts 下钻怎么实现", "chart_drilldown"],
    ["React 表单校验边界", "form_validation"],
    ["how should this component be tested", "frontend_testing"]
  ])("classifies %s", (query, capability) => {
    expect(classifyFrontendExperienceIntent(query)).toContain(capability);
  });

  test("normalizes equivalent query intent cache identities", () => {
    expect(frontendExperienceIntentDigest("  ECharts   下钻 "))
      .toBe(frontendExperienceIntentDigest("echarts 下钻"));
  });
});
