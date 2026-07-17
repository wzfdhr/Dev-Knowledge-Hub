import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useRef, useState } from "react";

import type { GraphLayout, PositionedGraphEdge, PositionedGraphNode } from "../features/graph/graph-view-model";

const kindLabels: Record<PositionedGraphNode["kind"], string> = {
  module: "模块",
  symbol: "符号",
  document: "文档",
  table: "表格",
  column: "字段",
  command: "命令"
};

interface KnowledgeGraphExplorerProps {
  layout: GraphLayout;
  selectedNodeId: string | null;
  selectedEdgeId?: string | null;
  onSelectNode: (nodeId: string) => void;
  onSelectEdge?: (edgeId: string) => void;
}

function isSelectionKey(key: string): boolean {
  return key === "Enter" || key === " ";
}

export function KnowledgeGraphExplorer({
  layout,
  selectedNodeId,
  selectedEdgeId = null,
  onSelectNode,
  onSelectEdge
}: KnowledgeGraphExplorerProps) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const listRefs = useRef(new Map<string, HTMLButtonElement>());

  const selectNode = (node: PositionedGraphNode) => onSelectNode(node.id);
  const selectEdge = (edge: PositionedGraphEdge) => onSelectEdge?.(edge.id);
  const moveListFocus = (nodeId: string, direction: -1 | 1) => {
    const index = layout.nodes.findIndex((node) => node.id === nodeId);
    const next = layout.nodes[Math.max(0, Math.min(layout.nodes.length - 1, index + direction))];
    listRefs.current.get(next.id)?.focus();
  };
  const resetView = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };
  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.isPrimary === false || (event.target as Element).closest('[role="button"]')) return;
    pointer.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const movePan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointer.current) return;
    const svg = event.currentTarget.querySelector("svg");
    const bounds = svg?.getBoundingClientRect();
    const scaleX = bounds?.width ? layout.width / bounds.width : 1;
    const scaleY = bounds?.height ? layout.height / bounds.height : 1;
    const delta = { x: (event.clientX - pointer.current.x) * scaleX, y: (event.clientY - pointer.current.y) * scaleY };
    pointer.current = { x: event.clientX, y: event.clientY };
    setOffset((value) => ({ x: value.x + delta.x, y: value.y + delta.y }));
  };

  return <section className="knowledge-graph-explorer" aria-label="知识图谱浏览器">
    <header className="knowledge-graph-toolbar">
      <div className="knowledge-graph-legend" aria-label="关系图例">
        <span><i className="knowledge-graph-fact" aria-hidden="true" />事实关系</span>
        <span><i className="knowledge-graph-candidate" aria-hidden="true" />候选关系</span>
      </div>
      <div className="knowledge-graph-controls" role="group" aria-label="图谱视图控制">
        <button type="button" className="icon-button" aria-label="缩小图谱" onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}><ZoomOut aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label="放大图谱" onClick={() => setZoom((value) => Math.min(2, value + 0.25))}><ZoomIn aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label="重置图谱视图" onClick={resetView}><RotateCcw aria-hidden="true" /></button>
        <span className="knowledge-graph-zoom" aria-live="polite">缩放 {Math.round(zoom * 100)}%</span>
      </div>
    </header>
    <div
      className="knowledge-graph-canvas"
      onPointerDown={startPan}
      onPointerMove={movePan}
      onPointerUp={() => { pointer.current = null; }}
      onPointerCancel={() => { pointer.current = null; }}
      onWheel={(event) => {
        event.preventDefault();
        setZoom((value) => Math.max(0.5, Math.min(2, value + (event.deltaY < 0 ? 0.1 : -0.1))));
      }}
    >
      <svg role="group" aria-label="知识图谱画布" viewBox={`0 0 ${layout.width} ${layout.height}`}>
        <g transform={`translate(${offset.x} ${offset.y})`}>
          <g transform={`scale(${zoom})`}>
          {layout.edges.map((edge) => <path
            key={edge.id}
            d={edge.path}
            className={`knowledge-graph-edge ${edge.candidate ? "candidate" : "fact"} ${selectedEdgeId === edge.id ? "selected" : ""}`}
            {...(onSelectEdge ? {
              role: "button",
              tabIndex: 0,
              "aria-label": `${edge.candidate ? "候选关系" : "事实关系"} ${edge.kind}`,
              "aria-pressed": selectedEdgeId === edge.id,
              onClick: () => selectEdge(edge),
              onKeyDown: (event: React.KeyboardEvent<SVGPathElement>) => { if (isSelectionKey(event.key)) { event.preventDefault(); selectEdge(edge); } }
            } : { "aria-hidden": true })}
            strokeDasharray={edge.candidate ? "6 5" : undefined}
          />)}
          {layout.nodes.map((node) => <g
            key={node.id}
            className={`knowledge-graph-node ${node.kind} ${node.candidate ? "candidate" : ""} ${selectedNodeId === node.id ? "selected" : ""}`}
            role="button"
            tabIndex={0}
            aria-label={`${node.name} ${kindLabels[node.kind]}`}
            aria-pressed={selectedNodeId === node.id}
            transform={`translate(${node.x} ${node.y})`}
            onClick={() => selectNode(node)}
            onKeyDown={(event) => { if (isSelectionKey(event.key)) { event.preventDefault(); selectNode(node); } }}
          >
            <rect width={node.width} height={node.height} rx="6" />
            <text x="12" y="20">{node.name}</text>
            <text x="12" y="36" className="knowledge-graph-node-kind">{kindLabels[node.kind]}</text>
          </g>)}</g>
        </g>
      </svg>
    </div>
    <div className="knowledge-graph-node-list" aria-label="图谱节点列表">
      {layout.nodes.map((node) => <button
        key={node.id}
        ref={(element) => {
          if (element) listRefs.current.set(node.id, element);
          else listRefs.current.delete(node.id);
        }}
        type="button"
        className={selectedNodeId === node.id ? "active" : ""}
        aria-label={`${node.name} ${kindLabels[node.kind]}`}
        aria-pressed={selectedNodeId === node.id}
        onClick={() => selectNode(node)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowRight") {
            event.preventDefault();
            moveListFocus(node.id, 1);
          } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
            event.preventDefault();
            moveListFocus(node.id, -1);
          }
        }}
      ><span>{node.name}</span><small>{kindLabels[node.kind]}</small></button>)}
    </div>
  </section>;
}
