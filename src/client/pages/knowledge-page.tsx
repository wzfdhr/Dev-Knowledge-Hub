import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCode2, GitCompare, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { activeProjectId, errorMessage, LIST_PAGE_SIZE, type ApiClient } from "../api/client";
import type { Citation, KnowledgePageRecord } from "../api/types";
import { Empty, ErrorState, Loading } from "../components/ui";
import { canUseProjectPrimaryAction, projectPrimaryAction } from "../features/project-lifecycle";

export function KnowledgePage({ api }: { api: ApiClient }) {
  const params = useParams();
  const projectId = params.projectId ?? activeProjectId();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const publishStatusRef = useRef<HTMLParagraphElement>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [citation, setCitation] = useState<Citation | null>(null);
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => api.session!(),
    enabled: typeof api.session === "function",
    retry: false
  });
  const projectMembers = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: () => api.listProjectMembers(projectId!),
    enabled: Boolean(projectId && session.data && typeof api.listProjectMembers === "function"),
    retry: false
  });
  const repositoryStatus = useQuery({ queryKey: ["repository-status"], queryFn: api.getRepositoryStatus, retry: false });
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
  const publish = useMutation({
    mutationFn: (releaseId: string) => api.publishRelease(releaseId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["releases", "knowledge"] });
      await releases.refetch();
    }
  });
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
  const page = useQuery({ queryKey: ["knowledge-page", selectedId], queryFn: () => api.getKnowledgePage(selectedId!), enabled: Boolean(selectedId) });
  const search = useQuery({ queryKey: ["project-knowledge-search", release?.id, query], queryFn: () => api.searchKnowledge(query, release?.id), enabled: Boolean(query.trim() && release) });
  const source = useQuery({ queryKey: ["source", citation, release?.id], queryFn: () => api.getSource({ path: citation!.path, startLine: citation!.startLine, endLine: citation!.endLine, releaseId: release!.id }), enabled: Boolean(citation && release) });
  const usesPermissionApi = typeof api.session === "function" && typeof api.listProjectMembers === "function";
  const projectRole = projectMembers.data?.members.find((member) => member.id === session.data?.admin.id)?.role;
  const canPublishDraft = !usesPermissionApi || canUseProjectPrimaryAction(
    projectPrimaryAction("draft-review"),
    session.data?.admin.role,
    projectRole
  );

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

  const requestedPageId = searchParams.get("pageId");
  useEffect(() => {
    setSelectedId(requestedPageId);
    setCitation(null);
  }, [release?.id, requestedPageId]);
  const firstPageId = pageItems[0]?.id;
  useEffect(() => {
    if (!requestedPageId && !selectedId && firstPageId && release) {
      setSelectedId(firstPageId);
      setSearchParams({ releaseId: release.id, pageId: firstPageId }, { replace: true });
    }
  }, [firstPageId, release?.id, requestedPageId, selectedId, setSearchParams]);
  useEffect(() => {
    if (publish.isSuccess) publishStatusRef.current?.focus();
  }, [publish.isSuccess]);

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
  if (blockingError) return <div className="page knowledge-page"><header className="page-header"><div><p className="eyebrow">项目知识</p><h1>知识资料</h1><p>无法加载版本状态。</p></div></header><ErrorState message={errorMessage(blockingError)} retry={() => {
    void repositoryStatus.refetch();
    void releases.refetch();
    if (needsExactRelease) void exactRelease.refetch();
  }} /></div>;

  if (repositoryMissing) {
    return <div className="page knowledge-page"><header className="page-header"><div><p className="eyebrow">项目知识</p><h1>知识资料</h1><p>当前项目尚未接入资料来源。</p></div></header><Empty><span>接入资料并完成一次构建后，项目知识会出现在这里。</span><span className="empty-state-note">尚未接入资料不会影响其他项目或已发布版本。</span>{projectId && <Link className="button primary" to={`/projects/${projectId}/sources`}>接入资料</Link>}</Empty></div>;
  }

  return <div className="page knowledge-page">
    <header className="page-header"><div><p className="eyebrow">团队知识</p><h1>知识资料</h1><p>{release ? `版本 ${release.version}` : "浏览当前项目的页面、正文与精确来源。"}</p></div>{release && <div className="page-header-actions"><label>版本<select aria-label="知识库版本" value={release.id} onChange={(event) => setSearchParams({ releaseId: event.target.value })}>{selectableReleases.map((item) => <option key={item.id} value={item.id}>{item.version}{item.publishedAt ? "" : "（草稿）"}</option>)}</select></label>{releases.hasNextPage && <button className="button" onClick={() => void releases.fetchNextPage()} disabled={releases.isFetchingNextPage}>{releases.isFetchingNextPage ? "正在加载版本..." : "加载更多版本"}</button>}{!release.publishedAt && !publish.isSuccess && <span className="status status-open">未发布草稿</span>}</div>}</header>
    {release && !release.publishedAt && !publish.isSuccess && projectId && <section className="draft-review-bar" aria-label="草稿审核"><div><span className="status status-open">草稿审核</span><strong>版本 {release.version} · 未发布</strong><small>{canPublishDraft ? "当前正式知识尚未变化；确认正文和来源后再发布。" : "你拥有只读权限，可审核正文和来源，但不能发布版本。"}</small></div><div><Link className="button" to={`/projects/${projectId}/production`}>返回知识生产</Link>{canPublishDraft && <button className="button primary" onClick={() => publish.mutate(release.id)} disabled={publish.isPending}>{publish.isPending ? "正在发布..." : "发布版本"}</button>}</div></section>}
    {publish.isSuccess && <p ref={publishStatusRef} tabIndex={-1} className="success-message" role="status">版本已发布，正式知识已更新。</p>}
    {publish.error && <ErrorState message={errorMessage(publish.error)} retry={() => release && publish.mutate(release.id)} />}
    {!release ? <Empty><span>尚未创建知识版本。请审核就绪构建以创建草稿。</span><span className="empty-state-note">资料和构建记录已安全保留；创建草稿不会自动发布。</span></Empty> : <>
      {stale && <div className="notice stale-notice" role="status"><GitCompare aria-hidden="true" /><span><strong>有更新的仓库快照可用。</strong><br /><span className="mono">{releaseCommit.slice(0, 12)} → {latest!.commitSha.slice(0, 12)}</span></span></div>}
      <div className="search-box"><Search aria-hidden="true" /><label className="sr-only" htmlFor="knowledge-search">搜索知识</label><input ref={inputRef} id="knowledge-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索符号、模块、路径..." /><kbd>⌘ K</kbd></div>
      {query && <section className="search-results" aria-label="项目搜索结果">{search.isLoading ? <Loading label="正在搜索当前项目" /> : search.error ? <ErrorState message={errorMessage(search.error)} /> : search.data?.results.length ? search.data.results.map((result) => <button key={`${result.kind}-${result.title}-${result.pageId}`} onClick={() => { setSelectedId(result.pageId); setQuery(""); setSearchParams({ releaseId: release.id, pageId: result.pageId }); }}><FileCode2 aria-hidden="true" /><span><strong>{result.title}</strong><small>{result.matchReason} · {result.kind} · 可信度 {Math.round(result.trust.score * 100)}%</small></span></button>) : <Empty>“{query}”没有匹配的项目知识。</Empty>}</section>}
      <div className="knowledge-layout">
        <aside className="page-tree" aria-label="知识页面"><h2>页面</h2>{pages.isLoading ? <Loading /> : pages.error ? <ErrorState message={errorMessage(pages.error)} retry={() => void pages.refetch()} /> : pageItems.length ? <>{pageItems.map((item) => <button className={selectedId === item.id ? "active" : ""} key={item.id} onClick={() => { setSelectedId(item.id); setSearchParams({ releaseId: release.id, pageId: item.id }); }}><FileCode2 aria-hidden="true" />{item.title}</button>)}{pages.hasNextPage && <button className="button continuation" onClick={() => void pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>{pages.isFetchingNextPage ? "正在加载页面..." : "加载更多页面"}</button>}</> : <Empty>此版本不包含知识页面。</Empty>}</aside>
        <main className="knowledge-document">{!selectedId ? <div className="document-empty"><FileCode2 aria-hidden="true" /><h2>选择一个知识页面</h2><p>浏览页面树或搜索仓库智能。</p></div> : page.isLoading ? <Loading label="正在加载页面" /> : page.error ? <ErrorState message={errorMessage(page.error)} /> : selected && <article><p className="eyebrow">{selected.slug}</p><h2>{selected.title}</h2><p className="lead">{selected.body}</p>{selected.chunks.map((chunk) => <section key={chunk.id}><h3>{chunk.heading ?? "详情"}</h3><p className="document-copy">{chunk.content}</p><div className="citations" aria-label="来源引用">{chunk.citations.map((item) => <button key={`${item.path}-${item.startLine}-${item.endLine}`} onClick={() => setCitation(item)} aria-label={`${item.path} 第 ${item.startLine} 至 ${item.endLine} 行`}><FileCode2 aria-hidden="true" />{item.path}<span>:{item.startLine}-{item.endLine}</span></button>)}</div></section>)}</article>}</main>
        {citation && <aside className="source-panel" aria-label="来源代码"><header><div><p className="eyebrow">精确来源</p><h2>{citation.path}</h2></div><button className="icon-button" aria-label="关闭来源代码" onClick={() => setCitation(null)}><X aria-hidden="true" /></button></header><p className="source-meta">第 {citation.startLine}-{citation.endLine} 行</p>{source.isLoading ? <Loading /> : source.error ? <ErrorState message={errorMessage(source.error)} /> : source.data && <><pre><code>{source.data.content}</code></pre><dl><div><dt>Commit</dt><dd>Commit {source.data.commitSha.slice(0, 12)}</dd></div><div><dt>Blob</dt><dd>Blob {source.data.blobHash.slice(0, 12)}</dd></div></dl></>}</aside>}
      </div>
    </>}
  </div>;
}
