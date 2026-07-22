import { zodResolver } from "@hookform/resolvers/zod";
import { configureStore, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import gql from "graphql-tag";
import createClient from "openapi-fetch";
import { forwardRef, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { useDispatch, useSelector } from "react-redux";
import { z } from "zod";

import { loadDashboard } from "./api";
import { CardPrimitive } from "./card-primitive";

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

export const DashboardCard = forwardRef<HTMLElement, { title: string; children?: ReactNode }>(
  function DashboardCard({ title, children }, ref) {
    return <CardPrimitive ref={ref}><h2>{title}</h2>{children}</CardPrimitive>;
  }
);

export function PermissionGuard({ permission, children }: { permission: "dashboard:write"; children: ReactNode }) {
  return permission === "dashboard:write" ? children : null;
}

export function DashboardForm({ teamId }: { teamId: string }) {
  const queryClient = useQueryClient();
  const { register, handleSubmit } = useForm<DashboardFormValues>({ resolver: zodResolver(dashboardSchema), defaultValues: { teamId, title: "Dashboard" } });
  const updateDashboard = useMutation({
    mutationKey: ["dashboard", "update"],
    mutationFn: async (values: DashboardFormValues) => dashboardApi.GET("/teams/{teamId}/dashboard", {
      params: { path: { teamId: values.teamId } }
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dashboard"] })
  });
  return <PermissionGuard permission="dashboard:write"><form onSubmit={handleSubmit((values) => updateDashboard.mutate(values))}>
    <input {...register("title")} /><button type="submit">Save</button>
  </form></PermissionGuard>;
}

export function DashboardData({ teamId }: { teamId: string }) {
  const title = useSelector(selectTitle);
  const dispatch = useDispatch();
  const query = useQuery({ queryKey: ["dashboard", teamId], queryFn: () => loadDashboard(teamId) });
  if (query.data) dispatch(setTitle(query.data.title));
  return <DashboardCard title={title}><DashboardForm teamId={teamId} /></DashboardCard>;
}
