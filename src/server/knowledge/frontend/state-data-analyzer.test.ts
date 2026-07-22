import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { analyzeStateDataSource } from "./state-data-analyzer.js";

function input(content: string, path = "apps/web/src/data.ts") {
  return {
    snapshotId: "snapshot-data",
    path,
    content,
    blobHash: createHash("sha256").update(content).digest("hex"),
    packageKey: "@demo/web",
    resolutions: []
  };
}

describe("analyzeStateDataSource", () => {
  test("models Zustand and React Context stores with their fields", () => {
    const content = [
      "import { create } from 'zustand';",
      "import { createContext, useContext } from 'react';",
      "export const useDashboardStore = create((set) => ({ count: 0, loading: false, increment: () => set((state) => ({ count: state.count + 1 })) }));",
      "export const SessionContext = createContext({ userId: '' });",
      "export function useSession() { return useContext(SessionContext); }",
      "export function App() { return <SessionContext.Provider value={{ userId: 'one' }}><main /></SessionContext.Provider>; }"
    ].join("\n");
    const output = analyzeStateDataSource(input(content, "apps/web/src/data.tsx"));

    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "state_store", name: "useDashboardStore", attributes: { library: { state: "known", value: "zustand" } } }),
      expect.objectContaining({ kind: "state_field", name: "count" }),
      expect.objectContaining({ kind: "state_field", name: "loading" }),
      expect.objectContaining({ kind: "state_store", name: "SessionContext", attributes: { library: { state: "known", value: "react-context" } } })
    ]));
    expect(output.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "contains" }),
      expect.objectContaining({ kind: "injects" }),
      expect.objectContaining({ kind: "provides" })
    ]));
  });

  test("normalizes fetch and axios operations and links component consumers", () => {
    const content = [
      "import axios from 'axios';",
      "export async function loadDashboard(teamId: string) { return axios.get(`/api/teams/${teamId}/dashboard`); }",
      "export async function saveDashboard(teamId: string) { return fetch(`/api/teams/${teamId}/dashboard`, { method: 'PUT' }); }",
      "export function DashboardPage({ teamId }: { teamId: string }) {",
      "  const query = loadDashboard(teamId);",
      "  return <main>{query ? 'ready' : 'loading'}</main>;",
      "}"
    ].join("\n");
    const output = analyzeStateDataSource(input(content, "apps/web/src/dashboard.tsx"));

    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "api_operation", attributes: { method: { state: "known", value: "GET" }, path: { state: "known", value: "/api/teams/:teamId/dashboard" } } }),
      expect.objectContaining({ kind: "api_operation", attributes: { method: { state: "known", value: "PUT" }, path: { state: "known", value: "/api/teams/:teamId/dashboard" } } })
    ]));
    expect(output.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "requests" })
    ]));
  });

  test("records basic browser data channels without evaluating dynamic values", () => {
    const content = [
      "const stream = new EventSource('/api/events');",
      "const socket = new WebSocket(socketUrl);",
      "localStorage.setItem('theme', 'dark');",
      "const enabled = flags['new-dashboard'];"
    ].join("\n");
    const output = analyzeStateDataSource(input(content));
    const module = output.entities.find((entity) => entity.kind === "application_entry");

    expect(module?.facets["state-data-core"]).toMatchObject({
      browserChannels: expect.arrayContaining([
        expect.objectContaining({ kind: "sse", endpoint: "/api/events", completeness: "complete" }),
        expect.objectContaining({ kind: "websocket", completeness: "partial" }),
        expect.objectContaining({ kind: "storage", operation: "setItem", key: "theme" }),
        expect.objectContaining({ kind: "feature-flag", key: "new-dashboard" })
      ])
    });
  });

  test("follows approved Redux Toolkit and React Redux aliases", () => {
    const content = [
      "import { configureStore as buildStore, createSlice as defineSlice } from '@reduxjs/toolkit';",
      "import { useDispatch as useAppDispatch, useSelector as readStore } from 'react-redux';",
      "const counterSlice = defineSlice({ name: 'counter', initialState: { value: 0 }, reducers: { increment(state) { state.value += 1; } } });",
      "const selectValue = (state) => state.counter.value;",
      "export const store = buildStore({ reducer: { counter: counterSlice.reducer } });",
      "export function Counter() { const dispatch = useAppDispatch(); const value = readStore(selectValue); dispatch(increment()); return <b>{value}</b>; }"
    ].join("\n");
    const output = analyzeStateDataSource(input(content, "apps/web/src/counter.tsx"));

    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "state_store", name: "counterSlice", completeness: "complete" }),
      expect.objectContaining({ kind: "state_store", name: "store", completeness: "complete" }),
      expect.objectContaining({ kind: "state_field", name: "selectValue", completeness: "complete" })
    ]));
    expect(output.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "selects" }),
      expect.objectContaining({ kind: "dispatches" })
    ]));
  });

  test("follows TanStack Query aliases and proven query-client invalidation", () => {
    const content = [
      "import { useMutation as mutate, useQuery as query, useQueryClient as queryClient } from '@tanstack/react-query';",
      "export function useProjects() {",
      "  const client = queryClient();",
      "  const projects = query({ queryKey: ['projects'], queryFn: loadProjects });",
      "  const createProject = mutate({ mutationKey: ['projects', 'create'], mutationFn: saveProject, onSuccess: () => client.invalidateQueries({ queryKey: ['projects'] }) });",
      "  return { projects, createProject };",
      "}"
    ].join("\n");
    const output = analyzeStateDataSource(input(content));

    expect(output.entities.filter((entity) => entity.kind === "api_operation" && entity.completeness === "complete")).toHaveLength(2);
    expect(output.edges).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "invalidates" })]));
  });

  test("keeps a mutation without a static key schema-valid and partial", () => {
    const content = [
      "import { useMutation } from '@tanstack/react-query';",
      "export function useSaveProject() { const save = useMutation({ mutationFn: saveProject }); return save; }"
    ].join("\n");
    const output = analyzeStateDataSource(input(content));

    expect(output.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "api_operation",
        name: "save",
        completeness: "partial",
        attributes: {
          method: { state: "known", value: "MUTATION" },
          path: { state: "unknown", reason: "dynamic" }
        }
      })
    ]));
  });

  test("does not emit complete Redux or TanStack facts for spoofed local bindings", () => {
    const content = [
      "const createSlice = (options) => options;",
      "const configureStore = (options) => options;",
      "const useSelector = (selector) => selector({});",
      "const useDispatch = () => (action) => action;",
      "const useQuery = (options) => options;",
      "const useMutation = (options) => options;",
      "const useQueryClient = () => ({ invalidateQueries() {} });",
      "const fakeSlice = createSlice({ name: 'fake', initialState: { value: 0 }, reducers: { increment() {} } });",
      "const fakeStore = configureStore({ reducer: { fake: fakeSlice.reducer } });",
      "const selectValue = (state) => state.fake.value;",
      "export function Spoofed() { const client = useQueryClient(); const query = useQuery({ queryKey: ['fake'] }); const mutation = useMutation({ onSuccess: () => client.invalidateQueries({ queryKey: ['fake'] }) }); const dispatch = useDispatch(); useSelector(selectValue); dispatch(increment()); return query; }"
    ].join("\n");
    const output = analyzeStateDataSource(input(content, "apps/web/src/spoofed.tsx"));
    const deepFacts = output.entities.filter((entity) => entity.completeness === "complete" && (
      ("library" in entity.attributes && entity.attributes.library?.state === "known"
        && entity.attributes.library.value === "redux-toolkit")
      || entity.facets["state-data-core"]?.queryKind
      || ["selector", "action"].includes(String(entity.facets["state-data-core"]?.role))
    ));

    expect(deepFacts).toEqual([]);
    expect(output.edges.filter((edge) => ["selects", "dispatches", "invalidates"].includes(edge.kind))).toEqual([]);
  });
});
