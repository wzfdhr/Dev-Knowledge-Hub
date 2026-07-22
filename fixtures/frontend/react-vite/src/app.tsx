import { createContext, forwardRef, useContext, useEffect, useState } from "react";

import { DashboardChart } from "./chart";
import { loadDashboard } from "./api";
import styles from "./styles.module.css";
import { useDashboardStore } from "./store";

export interface DashboardPageProps { teamId?: string }

export const SessionContext = createContext({ userId: "anonymous" });

export const DashboardShell = forwardRef<HTMLElement, { title?: string; children: React.ReactNode }>(
  function DashboardShell({ title = "Dashboard", children }, ref) {
    return <section ref={ref} className={styles.dashboard}><h1>{title}</h1>{children}</section>;
  }
);

export function DashboardPage({ teamId = "core" }: DashboardPageProps) {
  const session = useContext(SessionContext);
  const setTitle = useDashboardStore((state) => state.setTitle);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    void loadDashboard(teamId)
      .then((data) => { if (active) setTitle(data.title); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason : new Error("Dashboard failed")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [setTitle, teamId]);
  if (loading) return <p>Loading dashboard for {session.userId}</p>;
  if (error) return <p role="alert">{error.message}</p>;
  return <DashboardShell><DashboardChart teamId={teamId} /></DashboardShell>;
}
