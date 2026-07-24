import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  graphViewport,
  type GraphLayout,
  type GraphViewportMode,
  type GraphViewportSize,
  type PositionedGraphEdge,
  type PositionedGraphNode
} from "../features/graph/graph-view-model";

const DEFAULT_CANVAS_SIZE: GraphViewportSize = { width: 960, height: 520 };
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2;

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
  compact?: boolean;
  selectedNodeId: string | null;
  selectedEdgeId?: string | null;
  onSelectNode: (nodeId: string) => void;
  onSelectEdge?: (edgeId: string) => void;
}

function isSelectionKey(key: string): boolean {
  return key === "Enter" || key === " ";
}

function pointInSvg(svg: SVGSVGElement | null, layout: GraphLayout, zoom: number, clientX: number, clientY: number) {
  if (!svg) return { x: clientX, y: clientY };
  const matrix = svg.getScreenCTM?.();
  const point = svg.createSVGPoint?.();
  if (matrix && point) {
    point.x = clientX;
    point.y = clientY;
    const transformed = point.matrixTransform(matrix.inverse());
    return { x: transformed.x / zoom, y: transformed.y / zoom };
  }
  const bounds = svg.getBoundingClientRect();
  const svgWidth = Number(svg.getAttribute("width")) || layout.width;
  const svgHeight = Number(svg.getAttribute("height")) || layout.height;
  const scale = Math.min(
    bounds.width > 0 ? bounds.width / svgWidth : 1,
    bounds.height > 0 ? bounds.height / svgHeight : 1
  );
  return {
    x: (clientX - bounds.left - Math.max(0, bounds.width - svgWidth * scale) / 2) / scale / zoom,
    y: (clientY - bounds.top - Math.max(0, bounds.height - svgHeight * scale) / 2) / scale / zoom
  };
}

export function KnowledgeGraphExplorer({
  layout,
  compact = false,
  selectedNodeId,
  selectedEdgeId = null,
  onSelectNode,
  onSelectEdge
}: KnowledgeGraphExplorerProps) {
  const [canvasSize, setCanvasSize] = useState<GraphViewportSize>(DEFAULT_CANVAS_SIZE);
  const [viewMode, setViewMode] = useState<GraphViewportMode>("readable");
  const [zoom, setZoom] = useState(() => graphViewport(layout, DEFAULT_CANVAS_SIZE, "readable").zoom);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const listRefs = useRef(new Map<string, HTMLButtonElement>());
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const syncSize = () => {
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) setCanvasSize({ width: bounds.width, height: bounds.height });
    };
    syncSize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncSize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setZoom(graphViewport(layout, canvasSize, viewMode).zoom);
    setOffset({ x: 0, y: 0 });
  }, [canvasSize, layout, viewMode]);

  useEffect(() => {
    const node = layout.nodes.find((item) => item.id === selectedNodeId);
    const canvas = canvasRef.current;
    if (!node || !canvas || canvas.clientWidth === 0 || canvas.clientHeight === 0) return;
    const width = Math.ceil(layout.width * zoom);
    const height = Math.ceil(layout.height * zoom);
    const left = node.x * zoom;
    const top = node.y * zoom;
    canvas.scrollLeft = Math.max(0, Math.min(width - canvas.clientWidth, left - (canvas.clientWidth - node.width * zoom) / 2));
    canvas.scrollTop = Math.max(0, Math.min(height - canvas.clientHeight, top - (canvas.clientHeight - node.height * zoom) / 2));
  }, [layout, selectedNodeId, zoom]);

  const selectNode = (node: PositionedGraphNode) => onSelectNode(node.id);
  const selectEdge = (edge: PositionedGraphEdge) => onSelectEdge?.(edge.id);
  const moveListFocus = (nodeId: string, direction: -1 | 1) => {
    const index = layout.nodes.findIndex((node) => node.id === nodeId);
    const next = layout.nodes[Math.max(0, Math.min(layout.nodes.length - 1, index + direction))];
    listRefs.current.get(next.id)?.focus();
  };
  const applyView = (mode: GraphViewportMode) => {
    setViewMode(mode);
    setZoom(graphViewport(layout, canvasSize, mode).zoom);
    setOffset({ x: 0, y: 0 });
    const canvas = canvasRef.current;
    if (canvas) {
      if (typeof canvas.scrollTo === "function") canvas.scrollTo({ left: 0, top: 0 });
      else {
        canvas.scrollLeft = 0;
        canvas.scrollTop = 0;
      }
    }
  };
  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.isPrimary === false || (event.target as Element).closest('[role="button"]')) return;
    pointer.current = pointInSvg(event.currentTarget.querySelector("svg"), layout, zoom, event.clientX, event.clientY);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const movePan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointer.current) return;
    const next = pointInSvg(event.currentTarget.querySelector("svg"), layout, zoom, event.clientX, event.clientY);
    const delta = { x: next.x - pointer.current.x, y: next.y - pointer.current.y };
    pointer.current = next;
    setOffset((value) => ({ x: value.x + delta.x, y: value.y + delta.y }));
  };

  const svgWidth = Math.ceil(layout.width * zoom);
  const svgHeight = Math.ceil(layout.height * zoom);

  return <section className={`knowledge-graph-explorer${compact ? " is-compact" : ""}`} aria-label="知识图谱浏览器">
    <header className="knowledge-graph-toolbar">
      <div className="knowledge-graph-legend" aria-label="关系图例">
        <span><i className="knowledge-graph-fact" aria-hidden="true" />事实关系</span>
        <span><i className="knowledge-graph-candidate" aria-hidden="true" />候选关系</span>
      </div>
      <div className="knowledge-graph-controls" role="group" aria-label="图谱视图控制">
        <button type="button" className="button graph-view-button" aria-label="适合阅读" onClick={() => applyView("readable")}>适合阅读</button>
        <button type="button" className="button graph-view-button" aria-label="查看全图" onClick={() => applyView("overview")}>查看全图</button>
        <button type="button" className="icon-button" aria-label="缩小图谱" onClick={() => setZoom((value) => Math.max(MIN_ZOOM, value - 0.25))}><ZoomOut aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label="放大图谱" onClick={() => setZoom((value) => Math.min(MAX_ZOOM, value + 0.25))}><ZoomIn aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label="重置图谱视图" onClick={() => applyView("readable")}><RotateCcw aria-hidden="true" /></button>
        <span className="knowledge-graph-zoom" aria-live="polite">缩放 {Math.round(zoom * 100)}%</span>
      </div>
    </header>
    <p className="knowledge-graph-view-note">默认按可读比例显示；可切换查看完整图谱。</p>
    <div
      ref={canvasRef}
      className="knowledge-graph-canvas"
      onPointerDown={startPan}
      onPointerMove={movePan}
      onPointerUp={() => { pointer.current = null; }}
      onPointerCancel={() => { pointer.current = null; }}
      onWheel={(event) => {
        event.preventDefault();
        setZoom((value) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value + (event.deltaY < 0 ? 0.1 : -0.1))));
      }}
    >
      <svg role="group" aria-label="知识图谱画布" width={svgWidth} height={svgHeight} viewBox={`0 0 ${svgWidth} ${svgHeight}`}>
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
