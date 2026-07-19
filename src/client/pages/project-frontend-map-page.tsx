import { useQuery } from "@tanstack/react-query";
import { Activity, Boxes, FileCode2, GitBranch, Network, TestTube2, X } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router-dom";

import { errorMessage, type ApiClient } from "../api/client";
import type { GraphSourceRef } from "../api/types";
import { ComponentCatalog } from "../components/frontend-map/component-catalog";
import { DataFlow } from "../components/frontend-map/data-flow";
import { EntityCollection } from "../components/frontend-map/frontend-map-shared";
import { RouteTree } from "../components/frontend-map/route-tree";
import { ToolingTests } from "../components/frontend-map/tooling-tests";
import { VisualizationCatalog } from "../components/frontend-map/visualization-catalog";
import { Empty, ErrorState, Loading } from "../components/ui";

const views = [
  ["overview", "概览"], ["routes", "路由与页面"], ["components", "组件与设计系统"],
  ["data", "状态与数据"], ["visualizations", "可视化"], ["tooling", "构建与测试"]
] as const;
type View = (typeof views)[number][0];

export function ProjectFrontendMapPage({ api }: { api: ApiClient }) {
  const { projectId = "" } = useParams();
  const [view, setView] = useState<View>("overview");
  const [citation, setCitation] = useState<GraphSourceRef | null>(null);
  const preview = useQuery({ queryKey: ["projects", projectId, "frontend-preview"], queryFn: () => api.getProjectFrontendPreview(projectId), enabled: Boolean(projectId), retry: false });
  const source = useQuery({
    queryKey: ["projects", projectId, "frontend-preview-source", preview.data?.preview?.build.id, citation],
    queryFn: () => api.getProjectFrontendPreviewSource(projectId, preview.data!.preview!.build.id, citation!),
    enabled: Boolean(citation && preview.data?.preview), retry: false
  });
  if (preview.isLoading) return <div className="page"><Loading label="正在加载 React 前端地图" /></div>;
  if (preview.error) return <div className="page"><ErrorState message={errorMessage(preview.error)} retry={() => void preview.refetch()} /></div>;
  if (!preview.data || preview.data.status !== "ready") {
    const message = preview.data?.status === "source_missing" ? "当前项目尚未接入资料来源。" : preview.data?.status === "build_missing" ? "资料已接入，但还没有可预览的构建。" : "最新影子构建尚未完成 candidate package。";
    return <div className="page frontend-map-page"><header className="page-header"><div><p className="eyebrow">管理员影子预览</p><h1>React 前端地图</h1><p>正式知识版本和 MCP 均未改变。</p></div></header><Empty>{message}</Empty></div>;
  }
  const data = preview.data.preview;
  const panel = view === "routes" ? <RouteTree preview={data} onOpenSource={setCitation} />
    : view === "components" ? <ComponentCatalog preview={data} onOpenSource={setCitation} />
      : view === "data" ? <DataFlow preview={data} onOpenSource={setCitation} />
        : view === "visualizations" ? <VisualizationCatalog preview={data} onOpenSource={setCitation} />
          : view === "tooling" ? <ToolingTests preview={data} onOpenSource={setCitation} />
            : <><section className="frontend-map-overview" aria-label="前端地图概览">
              <div><Boxes aria-hidden="true" /><span><small>实体</small><strong>{data.quality.summary.entities}</strong></span></div>
              <div><Network aria-hidden="true" /><span><small>事实关系</small><strong>{data.quality.summary.factEdges}</strong></span></div>
              <div><GitBranch aria-hidden="true" /><span><small>路由</small><strong>{data.quality.summary.routes}</strong></span></div>
              <div><TestTube2 aria-hidden="true" /><span><small>测试组件</small><strong>{data.quality.summary.testedComponents}/{data.quality.summary.components}</strong></span></div>
              <div><Activity aria-hidden="true" /><span><small>知识页 / 问题</small><strong>{data.validation.pageCount}/{data.quality.issues.length}</strong></span></div>
            </section><EntityCollection title="应用与工作区" description="应用入口、workspace package 与构建边界。" entities={data.graph.nodes.filter((entity) => ["application_entry", "workspace_package"].includes(entity.kind))} preview={data} onOpenSource={setCitation} /></>;
  return <div className="page frontend-map-page">
    <header className="page-header"><div><p className="eyebrow">管理员影子预览</p><h1>React 前端地图</h1><p>构建 {data.build.id.slice(0, 8)} · {data.validation.valid ? "引用校验通过" : "引用校验未通过"}。此页面不改变正式发布。</p></div></header>
    <nav className="frontend-map-tabs" role="tablist" aria-label="前端地图视图">{views.map(([key, label]) => <button key={key} role="tab" aria-selected={view === key} onClick={() => { setView(key); setCitation(null); }}>{label}</button>)}</nav>
    {panel}
    {citation && <aside className="frontend-preview-source" aria-label="候选构建来源代码"><header><div><p className="eyebrow">候选快照来源</p><h2>{citation.path}</h2></div><button className="icon-button" aria-label="关闭来源代码" onClick={() => setCitation(null)}><X aria-hidden="true" /></button></header><p>第 {citation.startLine}-{citation.endLine} 行</p>{source.isLoading ? <Loading /> : source.error ? <ErrorState message={errorMessage(source.error)} /> : source.data ? <pre><code>{source.data.content}</code></pre> : <div className="document-empty"><FileCode2 aria-hidden="true" /></div>}</aside>}
  </div>;
}
