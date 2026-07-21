import * as echarts from "echarts";
import { useEffect, useRef } from "react";

export function AnalyticsChart({ accountId }: { accountId: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const chart = echarts.init(host.current!);
    chart.setOption({ dataset: { source: [["metric", "value"], [accountId, 12]] }, series: [{ type: "bar" }] });
    return () => chart.dispose();
  }, [accountId]);
  return <div ref={host} aria-label="Analytics chart" />;
}
