import type { SourceRef } from "../../../shared/api-contracts.js";
import type { FrontendIR } from "../../../shared/frontend-ir.js";

export interface FrontendStaticLintIssue {
  rule: "ECHARTS_MISSING_DISPOSE" | "ECHARTS_MISSING_RESIZE" | "FRONTEND_COMPONENT_UNTESTED";
  severity: "warning" | "info";
  targetId: string;
  message: string;
  sourceRefs: SourceRef[];
}

export function lintFrontendIr(ir: FrontendIR): FrontendStaticLintIssue[] {
  const issues: FrontendStaticLintIssue[] = [];
  const tested = new Set(ir.edges.filter((edge) => edge.kind === "tests").map((edge) => edge.toEntityId));
  for (const entity of ir.entities) {
    if (entity.kind === "visualization") {
      const facet = entity.facets["visualization-core"];
      if (facet?.initialized === true && facet.disposes !== true) {
        issues.push({
          rule: "ECHARTS_MISSING_DISPOSE",
          severity: "warning",
          targetId: entity.id,
          message: "ECharts instance has no statically verified dispose call",
          sourceRefs: entity.sourceRefs
        });
      }
      if (facet?.initialized === true && facet.resizes !== true) {
        issues.push({
          rule: "ECHARTS_MISSING_RESIZE",
          severity: "info",
          targetId: entity.id,
          message: "ECharts instance has no statically verified resize handling",
          sourceRefs: entity.sourceRefs
        });
      }
    }
    if (entity.kind === "component" && !tested.has(entity.id)) {
      issues.push({
        rule: "FRONTEND_COMPONENT_UNTESTED",
        severity: "info",
        targetId: entity.id,
        message: "No component or end-to-end test relation was found for this component",
        sourceRefs: entity.sourceRefs
      });
    }
  }
  return issues.sort((left, right) => `${left.rule}:${left.targetId}`.localeCompare(`${right.rule}:${right.targetId}`));
}
