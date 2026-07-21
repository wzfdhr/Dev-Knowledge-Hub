import { zodResolver } from "@hookform/resolvers/zod";
import { configureStore, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import gql from "graphql-tag";
import createClient from "openapi-fetch";
import { createContext, forwardRef, type ReactNode, useContext } from "react";
import { useForm } from "react-hook-form";
import { useDispatch, useSelector } from "react-redux";
import { z } from "zod";

import { DashboardChart } from "./chart";
import { loadDashboard } from "./api";
import styles from "./styles.module.css";
import { useDashboardStore } from "./store";

export interface DashboardPageProps { teamId?: string }

interface DashboardState { title: string; loading: boolean }
interface DashboardPaths {
  "/teams/{teamId}/dashboard": { get: { responses: { 200: { content: { "application/json": { title: string } } } } } };
}

const dashboardSlice = createSlice({
  name: "dashboard",
  initialState: { title: "Dashboard", loading: false } satisfies DashboardState,
  reducers: {
    setTitle(state, action: PayloadAction<string>) { state.title = action.payload; },
    setLoading(state, action: PayloadAction<boolean>) { state.loading = action.payload; }
  }
});

export const { setLoading, setTitle } = dashboardSlice.actions;
export const selectTitle = (state: { dashboard: DashboardState }) => state.dashboard.title;
export const dashboardStore = configureStore({ reducer: { dashboard: dashboardSlice.reducer } });

const dashboardSchema = z.object({
  teamId: z.string().min(1),
  title: z.string().min(3).max(80)
});
type DashboardFormValues = z.infer<typeof dashboardSchema>;

const dashboardApi = createClient<DashboardPaths>({ baseUrl: "/api" });

export const DashboardOverview = gql`
  query DashboardOverview($teamId: ID!) {
    dashboard(teamId: $teamId) { title }
  }
  fragment DashboardTitle on Dashboard { title }
`;

export const SessionContext = createContext({ userId: "anonymous" });

export const DashboardShell = forwardRef<HTMLElement, { title?: string; children: React.ReactNode }>(
  function DashboardShell({ title = "Dashboard", children }, ref) {
    return <section ref={ref} className={styles.dashboard}><h1>{title}</h1>{children}</section>;
  }
);

export const DashboardCard = forwardRef<HTMLElement, { title: string; children?: ReactNode }>(
  function DashboardCard({ title, children }, ref) {
    return <DashboardShell ref={ref} title={title}>{children}</DashboardShell>;
  }
);

export function PermissionGuard({ permission, children }: { permission: "dashboard:write"; children: ReactNode }) {
  const session = useContext(SessionContext);
  return session.userId === "anonymous" || permission !== "dashboard:write" ? null : children;
}

export function DashboardForm({ teamId }: { teamId: string }) {
  const queryClient = useQueryClient();
  const { register, handleSubmit, formState: { errors } } = useForm<DashboardFormValues>({
    resolver: zodResolver(dashboardSchema),
    defaultValues: { teamId, title: "Dashboard" }
  });
  const updateDashboard = useMutation({
    mutationKey: ["dashboard", "update"],
    mutationFn: async (values: DashboardFormValues) => dashboardApi.GET("/teams/{teamId}/dashboard", {
      params: { path: { teamId: values.teamId } }
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dashboard"] })
  });
  return (
    <PermissionGuard permission="dashboard:write">
      <form onSubmit={handleSubmit((values) => updateDashboard.mutate(values))}>
        <input {...register("title")} aria-invalid={Boolean(errors.title)} />
        <button type="submit">Save</button>
      </form>
    </PermissionGuard>
  );
}

export function DashboardPage({ teamId = "core" }: DashboardPageProps) {
  const session = useContext(SessionContext);
  const zustandSetTitle = useDashboardStore((state) => state.setTitle);
  const title = useSelector(selectTitle);
  const dispatch = useDispatch();
  const dashboardQuery = useQuery({
    queryKey: ["dashboard", teamId],
    queryFn: () => loadDashboard(teamId)
  });
  const loading = dashboardQuery.isLoading;
  const error = dashboardQuery.error;
  if (loading) return <p>Loading dashboard for {session.userId}</p>;
  if (error) return <p role="alert">{error.message}</p>;
  if (dashboardQuery.data) {
    zustandSetTitle(dashboardQuery.data.title);
    dispatch(setTitle(dashboardQuery.data.title));
  }
  return <DashboardCard title={title}><DashboardChart teamId={teamId} /><DashboardForm teamId={teamId} /></DashboardCard>;
}

export const DashboardCardDefault = {
  component: DashboardCard,
  args: { title: "Operations dashboard" },
  decorators: [(Story: () => ReactNode) => <SessionContext.Provider value={{ userId: "storybook" }}><Story /></SessionContext.Provider>]
};
