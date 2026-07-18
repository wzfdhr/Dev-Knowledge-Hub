import * as echarts from "echarts";
import { useEffect, useRef } from "react";

export function DashboardChart({ teamId }: { teamId: string }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!element.current) return;
    const chart = echarts.init(element.current);
    chart.setOption({ dataset: { source: [["team", "value"], [teamId, 42]] }, series: [{ type: "bar" }] });
    return () => chart.dispose();
  }, [teamId]);
  return <div ref={element} aria-label="Team activity chart" />;
}
