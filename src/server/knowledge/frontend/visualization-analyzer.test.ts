import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { analyzeVisualizationSource } from "./visualization-analyzer.js";

function input(content: string) {
  return {
    snapshotId: "snapshot-chart",
    path: "src/dashboard-chart.tsx",
    content,
    blobHash: createHash("sha256").update(content).digest("hex"),
    packageKey: "app",
    resolutions: []
  };
}

describe("analyzeVisualizationSource", () => {
  test("models ECharts lifecycle, option structure, events, and wrapper component", () => {
    const content = [
      "import * as echarts from 'echarts';",
      "export function DashboardChart({ values }: { values: number[] }) {",
      "  useEffect(() => {",
      "    const chart = echarts.init(element.current);",
      "    chart.setOption({ dataset: { source: values }, xAxis: { type: 'category' }, yAxis: {}, series: [{ type: 'bar' }], visualMap: {}, dataZoom: [{}], brush: {} });",
      "    chart.on('click', handleClick);",
      "    const resize = () => chart.resize();",
      "    window.addEventListener('resize', resize);",
      "    return () => { window.removeEventListener('resize', resize); chart.dispose(); };",
      "  }, [values]);",
      "  return <div ref={element} />;",
      "}"
    ].join("\n");
    const output = analyzeVisualizationSource(input(content));
    const chart = output.entities.find((entity) => entity.kind === "visualization");

    expect(chart).toMatchObject({
      name: "chart",
      attributes: { library: { state: "known", value: "echarts" } },
      facets: { "visualization-core": expect.objectContaining({
        initialized: true,
        datasets: 1,
        series: [{ type: "bar" }],
        axes: ["xAxis", "yAxis"],
        features: ["brush", "dataZoom", "visualMap"],
        events: ["click"],
        disposes: true,
        resizes: true
      }) }
    });
    expect(output.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "visualizes", evidenceClass: "fact" })
    ]));
  });

  test("recognizes option builders and marks dynamic options partial", () => {
    const content = [
      "export function buildTrendOption(source: unknown[]) { return { dataset: { source }, series: [{ type: 'line' }] }; }",
      "export function TrendChart() { const chart = echarts.init(host); chart.setOption(buildTrendOption(rows)); return <div />; }"
    ].join("\n");
    const output = analyzeVisualizationSource(input(content));

    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "visualization", name: "buildTrendOption", facets: { "visualization-core": expect.objectContaining({ optionBuilder: true, series: [{ type: "line" }] }) } }),
      expect.objectContaining({ kind: "visualization", name: "chart", completeness: "partial" })
    ]));
  });
});
