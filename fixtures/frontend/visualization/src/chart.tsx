import * as echarts from "echarts";
import { useEffect, useRef } from "react";

export function buildRevenueOption(source: Array<[string, number]>) {
  return {
    dataset: { source: [["month", "revenue"], ...source] },
    xAxis: { type: "category" },
    yAxis: { type: "value" },
    dataZoom: [{ type: "inside" }],
    series: [{ type: "line" }]
  };
}

export function RevenueChart({ source }: { source: Array<[string, number]> }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const chart = echarts.init(host.current);
    chart.setOption(buildRevenueOption(source));
    chart.on("click", () => undefined);
    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    return () => { window.removeEventListener("resize", resize); chart.dispose(); };
  }, [source]);
  return <div ref={host} aria-label="Revenue trend" />;
}
