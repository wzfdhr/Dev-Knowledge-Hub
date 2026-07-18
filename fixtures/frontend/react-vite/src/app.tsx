import { useEffect } from "react";

import { DashboardChart } from "./chart";
import { loadDashboard } from "./api";
import styles from "./styles.module.css";
import { useDashboardStore } from "./store";

export interface DashboardPageProps { teamId: string }

export function DashboardPage({ teamId }: DashboardPageProps) {
  const setTitle = useDashboardStore((state) => state.setTitle);
  useEffect(() => { void loadDashboard(teamId).then((data) => setTitle(data.title)); }, [setTitle, teamId]);
  return <section className={styles.dashboard}><h1>Dashboard</h1><DashboardChart teamId={teamId} /></section>;
}
