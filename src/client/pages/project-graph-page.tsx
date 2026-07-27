import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Copy, Download, FileCode2, Network, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";

import { errorMessage, type ApiClient } from "../api/client";
import type { GraphSourceRef, KnowledgeGraph, SourceExcerpt } from "../api/types";
import { KnowledgeGraphExplorer } from "../components/knowledge-graph-explorer";
import { Empty, ErrorState, Loading } from "../components/ui";
import { describeGraphReduction, filterGraph, layoutGraph } from "../features/graph/graph-view-model";

const graphKinds = ["module", "symbol", "document", "table", "column", "command"] as const;
const graphKindLabels: Record<(typeof graphKinds)[number], string> = {
  module: "模块", symbol: "符号", document: "文档", table: "表格", column: "字段", command: "命令"
};

function displayGraph(value: unknown): { family: "knowledge-v1" | "frontend-v2"; graph: KnowledgeGraph } | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as { family?: string; graph?: unknown };
  const graph = (payload.graph && typeof payload.graph === "object" ? payload.graph : value) as { snapshotId?: string; nodes?: Array<Record<string, unknown>>; edges?: Array<Record<string, unknown>> };
  if (payload.family === "frontend-v2" && graph?.nodes && graph.edges) {
    const kind = (value: unknown): KnowledgeGraph["nodes"][number]["kind"] =>
      ["route", "page", "layout", "application_entry", "workspace_package"].includes(String(value)) ? "module"
        : ["state_store", "state_field", "data_schema"].includes(String(value)) ? "table"
          : ["style_scope", "style_token"].includes(String(value)) ? "document" : "symbol";
    return {
      family: "frontend-v2",
      graph: {
        nodes: graph.nodes.map((node) => ({
          id: String(node.id), projectId: "frontend", snapshotId: String(graph.snapshotId ?? ""), kind: kind(node.kind),
          name: String(node.name), qualifiedName: String(node.qualifiedName), candidate: false,
          sourceRefs: Array.isArray(node.sourceRefs) ? node.sourceRefs as GraphSourceRef[] : [], attributes: { frontendKind: node.kind }
        })),
        edges: graph.edges.map((edge) => ({
          id: String(edge.id), fromNodeId: String(edge.fromEntityId), toNodeId: String(edge.toEntityId),
          kind: "depends_on" as const, confidence: Number(edge.confidence ?? 1),
          candidate: edge.evidenceClass === "candidate", sourceRefs: Array.isArray(edge.sourceRefs) ? edge.sourceRefs as GraphSourceRef[] : [],
          ...(edge.evidenceClass === "candidate" ? { candidateReason: String(edge.candidateReason ?? "inferred") } : {})
        })) as KnowledgeGraph["edges"]
      }
    };
  }
  if (payload.family === "knowledge-v1" && graph?.nodes && graph.edges) return { family: "knowledge-v1", graph: graph as unknown as KnowledgeGraph };
  return graph?.nodes && graph.edges ? { family: "knowledge-v1", graph: graph as unknown as KnowledgeGraph } : null;
}

function downloadExport(format: "mermaid" | "markmap", value: string): void {
  const link = document.createElement("a");
  const url = URL.createObjectURL(new Blob([value], { type: "text/plain;charset=utf-8" }));
  link.href = url;
  link.download = `knowledge-graph.${format === "mermaid" ? "mmd" : "md"}`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 0);
}

function GraphSourcePanel({ source, citation, close }: { source: UseQueryResult<SourceExcerpt, Error>; citation: GraphSourceRef; close: () => void }) {
  return <aside className="source-panel" aria-label="来源代码">
    <header><div><p className="eyebrow">精确来源</p><h2>{citation.path}</h2></div><button className="icon-button" aria-label="关闭来源代码" onClick={close}><X aria-hidden="true" /></button></header>
    <p className="source-meta">第 {citation.startLine}-{citation.endLine} 行</p>
    {source.isLoading ? <Loading /> : source.error ? <ErrorState message={errorMessage(source.error)} /> : source.data && <><pre><code>{source.data.content}</code></pre><dl><div><dt>Commit</dt><dd>Commit {source.data.commitSha.slice(0, 12)}</dd></div><div><dt>Blob</dt><dd>Blob {source.data.blobHash.slice(0, 12)}</dd></div></dl></>}
  </aside>;
}

export function ProjectGraphPage({ api }: { api: ApiClient }) {
  const { projectId = "" } = useParams();
  const [query, setQuery] = useState("");
  const [enabledKinds, setEnabledKinds] = useState<Set<(typeof graphKinds)[number]>>(() => new Set(graphKinds));
  const [includeCandidates, setIncludeCandidates] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [citation, setCitation] = useState<GraphSourceRef | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);
  const graph = useQuery({ queryKey: ["projects", projectId, "graph", "json"], queryFn: () => api.getProjectGraph(projectId, "json"), enabled: Boolean(projectId), retry: false });
  const graphValue = displayGraph(graph.data?.data);
  const source = useQuery({
    queryKey: ["graph-source", citation, graph.data?.release?.id],
    queryFn: () => api.getSource({ path: citation!.path, startLine: citation!.startLine, endLine: citation!.endLine, releaseId: graph.data!.release!.id }),
    enabled: Boolean(citation && graph.data?.release?.id),
    retry: false
  });
  const visibleGraph = useMemo(() => graphValue ? filterGraph({
    graph: graphValue.graph, query, enabledKinds, includeCandidates
  }) : null, [enabledKinds, graphValue, includeCandidates, query]);
  const layout = useMemo(() => visibleGraph ? layoutGraph(visibleGraph) : null, [visibleGraph]);
  const selectedNode = layout?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = layout?.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const selectedRefs = selectedNode?.sourceRefs ?? selectedEdge?.sourceRefs ?? [];
  const relatedEdges = selectedNode ? layout?.edges.filter((edge) => edge.fromNodeId === selectedNode.id || edge.toNodeId === selectedNode.id) ?? [] : [];
  const nodeNames = new Map(layout?.nodes.map((node) => [node.id, node.name]));

  useEffect(() => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setCitation(null);
  }, [graph.data?.release?.id]);

  useEffect(() => {
    if (!visibleGraph) return;
    const nodeIds = new Set(visibleGraph.nodes.map((node) => node.id));
    const edgeIds = new Set(visibleGraph.edges.map((edge) => edge.id));
    if (selectedNodeId && !nodeIds.has(selectedNodeId)) {
      setSelectedNodeId(null);
      setCitation(null);
    }
    if (selectedEdgeId && !edgeIds.has(selectedEdgeId)) {
      setSelectedEdgeId(null);
      setCitation(null);
    }
  }, [selectedEdgeId, selectedNodeId, visibleGraph]);

  const selectNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
    setCitation(null);
  };
  const selectEdge = (edgeId: string) => {
    setSelectedEdgeId(edgeId);
    setSelectedNodeId(null);
    setCitation(null);
  };
  const toggleKind = (kind: (typeof graphKinds)[number]) => setEnabledKinds((current) => {
    const next = new Set(current);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    return next;
  });
  const useExport = async (format: "mermaid" | "markmap", action: "copy" | "download") => {
    try {
      setExportError(null);
      setExportSuccess(null);
      const releaseId = graph.data?.release?.id;
      if (!releaseId) throw new Error("当前没有可导出的已发布知识图谱");
      const response = await api.getProjectGraph(projectId, format, { releaseId });
      if (typeof response.data !== "string") throw new Error("图谱导出内容不可用");
      if (action === "copy") {
        if (!navigator.clipboard?.writeText) throw new Error("当前浏览器不支持复制，请下载导出文件。");
        await navigator.clipboard.writeText(response.data);
      }
      else downloadExport(format, response.data);
      setExportSuccess(`${format === "mermaid" ? "Mermaid" : "Markmap"} 已${action === "copy" ? "复制到剪贴板" : "开始下载"}。`);
    } catch (error) {
      setExportError(errorMessage(error));
    }
  };

  if (graph.isLoading) return <div className="page"><Loading label="正在加载知识图谱" /></div>;
  if (graph.error) return <div className="page"><ErrorState message={errorMessage(graph.error)} retry={() => void graph.refetch()} /></div>;
  if (!graphValue) return <div className="page project-graph-page"><header className="page-header"><div><p className="eyebrow">已发布知识</p><h1>知识图谱</h1><p>完成资料导入、构建并发布 active 前端包后，这里会展示可追溯的关系。</p></div></header><Empty><span>当前没有已发布的 active 前端图谱。</span><span className="empty-state-note">尚未发布图谱不会影响现有资料或知识版本。</span></Empty></div>;
  const reduction = describeGraphReduction(visibleGraph!);
  const hasVisibleNodes = Boolean(layout?.nodes.length);
  const compactGraph = Boolean(layout && layout.nodes.length === 1 && layout.edges.length === 0);
  return <div className="page project-graph-page">
    <header className="page-header"><div><p className="eyebrow">已发布知识</p><h1>知识图谱</h1><p>版本 {graph.data?.release?.version ?? "-"}。事实关系可追溯到来源；候选关系需人工判断。</p></div></header>
    <section className="panel graph-filter-panel" aria-label="图谱筛选">
      <div className="graph-filter-query"><Search aria-hidden="true" /><label className="sr-only" htmlFor="graph-search">搜索图谱</label><input id="graph-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模块、符号、路径或命令" /></div>
      <div className="graph-kind-filters" role="group" aria-label="节点类型筛选">{graphKinds.map((kind) => <label key={kind}><input type="checkbox" checked={enabledKinds.has(kind)} onChange={() => toggleKind(kind)} />{graphKindLabels[kind]}</label>)}</div>
      <label className="graph-candidate-toggle"><input type="checkbox" checked={includeCandidates} onChange={(event) => setIncludeCandidates(event.target.checked)} />显示候选关系</label>
      <div className="graph-export-actions" role="group" aria-label="图谱导出"><button className="button" onClick={() => void useExport("mermaid", "copy")}><Copy aria-hidden="true" />复制 Mermaid</button><button className="button" onClick={() => void useExport("mermaid", "download")}><Download aria-hidden="true" />下载 Mermaid</button><button className="button" onClick={() => void useExport("markmap", "copy")}><Copy aria-hidden="true" />复制 Markmap</button><button className="button" onClick={() => void useExport("markmap", "download")}><Download aria-hidden="true" />下载 Markmap</button></div>
      <p className="graph-summary" role="status">当前筛选显示 {visibleGraph!.nodes.length}/{graphValue.graph.nodes.length} 个节点，{visibleGraph!.edges.length}/{graphValue.graph.edges.length} 条关系。</p>
      {reduction && <p className="notice graph-reduction" role="status">{reduction}</p>}
      {exportError && <ErrorState message={exportError} />}
      {exportSuccess && <p className="success-message" role="status">{exportSuccess}</p>}
    </section>
    <section className="graph-workspace" aria-label="知识图谱工作区">
      <div className="graph-main"><div className="section-heading"><div><h2><Network aria-hidden="true" />{graphValue.family === "frontend-v2" ? "前端关系图" : "旧版结构图"}</h2><p>选择节点或关系以查看来源和关联。</p></div></div>{hasVisibleNodes && layout ? <KnowledgeGraphExplorer layout={layout} compact={compactGraph} selectedNodeId={selectedNodeId} selectedEdgeId={selectedEdgeId} onSelectNode={selectNode} onSelectEdge={selectEdge} /> : <Empty>{graphValue.graph.nodes.length === 0 ? "当前发布版本没有可展示的图谱节点。" : "当前筛选条件下没有匹配的图谱节点。调整筛选或搜索条件后继续查看。"}</Empty>}</div>
      <aside className="graph-detail" aria-label="图谱详情">{selectedNode ? <><p className="eyebrow">{graphKindLabels[selectedNode.kind]}</p><h2>{selectedNode.name}</h2><dl className="detail-list"><div><dt>知识版本</dt><dd>{graph.data?.release?.version ?? "-"}</dd></div><div><dt>路径</dt><dd className="mono">{selectedNode.qualifiedName}</dd></div><div><dt>状态</dt><dd>{selectedNode.candidate ? "候选节点" : "可验证事实"}</dd></div><div><dt>关联</dt><dd>{relatedEdges.length ? relatedEdges.map((edge) => `${edge.kind} · ${nodeNames.get(edge.fromNodeId === selectedNode.id ? edge.toNodeId : edge.fromNodeId) ?? "未显示节点"}`).join("；") : "没有可见关联"}</dd></div></dl></> : selectedEdge ? <><p className="eyebrow">{selectedEdge.candidate ? "候选关系" : "事实关系"}</p><h2>{selectedEdge.kind}</h2><dl className="detail-list"><div><dt>知识版本</dt><dd>{graph.data?.release?.version ?? "-"}</dd></div><div><dt>关系</dt><dd>{nodeNames.get(selectedEdge.fromNodeId) ?? "未显示节点"} → {nodeNames.get(selectedEdge.toNodeId) ?? "未显示节点"}</dd></div><div><dt>可信度</dt><dd>{Math.round(selectedEdge.confidence * 100)}%</dd></div>{selectedEdge.candidateReason && <div><dt>匹配原因</dt><dd>{selectedEdge.candidateReason}</dd></div>}</dl></> : <div className="document-empty"><FileCode2 aria-hidden="true" /><h2>选择图谱节点</h2><p>通过画布或节点列表查看来源与关系。</p></div>}{selectedRefs.length > 0 && <div className="citations" aria-label="来源引用">{selectedRefs.map((item) => <button key={`${item.path}-${item.startLine}-${item.endLine}`} onClick={() => setCitation(item)} aria-label={`${item.path} 第 ${item.startLine} 至 ${item.endLine} 行`}><FileCode2 aria-hidden="true" />{item.path}<span>:{item.startLine}-{item.endLine}</span></button>)}</div>}</aside>
      {citation && <GraphSourcePanel source={source} citation={citation} close={() => setCitation(null)} />}
    </section>
  </div>;
}
