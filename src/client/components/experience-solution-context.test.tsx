// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import type { FrontendSolutionContext } from "../api/types";
import { ExperienceSolutionContext } from "./experience-solution-context";

afterEach(cleanup);

const context: FrontendSolutionContext = {
  schemaVersion: 1,
  currentProject: { projectId: "project-1", releaseId: "release-1", sourceVersion: "content-1", status: "ready" },
  currentProjectFacts: [{ key: "router", label: "Router", value: "React Router", citations: [] }],
  hardConstraints: [{ key: "framework", statement: "Keep React 19", citations: [] }],
  applicableExperiences: [{
    id: "experience-1", title: "ECharts 下钻", capability: "chart_drilldown",
    state: "recommended", observedFacts: ["click writes route params"], evidenceCount: 2,
    trustScore: 0.92, citations: []
  }],
  rejectedExperiences: [{ experienceId: "vue-pattern", reasons: ["FRAMEWORK_MISMATCH"] }],
  unknowns: [{ key: "chart-data-volume", reason: "图表数据量", requiredForRecommendation: true }],
  changeImpact: [{ path: "src/chart.tsx", reason: "update chart", citations: [] }],
  verificationPlan: [{ step: "Run chart tests", reason: "verify drilldown", citations: [] }]
};

describe("ExperienceSolutionContext", () => {
  test("keeps current facts, experience references, exclusions, and unknowns separate", () => {
    render(<ExperienceSolutionContext context={context} />);

    expect(screen.getByRole("region", { name: "当前项目事实" })).toHaveTextContent("React Router");
    expect(screen.getByRole("region", { name: "历史工程经验" })).toHaveTextContent("ECharts 下钻");
    expect(screen.getByRole("region", { name: "已排除方案" })).toHaveTextContent("FRAMEWORK_MISMATCH");
    expect(screen.getByRole("region", { name: "待确认条件" })).toHaveTextContent("图表数据量");
    expect(screen.getByRole("region", { name: "影响与验证计划" })).toHaveTextContent("src/chart.tsx");
  });
});
