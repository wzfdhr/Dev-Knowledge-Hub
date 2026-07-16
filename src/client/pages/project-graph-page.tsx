import { useQuery } from "@tanstack/react-query";
import { Network } from "lucide-react";
import { useParams } from "react-router-dom";

import { errorMessage, type ApiClient } from "../api/client";
import { Empty, ErrorState, Loading } from "../components/ui";

export function ProjectGraphPage({ api }: { api: ApiClient }) {
  const { projectId = "" } = useParams();
  const graph = useQuery({ queryKey: ["projects", projectId, "graph"], queryFn: () => api.getProjectGraph(projectId), enabled: Boolean(projectId), retry: false });
  if (graph.isLoading) return <div className="page"><Loading label="正在加载知识图谱" /></div>;
  if (graph.error) return <div className="page"><ErrorState message={errorMessage(graph.error)} retry={() => void graph.refetch()} /></div>;
  if (!graph.data?.data) return <div className="page project-graph-page"><header className="page-header"><div><p className="eyebrow">已发布知识</p><h1>知识图谱</h1><p>完成资料导入、构建并发布后，这里会展示可追溯的模块关系。</p></div></header><Empty><span>当前没有已发布的知识图谱。</span><span className="empty-state-note">尚未发布图谱不会影响现有资料或知识版本。</span></Empty></div>;
  return <div className="page project-graph-page"><header className="page-header"><div><p className="eyebrow">已发布知识</p><h1>知识图谱</h1><p>版本 {graph.data.release?.version ?? "-"}。树中仅显示可验证事实，跨关系单独列出。</p></div></header><section className="panel"><div className="section-heading"><div><h2><Network aria-hidden="true" />模块结构</h2></div></div><pre className="graph-tree">{JSON.stringify(graph.data.data.roots, null, 2)}</pre></section><section className="panel"><h2>交叉关系</h2><pre className="graph-tree">{JSON.stringify(graph.data.data.crossLinks, null, 2)}</pre></section></div>;
}
