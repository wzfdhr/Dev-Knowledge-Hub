import { useEffect } from "react";

import { fetchAnalyticsSummary } from "./analytics-api";
import { AnalyticsChart } from "./analytics-chart";
import styles from "./analytics.module.css";
import { useAnalyticsStore } from "./analytics-store";

export interface AnalyticsPageProps { accountId: string }

export function AnalyticsPage({ accountId }: AnalyticsPageProps) {
  const setSummary = useAnalyticsStore((state) => state.setSummary);
  useEffect(() => { void fetchAnalyticsSummary(accountId).then(setSummary); }, [accountId, setSummary]);
  return <article className={styles.page}><h1>Analytics</h1><AnalyticsChart accountId={accountId} /></article>;
}
