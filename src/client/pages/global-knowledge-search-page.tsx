import { useQuery } from "@tanstack/react-query";
import { BookOpenText, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { ACTIVE_PROJECT_STORAGE_KEY, errorMessage, type ApiClient } from "../api/client";
import { Empty, ErrorState, Loading } from "../components/ui";

interface RecentKnowledgeItem {
  projectId: string;
  projectName: string;
  releaseId: string;
  pageId?: string;
  title: string;
}

const recentKnowledgeKey = "devkh:recent-knowledge";

function readRecentKnowledge(): RecentKnowledgeItem[] {
  try {
    return JSON.parse(localStorage.getItem(recentKnowledgeKey) ?? "[]") as RecentKnowledgeItem[];
  } catch {
    return [];
  }
}

export function GlobalKnowledgeSearchPage({ api }: { api: ApiClient }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim();
  const results = useQuery({
    queryKey: ["workspace-knowledge-search", normalizedQuery],
    queryFn: () => api.searchWorkspaceKnowledge(normalizedQuery),
    enabled: Boolean(normalizedQuery),
    retry: false
  });
  const recent = readRecentKnowledge();

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const remember = (item: RecentKnowledgeItem) => {
    localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, item.projectId);
    const next = [item, ...readRecentKnowledge().filter((candidate) =>
      candidate.projectId !== item.projectId || candidate.pageId !== item.pageId
    )].slice(0, 8);
    localStorage.setItem(recentKnowledgeKey, JSON.stringify(next));
  };

  return <div className="page global-knowledge-search-page">
    <header className="page-header"><div><p className="eyebrow">跨项目知识</p><h1>知识搜索</h1><p>搜索所有你有权访问的已发布项目，快速回到最近查看的知识。</p></div></header>
    <div className="global-search-box"><Search aria-hidden="true" /><input ref={inputRef} type="search" aria-label="跨项目搜索" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索页面、模块、符号或路径..." /><kbd>⌘ K</kbd></div>
    {normalizedQuery ? <section className="global-search-section" aria-labelledby="workspace-search-results">
      <div className="section-heading"><div><p className="eyebrow">搜索结果</p><h2 id="workspace-search-results">“{normalizedQuery}”</h2></div></div>
      {results.isLoading ? <Loading label="正在搜索已发布知识" /> : results.error ? <ErrorState message={errorMessage(results.error)} retry={() => void results.refetch()} /> : results.data?.results.length ? <div className="global-search-results">{results.data.results.map((result) => {
        const item = { projectId: result.projectId, projectName: result.projectName, releaseId: result.releaseId, pageId: result.pageId, title: result.title };
        const href = `/projects/${result.projectId}/knowledge/pages?releaseId=${encodeURIComponent(result.releaseId)}&pageId=${encodeURIComponent(result.pageId)}`;
        return <Link key={`${result.projectId}-${result.releaseId}-${result.pageId}-${result.kind}`} to={href} onClick={() => remember(item)}><BookOpenText aria-hidden="true" /><span className="global-search-result-copy"><strong>{result.title}</strong><span>{result.excerpt}</span><small><span>{result.projectName}</span><span>{result.matchReason}</span><span>可信度 {Math.round(result.trust.score * 100)}%</span></small></span></Link>;
      })}</div> : <Empty>没有找到已发布且有权限访问的知识。</Empty>}
    </section> : <section className="global-search-section" aria-labelledby="recent-knowledge-title">
      <div className="section-heading"><div><p className="eyebrow">最近查看</p><h2 id="recent-knowledge-title">继续阅读</h2></div></div>
      {recent.length ? <div className="recent-knowledge-grid">{recent.map((item) => <Link key={`${item.projectId}-${item.pageId ?? item.releaseId}`} to={`/projects/${item.projectId}/knowledge/pages?releaseId=${encodeURIComponent(item.releaseId)}${item.pageId ? `&pageId=${encodeURIComponent(item.pageId)}` : ""}`} onClick={() => remember(item)}><BookOpenText aria-hidden="true" /><strong>{item.title}</strong><span>{item.projectName}</span></Link>)}</div> : <Empty>搜索并打开一条知识后，会在这里保留最近记录。</Empty>}
    </section>}
  </div>;
}
