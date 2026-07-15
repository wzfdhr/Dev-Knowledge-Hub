import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Braces, FileCode2, GitCompare, Network, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { ACTIVE_PROJECT_STORAGE_KEY, activeProjectId, errorMessage, LIST_PAGE_SIZE, type ApiClient } from "../api/client";
import type { Citation, KnowledgePageRecord } from "../api/types";
import { Empty, ErrorState, Loading } from "../components/ui";

const qualityMessage = {
  SOURCE_MISSING: "尚未接入资料来源",
  SNAPSHOT_MISSING: "资料已接入，等待首次同步",
  BUILD_FAILED: "最近一次构建失败，需要检查原因",
  RELEASE_MISSING: "已有资料，但尚未发布知识版本",
  REBUILD_RECOMMENDED: "资料已变更，建议人工发起构建",
  PUBLISHED: "当前知识版本已发布"
} as const;

export function KnowledgePage({ api }: { api: ApiClient }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [citation, setCitation] = useState<Citation | null>(null);
  const repositoryStatus = useQuery({ queryKey: ["repository-status"], queryFn: api.getRepositoryStatus, retry: false });
  const projectId = activeProjectId();
  const quality = useQuery({ queryKey: ["project-knowledge-quality", projectId], queryFn: () => api.getProjectKnowledgeQuality(projectId!), enabled: Boolean(projectId), retry: false });
  const repositoryMissing = repositoryStatus.data?.repository === null;
  const releases = useInfiniteQuery({
    queryKey: ["releases", "knowledge"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.listReleases({ limit: LIST_PAGE_SIZE, offset: pageParam }),
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    enabled: !repositoryMissing,
    retry: false
  });
  const releaseItems = releases.data?.pages.flatMap((page) => page.releases) ?? [];
  const requestedReleaseId = searchParams.get("releaseId");
  const listedRequestedRelease = requestedReleaseId
    ? releaseItems.find((candidate) => candidate.id === requestedReleaseId)
    : undefined;
  const needsExactRelease = Boolean(
    requestedReleaseId && !listedRequestedRelease && !releases.isLoading
  );
  const exactRelease = useQuery({
    queryKey: ["release", "exact", requestedReleaseId],
    queryFn: () => api.getRelease(requestedReleaseId!),
    enabled: needsExactRelease,
    retry: false
  });
  const exactReleaseRecord = exactRelease.data?.release;
  const release = requestedReleaseId
    ? listedRequestedRelease ?? exactReleaseRecord
    : releaseItems[0];
  const selectableReleases = exactReleaseRecord
    && !releaseItems.some((candidate) => candidate.id === exactReleaseRecord.id)
    ? [exactReleaseRecord, ...releaseItems]
    : releaseItems;
  const pages = useInfiniteQuery({
    queryKey: ["knowledge-pages", release?.id],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.listKnowledgePages(release!.id, {
      limit: LIST_PAGE_SIZE,
      offset: pageParam
    }),
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    enabled: Boolean(release)
  });
  const pageItems = pages.data?.pages.flatMap((pageResult) => pageResult.pages) ?? [];
  const metadata = useQuery({
    queryKey: ["knowledge-metadata", release?.id],
    queryFn: () => api.getKnowledgeMetadata(release!.id),
    enabled: Boolean(release)
  });
  const page = useQuery({ queryKey: ["knowledge-page", selectedId], queryFn: () => api.getKnowledgePage(selectedId!), enabled: Boolean(selectedId) });
  const search = useQuery({ queryKey: ["workspace-knowledge-search", query], queryFn: () => api.searchWorkspaceKnowledge(query), enabled: Boolean(query.trim()) });
  const source = useQuery({ queryKey: ["source", citation, release?.id], queryFn: () => api.getSource({ path: citation!.path, startLine: citation!.startLine, endLine: citation!.endLine, releaseId: release!.id }), enabled: Boolean(citation && release) });

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

  useEffect(() => {
    setSelectedId(null);
    setCitation(null);
  }, [release?.id]);

  const selected: KnowledgePageRecord | undefined = page.data?.page;
  const latest = repositoryStatus.data?.latestSnapshot;
  const stale = Boolean(release && latest && (
    release.commitSha ? release.commitSha !== latest.commitSha : release.snapshotId !== latest.id
  ));
  const releaseCommit = release?.commitSha ?? release?.snapshotId ?? "unknown";
  const loading = repositoryStatus.isLoading || releases.isLoading
    || (needsExactRelease && exactRelease.isLoading);
  const blockingError = repositoryStatus.error ?? releases.error
    ?? (needsExactRelease ? exactRelease.error : null);

  if (loading) return <div className="page knowledge-page"><Loading label="正在加载版本和仓库状态" /></div>;
  if (blockingError) return <div className="page knowledge-page"><header className="page-header"><div><p className="eyebrow">仓库智能</p><h1>知识库</h1><p>无法加载版本状态。</p></div></header><ErrorState message={errorMessage(blockingError)} retry={() => {
    void repositoryStatus.refetch();
    void releases.refetch();
    if (needsExactRelease) void exactRelease.refetch();
  }} /></div>;

  if (repositoryMissing) {
    return <div className="page knowledge-page"><header className="page-header"><div><p className="eyebrow">团队知识</p><h1>知识库</h1><p>搜索已发布的团队知识；当前项目尚未接入资料来源。</p></div></header><div className="search-box"><Search aria-hidden="true" /><label className="sr-only" htmlFor="knowledge-search">搜索团队知识</label><input ref={inputRef} id="knowledge-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索全部已发布项目..." /><kbd>⌘ K</kbd></div>{query && <section className="search-results" aria-label="团队搜索结果">{search.isLoading ? <Loading label="正在搜索团队知识" /> : search.error ? <ErrorState message={errorMessage(search.error)} /> : search.data?.results.length ? search.data.results.map((result) => <button key={`${result.projectId}-${result.kind}-${result.title}-${result.pageId}`} onClick={() => { localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, result.projectId); setQuery(""); navigate(`/projects/${result.projectId}/knowledge?releaseId=${encodeURIComponent(result.releaseId)}`); }}><Braces aria-hidden="true" /><span><strong>{result.title}</strong><small>{result.projectName} · {result.matchReason} · {result.kind}</small></span></button>) : <Empty>“{query}”没有已发布且有权限访问的团队知识。</Empty>}</section>}<Empty>接入资料并完成一次构建后，当前项目知识会出现在这里。{projectId && <Link className="button primary" to={`/projects/${projectId}/imports`}>前往资料上传</Link>}</Empty></div>;
  }

  return <div className="page knowledge-page">
    <header className="page-header"><div><p className="eyebrow">团队知识</p><h1>知识库</h1><p>{release ? `版本 ${release.version}` : "搜索团队已发布知识，或在当前项目浏览版本。"}</p></div>{release && <div className="page-header-actions"><label>版本<select aria-label="知识库版本" value={release.id} onChange={(event) => setSearchParams({ releaseId: event.target.value })}>{selectableReleases.map((item) => <option key={item.id} value={item.id}>{item.version}{item.publishedAt ? "" : "（草稿）"}</option>)}</select></label>{releases.hasNextPage && <button className="button" onClick={() => void releases.fetchNextPage()} disabled={releases.isFetchingNextPage}>{releases.isFetchingNextPage ? "正在加载版本..." : "加载更多版本"}</button>}{!release.publishedAt && <span className="status status-open">未发布草稿</span>}</div>}</header>
    {!release ? <Empty>尚未创建知识版本。请审核就绪构建以创建草稿。</Empty> : <>
      {stale && <div className="notice stale-notice" role="status"><GitCompare aria-hidden="true" /><span><strong>有更新的仓库快照可用。</strong><br /><span className="mono">{releaseCommit.slice(0, 12)} → {latest!.commitSha.slice(0, 12)}</span></span></div>}
      {quality.data && <section className="metadata-band" aria-label="知识质量分析"><div><h2><GitCompare aria-hidden="true" />同步质量</h2><p>新增 {quality.data.change?.added.length ?? 0} · 修改 {quality.data.change?.modified.length ?? 0} · 删除 {quality.data.change?.deleted.length ?? 0}</p><small>{quality.data.change?.requiresBuild ? "当前快照需要人工发起知识构建" : "当前快照没有可构建的内容变化"}</small></div><div><h2><Network aria-hidden="true" />知识覆盖</h2><p>页面 {quality.data.knowledge.pageCount} · 引用 {quality.data.knowledge.citationCount}</p><small>索引文本 {quality.data.indexedTextBytes.toLocaleString()} 字节 · 符号 {metadata.data?.symbols.length ?? 0}</small></div><div><h2><Braces aria-hidden="true" />质量状态</h2><p>{quality.data.diagnostics.map((diagnostic) => qualityMessage[diagnostic.code]).join("；")}</p><small>{quality.data.remediation.open || quality.data.remediation.accepted || quality.data.remediation.rebuilding ? `质量问题：待处理 ${quality.data.remediation.open} · 已接受 ${quality.data.remediation.accepted} · 重建中 ${quality.data.remediation.rebuilding}` : "没有待处理质量问题"}{quality.data.pendingFeedbackCount ? ` · 待处理反馈 ${quality.data.pendingFeedbackCount} 条` : ""}{quality.data.change?.suggestedTests.length ? ` · 建议测试 ${quality.data.change.suggestedTests.length} 个` : ""}</small></div></section>}
      <div className="search-box"><Search aria-hidden="true" /><label className="sr-only" htmlFor="knowledge-search">搜索知识</label><input ref={inputRef} id="knowledge-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索符号、模块、路径..." /><kbd>⌘ K</kbd></div>
      {query && <section className="search-results" aria-label="团队搜索结果">{search.isLoading ? <Loading label="正在搜索团队知识" /> : search.error ? <ErrorState message={errorMessage(search.error)} /> : search.data?.results.length ? search.data.results.map((result) => <button key={`${result.projectId}-${result.kind}-${result.title}-${result.pageId}`} onClick={() => { localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, result.projectId); setQuery(""); navigate(`/projects/${result.projectId}/knowledge?releaseId=${encodeURIComponent(result.releaseId)}`); }}><Braces aria-hidden="true" /><span><strong>{result.title}</strong><small>{result.projectName} · {result.matchReason} · {result.kind}</small></span></button>) : <Empty>“{query}”没有已发布且有权限访问的团队知识。</Empty>}</section>}
      <section className="metadata-band" aria-label="代码元数据">
        {metadata.isLoading ? <Loading label="正在加载符号元数据" /> : metadata.error ? <ErrorState message={errorMessage(metadata.error)} retry={() => void metadata.refetch()} /> : <>
          <div><h2><Braces aria-hidden="true" />符号 <span>{metadata.data?.symbols.length ?? 0}</span></h2>{metadata.data?.symbols.slice(0, 12).map((symbol) => <div className="metadata-row" key={`${symbol.path}-${symbol.startLine}-${symbol.name}`}><strong>{symbol.name}</strong><small>{symbol.kind} · {symbol.path}:{symbol.startLine}-{symbol.endLine}</small></div>)}</div>
          <div><h2><Network aria-hidden="true" />依赖关系 <span>{metadata.data?.dependencies.length ?? 0}</span></h2>{metadata.data?.dependencies.slice(0, 12).map((dependency) => <div className="metadata-row" key={`${dependency.kind}-${dependency.path}-${dependency.startLine}-${dependency.endLine}-${dependency.source}-${dependency.target}`}><strong>{dependency.source} → {dependency.target}</strong><small>{dependency.kind} · {dependency.path}:{dependency.startLine}</small></div>)}</div>
        </>}
      </section>
      <div className="knowledge-layout">
        <aside className="page-tree" aria-label="知识页面"><h2>页面</h2>{pages.isLoading ? <Loading /> : pages.error ? <ErrorState message={errorMessage(pages.error)} retry={() => void pages.refetch()} /> : pageItems.length ? <>{pageItems.map((item) => <button className={selectedId === item.id ? "active" : ""} key={item.id} onClick={() => setSelectedId(item.id)}><FileCode2 aria-hidden="true" />{item.title}</button>)}{pages.hasNextPage && <button className="button continuation" onClick={() => void pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>{pages.isFetchingNextPage ? "正在加载页面..." : "加载更多页面"}</button>}</> : <Empty>此版本不包含知识页面。</Empty>}</aside>
        <main className="knowledge-document">{!selectedId ? <div className="document-empty"><FileCode2 aria-hidden="true" /><h2>选择一个知识页面</h2><p>浏览页面树或搜索仓库智能。</p></div> : page.isLoading ? <Loading label="正在加载页面" /> : page.error ? <ErrorState message={errorMessage(page.error)} /> : selected && <article><p className="eyebrow">{selected.slug}</p><h2>{selected.title}</h2><p className="lead">{selected.body}</p>{selected.chunks.map((chunk) => <section key={chunk.id}><h3>{chunk.heading ?? "详情"}</h3><p className="document-copy">{chunk.content}</p><div className="citations" aria-label="来源引用">{chunk.citations.map((item) => <button key={`${item.path}-${item.startLine}-${item.endLine}`} onClick={() => setCitation(item)} aria-label={`${item.path} 第 ${item.startLine} 至 ${item.endLine} 行`}><FileCode2 aria-hidden="true" />{item.path}<span>:{item.startLine}-{item.endLine}</span></button>)}</div></section>)}</article>}</main>
        {citation && <aside className="source-panel" aria-label="来源代码"><header><div><p className="eyebrow">精确来源</p><h2>{citation.path}</h2></div><button className="icon-button" aria-label="关闭来源代码" onClick={() => setCitation(null)}><X aria-hidden="true" /></button></header><p className="source-meta">第 {citation.startLine}-{citation.endLine} 行</p>{source.isLoading ? <Loading /> : source.error ? <ErrorState message={errorMessage(source.error)} /> : source.data && <><pre><code>{source.data.content}</code></pre><dl><div><dt>Commit</dt><dd>Commit {source.data.commitSha.slice(0, 12)}</dd></div><div><dt>Blob</dt><dd>Blob {source.data.blobHash.slice(0, 12)}</dd></div></dl></>}</aside>}
      </div>
    </>}
  </div>;
}
