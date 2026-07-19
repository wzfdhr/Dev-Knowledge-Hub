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
});
