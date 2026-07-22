import { zodResolver } from "@hookform/resolvers/zod";
import { configureStore, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import gql from "graphql-tag";
import createClient from "openapi-fetch";
import { forwardRef, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { useDispatch, useSelector } from "react-redux";
import { z } from "zod";

import { AnalyticsPrimitive } from "./analytics-primitive";

interface AnalyticsState { summary: string }
interface AnalyticsPaths {
  "/accounts/{accountId}/analytics": { get: { responses: { 200: { content: { "application/json": { summary: string } } } } } };
}

const analyticsSlice = createSlice({
  name: "analytics",
  initialState: { summary: "" } satisfies AnalyticsState,
  reducers: {
    setSummary(state, action: PayloadAction<string>) { state.summary = action.payload; }
  }
});

export const { setSummary } = analyticsSlice.actions;
export const selectSummary = (state: { analytics: AnalyticsState }) => state.analytics.summary;
export const analyticsStore = configureStore({ reducer: { analytics: analyticsSlice.reducer } });

const analyticsSchema = z.object({ accountId: z.string().min(1) });
type AnalyticsFormValues = z.infer<typeof analyticsSchema>;
const analyticsApi = createClient<AnalyticsPaths>({ baseUrl: "/api" });

export const AnalyticsOverview = gql`
  query AnalyticsOverview($accountId: ID!) { analytics(accountId: $accountId) { summary } }
`;

export const AnalyticsCard = forwardRef<HTMLElement, { children?: ReactNode }>(
  function AnalyticsCard({ children }, ref) {
    return <AnalyticsPrimitive ref={ref}>{children}</AnalyticsPrimitive>;
  }
);

export function AnalyticsPermissionGuard({ permission, children }: { permission: "analytics:read"; children: ReactNode }) {
  return permission === "analytics:read" ? children : null;
}

export function AnalyticsFilterForm() {
  const queryClient = useQueryClient();
  const { register, handleSubmit } = useForm<AnalyticsFormValues>({ resolver: zodResolver(analyticsSchema) });
  const refresh = useMutation({
    mutationKey: ["analytics", "refresh"],
    mutationFn: async (values: AnalyticsFormValues) => analyticsApi.GET("/accounts/{accountId}/analytics", {
      params: { path: { accountId: values.accountId } }
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["analytics"] })
  });
  return <AnalyticsPermissionGuard permission="analytics:read"><form onSubmit={handleSubmit((values) => refresh.mutate(values))}>
    <input {...register("accountId")} /><button type="submit">Refresh</button>
  </form></AnalyticsPermissionGuard>;
}

export function AnalyticsData({ accountId }: { accountId: string }) {
  const summary = useSelector(selectSummary);
  const dispatch = useDispatch();
  const query = useQuery({
    queryKey: ["analytics", accountId],
    queryFn: () => analyticsApi.GET("/accounts/{accountId}/analytics", { params: { path: { accountId } } })
  });
  if (query.data?.data) dispatch(setSummary(query.data.data.summary));
  return <AnalyticsCard><p>{summary}</p><AnalyticsFilterForm /></AnalyticsCard>;
}
