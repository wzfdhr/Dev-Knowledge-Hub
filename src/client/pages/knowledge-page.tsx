import { useQuery } from "@tanstack/react-query";
import { Braces, FileCode2, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { errorMessage, type ApiClient } from "../api/client";
import type { Citation, KnowledgePageRecord } from "../api/types";
import { Empty, ErrorState, Loading } from "../components/ui";

export function KnowledgePage({ api }: { api: ApiClient }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [citation, setCitation] = useState<Citation | null>(null);
  const releases = useQuery({ queryKey: ["releases", "knowledge"], queryFn: api.listReleases, retry: false });
  const release = releases.data?.releases[0];
  const pages = useQuery({ queryKey: ["knowledge-pages", release?.id], queryFn: () => api.listKnowledgePages(release?.id), enabled: releases.isSuccess });
  const page = useQuery({ queryKey: ["knowledge-page", selectedId], queryFn: () => api.getKnowledgePage(selectedId!), enabled: Boolean(selectedId) });
  const search = useQuery({ queryKey: ["knowledge-search", query, release?.id], queryFn: () => api.searchKnowledge(query, release?.id), enabled: query.trim().length > 0 });
  const source = useQuery({ queryKey: ["source", citation], queryFn: () => api.getSource({ path: citation!.path, startLine: citation!.startLine, endLine: citation!.endLine, ...(release?.id ? { releaseId: release.id } : {}) }), enabled: Boolean(citation) });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); inputRef.current?.focus(); }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const selected: KnowledgePageRecord | undefined = page.data?.page;
  return <div className="page knowledge-page">
    <header className="page-header"><div><p className="eyebrow">Published repository intelligence</p><h1>Knowledge</h1><p>{release ? `Release ${release.version}${release.publishedAt ? "" : " · unpublished draft"}` : "No release available"}</p></div></header>
    <div className="search-box"><Search aria-hidden="true" /><label className="sr-only" htmlFor="knowledge-search">Search knowledge</label><input ref={inputRef} id="knowledge-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search symbols, modules, paths..." /><kbd>⌘ K</kbd></div>
    {query && <section className="search-results" aria-label="Search results">{search.isLoading ? <Loading label="Searching" /> : search.error ? <ErrorState message={errorMessage(search.error)} /> : search.data?.results.length ? search.data.results.map((result) => <button key={`${result.kind}-${result.title}-${result.pageId}`} onClick={() => { setSelectedId(result.pageId); setQuery(""); }}><Braces aria-hidden="true" /><span><strong>{result.title}</strong><small>{result.kind} · score {result.score}</small></span></button>) : <Empty>No results for “{query}”.</Empty>}</section>}
    <div className="knowledge-layout">
      <aside className="page-tree" aria-label="Knowledge pages"><h2>Pages</h2>{pages.isLoading ? <Loading /> : pages.error ? <ErrorState message={errorMessage(pages.error)} /> : pages.data?.pages.length ? pages.data.pages.map((item) => <button className={selectedId === item.id ? "active" : ""} key={item.id} onClick={() => setSelectedId(item.id)}><FileCode2 aria-hidden="true" />{item.title}</button>) : <Empty>{release ? "This release contains no pages." : "Publish a release to browse knowledge."}</Empty>}</aside>
      <main className="knowledge-document">{!selectedId ? <div className="document-empty"><FileCode2 aria-hidden="true" /><h2>Select a knowledge page</h2><p>Browse the page tree or search repository intelligence.</p></div> : page.isLoading ? <Loading label="Loading page" /> : page.error ? <ErrorState message={errorMessage(page.error)} /> : selected && <article><p className="eyebrow">{selected.slug}</p><h2>{selected.title}</h2><p className="lead">{selected.body}</p>{selected.chunks.map((chunk) => <section key={chunk.id}><h3>{chunk.heading ?? "Details"}</h3><p className="document-copy">{chunk.content}</p><div className="citations" aria-label="Source citations">{chunk.citations.map((item) => <button key={`${item.path}-${item.startLine}-${item.endLine}`} onClick={() => setCitation(item)} aria-label={`${item.path} lines ${item.startLine} to ${item.endLine}`}><FileCode2 aria-hidden="true" />{item.path}<span>:{item.startLine}-{item.endLine}</span></button>)}</div></section>)}</article>}</main>
      {citation && <aside className="source-panel" aria-label="Source excerpt"><header><div><p className="eyebrow">Exact source</p><h2>{citation.path}</h2></div><button className="icon-button" aria-label="Close source excerpt" onClick={() => setCitation(null)}><X aria-hidden="true" /></button></header><p className="source-meta">Lines {citation.startLine}-{citation.endLine}</p>{source.isLoading ? <Loading /> : source.error ? <ErrorState message={errorMessage(source.error)} /> : source.data && <><pre><code>{source.data.content}</code></pre><dl><div><dt>Commit</dt><dd>Commit {source.data.commitSha.slice(0, 12)}</dd></div><div><dt>Blob</dt><dd>Blob {source.data.blobHash.slice(0, 12)}</dd></div></dl></>}</aside>}
    </div>
  </div>;
}
