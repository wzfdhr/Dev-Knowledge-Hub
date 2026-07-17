// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { GraphLayout } from "../features/graph/graph-view-model";
import { KnowledgeGraphExplorer } from "./knowledge-graph-explorer";

afterEach(cleanup);

const layout: GraphLayout = {
  width: 520,
  height: 240,
  nodes: [
    { id: "module-api", projectId: "project", snapshotId: "snapshot", kind: "module", name: "API", qualifiedName: "src/api.ts", candidate: false, sourceRefs: [], attributes: {}, x: 40, y: 40, width: 180, height: 48 },
    { id: "symbol-client", projectId: "project", snapshotId: "snapshot", kind: "symbol", name: "Client", qualifiedName: "src/api.ts.Client", candidate: false, sourceRefs: [], attributes: {}, x: 40, y: 120, width: 180, height: 48 }
  ],
  edges: [
    { id: "contains-client", fromNodeId: "module-api", toNodeId: "symbol-client", kind: "contains", candidate: false, confidence: 1, sourceRefs: [], path: "M 220 64 C 250 64, 250 144, 40 144" },
    { id: "candidate-import", fromNodeId: "module-api", toNodeId: "symbol-client", kind: "imports", candidate: true, candidateReason: "dynamic_import", confidence: 0.5, sourceRefs: [], path: "M 220 64 C 270 64, 270 144, 40 144" }
  ]
};

describe("KnowledgeGraphExplorer", () => {
  test("selects the same node from the accessible list and SVG canvas", async () => {
    const user = userEvent.setup();
    const onSelectNode = vi.fn();
    render(<KnowledgeGraphExplorer layout={layout} selectedNodeId={null} onSelectNode={onSelectNode} onSelectEdge={vi.fn()} />);

    const nodeButtons = screen.getAllByRole("button", { name: /API|Client/ });
    const listApi = nodeButtons.find((button) => button.closest(".knowledge-graph-node-list"))!;
    const svgApi = nodeButtons.find((button) => button.closest("svg"))!;

    await user.click(listApi);
    await user.click(svgApi);

    expect(onSelectNode).toHaveBeenNthCalledWith(1, "module-api");
    expect(onSelectNode).toHaveBeenNthCalledWith(2, "module-api");
  });

  test("moves list focus with arrows and selects a node with Enter", async () => {
    const user = userEvent.setup();
    const onSelectNode = vi.fn();
    render(<KnowledgeGraphExplorer layout={layout} selectedNodeId={null} onSelectNode={onSelectNode} onSelectEdge={vi.fn()} />);

    const listButtons = screen.getAllByRole("button", { name: /API|Client/ }).filter((button) => button.closest(".knowledge-graph-node-list"));
    listButtons[0].focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(listButtons[1]).toHaveFocus();
    expect(onSelectNode).toHaveBeenCalledWith("symbol-client");
  });

  test("selects edges and marks candidate relationships as dashed", async () => {
    const user = userEvent.setup();
    const onSelectEdge = vi.fn();
    render(<KnowledgeGraphExplorer layout={layout} selectedNodeId={null} onSelectNode={vi.fn()} onSelectEdge={onSelectEdge} />);

    expect(screen.getByRole("button", { name: "候选关系 imports" })).toHaveAttribute("stroke-dasharray", "6 5");
    expect(screen.getByRole("button", { name: "事实关系 contains" })).not.toHaveAttribute("stroke-dasharray");
    await user.click(screen.getByRole("button", { name: "候选关系 imports" }));
    expect(onSelectEdge).toHaveBeenCalledWith("candidate-import");
  });

  test("pans only on the canvas background and resets a changed view", async () => {
    const user = userEvent.setup();
    render(<KnowledgeGraphExplorer layout={layout} selectedNodeId={null} onSelectNode={vi.fn()} onSelectEdge={vi.fn()} />);
    const svg = screen.getByRole("group", { name: "知识图谱画布" });
    const transform = svg.querySelector("g")!;

    fireEvent.pointerDown(svg, { button: 0, isPrimary: true, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(svg, { button: 0, isPrimary: true, clientX: 50, clientY: 45 });
    expect(transform).toHaveAttribute("transform", "translate(30 15)");
    expect(screen.getByText("缩放 100%")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "放大图谱" }));
    expect(screen.getByText("缩放 125%")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重置图谱视图" }));
    expect(screen.getByText("缩放 100%")).toBeVisible();
    expect(transform).toHaveAttribute("transform", "translate(0 0)");
  });

  test("does not expose edge controls without an edge selection callback", () => {
    render(<KnowledgeGraphExplorer layout={layout} selectedNodeId={null} onSelectNode={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "候选关系 imports" })).not.toBeInTheDocument();
  });
});
