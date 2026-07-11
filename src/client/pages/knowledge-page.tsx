import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Braces, FileCode2, GitCompare, Network, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { errorMessage, LIST_PAGE_SIZE, type ApiClient } from "../api/client";
import type { Citation, KnowledgePageRecord } from "../api/types";
import { Empty, ErrorState, Loading } from "../components/ui";

export function KnowledgePage({ api }: { api: ApiClient }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [citation, setCitation] = useState<Citation | null>(null);
  const repositoryStatus = useQuery({ queryKey: ["repository-status"], queryFn: api.getRepositoryStatus, retry: false });
  const releases = useInfiniteQuery({
    queryKey: ["releases", "knowledge"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.listReleases({ limit: LIST_PAGE_SIZE, offset: pageParam }),
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
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
  const search = useQuery({ queryKey: ["knowledge-search", query, release?.id], queryFn: () => api.searchKnowledge(query, release?.id), enabled: Boolean(release && query.trim()) });
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

  if (loading) return <div className="page knowledge-page"><Loading label="Loading release and repository state" /></div>;
  if (blockingError) return <div className="page knowledge-page"><header className="page-header"><div><p className="eyebrow">Repository intelligence</p><h1>Knowledge</h1><p>Release state could not be loaded.</p></div></header><ErrorState message={errorMessage(blockingError)} retry={() => { void repositoryStatus.refetch(); void releases.refetch(); }} /></div>;

  return <div className="page knowledge-page">
    <header className="page-header"><div><p className="eyebrow">Repository intelligence</p><h1>Knowledge</h1><p>{release ? `Release ${release.version}` : "No release available"}</p></div>{release && <div className="page-header-actions"><label>Release<select aria-label="Knowledge release" value={release.id} onChange={(event) => setSearchParams({ releaseId: event.target.value })}>{selectableReleases.map((item) => <option key={item.id} value={item.id}>{item.version}{item.publishedAt ? "" : " (draft)"}</option>)}</select></label>{releases.hasNextPage && <button className="button" onClick={() => void releases.fetchNextPage()} disabled={releases.isFetchingNextPage}>{releases.isFetchingNextPage ? "Loading releases..." : "Load more releases"}</button>}{!release.publishedAt && <span className="status status-open">Unpublished draft</span>}</div>}</header>
    {!release ? <Empty>No knowledge release has been created. Review a ready build to create a draft.</Empty> : <>
      {stale && <div className="notice stale-notice" role="status"><GitCompare aria-hidden="true" /><span><strong>A newer repository snapshot is available.</strong><br /><span className="mono">{releaseCommit.slice(0, 12)} → {latest!.commitSha.slice(0, 12)}</span></span></div>}
      <div className="search-box"><Search aria-hidden="true" /><label className="sr-only" htmlFor="knowledge-search">Search knowledge</label><input ref={inputRef} id="knowledge-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search symbols, modules, paths..." /><kbd>⌘ K</kbd></div>
      {query && <section className="search-results" aria-label="Search results">{search.isLoading ? <Loading label="Searching" /> : search.error ? <ErrorState message={errorMessage(search.error)} /> : search.data?.results.length ? search.data.results.map((result) => <button key={`${result.kind}-${result.title}-${result.pageId}`} onClick={() => { setSelectedId(result.pageId); setQuery(""); }}><Braces aria-hidden="true" /><span><strong>{result.title}</strong><small>{result.kind} · score {result.score}</small></span></button>) : <Empty>No results for “{query}”.</Empty>}</section>}
      <section className="metadata-band" aria-label="Code metadata">
        {metadata.isLoading ? <Loading label="Loading symbol metadata" /> : metadata.error ? <ErrorState message={errorMessage(metadata.error)} retry={() => void metadata.refetch()} /> : <>
          <div><h2><Braces aria-hidden="true" />Symbols <span>{metadata.data?.symbols.length ?? 0}</span></h2>{metadata.data?.symbols.slice(0, 12).map((symbol) => <div className="metadata-row" key={`${symbol.path}-${symbol.startLine}-${symbol.name}`}><strong>{symbol.name}</strong><small>{symbol.kind} · {symbol.path}:{symbol.startLine}-{symbol.endLine}</small></div>)}</div>
          <div><h2><Network aria-hidden="true" />Dependencies <span>{metadata.data?.dependencies.length ?? 0}</span></h2>{metadata.data?.dependencies.slice(0, 12).map((dependency) => <div className="metadata-row" key={`${dependency.path}-${dependency.startLine}-${dependency.source}-${dependency.target}`}><strong>{dependency.source} → {dependency.target}</strong><small>{dependency.kind} · {dependency.path}:{dependency.startLine}</small></div>)}</div>
        </>}
      </section>
      <div className="knowledge-layout">
        <aside className="page-tree" aria-label="Knowledge pages"><h2>Pages</h2>{pages.isLoading ? <Loading /> : pages.error ? <ErrorState message={errorMessage(pages.error)} retry={() => void pages.refetch()} /> : pageItems.length ? <>{pageItems.map((item) => <button className={selectedId === item.id ? "active" : ""} key={item.id} onClick={() => setSelectedId(item.id)}><FileCode2 aria-hidden="true" />{item.title}</button>)}{pages.hasNextPage && <button className="button continuation" onClick={() => void pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>{pages.isFetchingNextPage ? "Loading pages..." : "Load more pages"}</button>}</> : <Empty>This release contains no pages.</Empty>}</aside>
        <main className="knowledge-document">{!selectedId ? <div className="document-empty"><FileCode2 aria-hidden="true" /><h2>Select a knowledge page</h2><p>Browse the page tree or search repository intelligence.</p></div> : page.isLoading ? <Loading label="Loading page" /> : page.error ? <ErrorState message={errorMessage(page.error)} /> : selected && <article><p className="eyebrow">{selected.slug}</p><h2>{selected.title}</h2><p className="lead">{selected.body}</p>{selected.chunks.map((chunk) => <section key={chunk.id}><h3>{chunk.heading ?? "Details"}</h3><p className="document-copy">{chunk.content}</p><div className="citations" aria-label="Source citations">{chunk.citations.map((item) => <button key={`${item.path}-${item.startLine}-${item.endLine}`} onClick={() => setCitation(item)} aria-label={`${item.path} lines ${item.startLine} to ${item.endLine}`}><FileCode2 aria-hidden="true" />{item.path}<span>:{item.startLine}-{item.endLine}</span></button>)}</div></section>)}</article>}</main>
        {citation && <aside className="source-panel" aria-label="Source excerpt"><header><div><p className="eyebrow">Exact source</p><h2>{citation.path}</h2></div><button className="icon-button" aria-label="Close source excerpt" onClick={() => setCitation(null)}><X aria-hidden="true" /></button></header><p className="source-meta">Lines {citation.startLine}-{citation.endLine}</p>{source.isLoading ? <Loading /> : source.error ? <ErrorState message={errorMessage(source.error)} /> : source.data && <><pre><code>{source.data.content}</code></pre><dl><div><dt>Commit</dt><dd>Commit {source.data.commitSha.slice(0, 12)}</dd></div><div><dt>Blob</dt><dd>Blob {source.data.blobHash.slice(0, 12)}</dd></div></dl></>}</aside>}
      </div>
    </>}
  </div>;
}
