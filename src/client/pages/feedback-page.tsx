import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle2, FileCode2, Hammer, MessageSquareText, RotateCw, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { errorMessage, type ApiClient } from "../api/client";
import type { Citation, Feedback } from "../api/types";
import { Empty, ErrorState, Loading, Status } from "../components/ui";
import { keys, useFeedback, useFeedbackTransition } from "../hooks/use-domain";
import type { AgentFeedbackStatus } from "../../server/persistence/store";

const filters: Array<{ value: AgentFeedbackStatus | undefined; label: string }> = [
  { value: undefined, label: "All" }, { value: "open", label: "Open" },
  { value: "acknowledged", label: "Acknowledged" }, { value: "fixed", label: "Fixed" },
  { value: "dismissed", label: "Dismissed" }
];

function Actions({ item, api }: { item: Feedback; api: ApiClient }) {
  const client = useQueryClient();
  const transition = useFeedbackTransition(api);
  const rebuild = useMutation({ mutationFn: () => api.rebuildFeedback(item.id), onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: ["feedback"] }), client.invalidateQueries({ queryKey: keys.builds })]) });
  const action = (status: AgentFeedbackStatus) => transition.mutate({ id: item.id, status });
  return <><div className="feedback-actions" role="group" aria-label="Feedback actions">
    {item.status === "open" && <button className="button primary" onClick={() => action("acknowledged")}><Check aria-hidden="true" />Acknowledge</button>}
    {["open", "acknowledged"].includes(item.status) && <button className="button" onClick={() => action("dismissed")}><XCircle aria-hidden="true" />Dismiss</button>}
    {item.status === "acknowledged" && <button className="button" onClick={() => action("fixed")}><CheckCircle2 aria-hidden="true" />Mark fixed</button>}
    {item.status === "acknowledged" && <button className="button" onClick={() => rebuild.mutate()}><RotateCw aria-hidden="true" />Request rebuild</button>}
  </div>{(transition.error || rebuild.error) && <ErrorState message={errorMessage(transition.error ?? rebuild.error)} />}{rebuild.isSuccess && <p className="success-message">Rebuild requested. It will remain unpublished until reviewed.</p>}</>;
}

export function FeedbackPage({ api }: { api: ApiClient }) {
  const [filter, setFilter] = useState<AgentFeedbackStatus | undefined>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [citation, setCitation] = useState<Citation | null>(null);
  const query = useFeedback(api, filter);
  const items = query.data?.feedback ?? [];
  useEffect(() => {
    if (selectedId && !items.some((item) => item.id === selectedId)) setSelectedId(null);
  }, [items, selectedId]);
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const source = useQuery({
    queryKey: ["feedback-source", selected?.releaseId, citation],
    queryFn: () => api.getSource({
      path: citation!.path,
      startLine: citation!.startLine,
      endLine: citation!.endLine,
      ...(selected?.releaseId ? { releaseId: selected.releaseId } : {})
    }),
    enabled: Boolean(citation && selected?.releaseId)
  });
  const grouped = filters.slice(1).map(({ value, label }) => ({ value, label, items: items.filter((item) => item.status === value) })).filter((group) => group.items.length);

  return <div className="page feedback-page">
    <header className="page-header"><div><p className="eyebrow">Human review queue</p><h1>Feedback</h1><p>Resolve reported knowledge gaps and request deliberate rebuilds.</p></div></header>
    <div className="segmented" role="group" aria-label="Filter feedback">{filters.map((item) => <button key={item.label} aria-pressed={filter === item.value} onClick={() => { setFilter(item.value); setSelectedId(null); }}>{item.label}</button>)}</div>
    <div className="feedback-layout"><section className="feedback-list" aria-label="Feedback list">{query.isLoading ? <Loading /> : query.error ? <ErrorState message={errorMessage(query.error)} retry={() => void query.refetch()} /> : items.length === 0 ? <Empty>No feedback in this view.</Empty> : (filter ? [{ value: filter, label: filters.find((item) => item.value === filter)?.label ?? filter, items }] : grouped).map((group) => <div className="feedback-group" key={group.label}><h2>{group.label}<span>{group.items.length}</span></h2>{group.items.map((item) => <button key={item.id} className={selectedId === item.id ? "active" : ""} onClick={() => setSelectedId(item.id)} aria-label={item.query}><MessageSquareText aria-hidden="true" /><span><strong>{item.query}</strong><small>{item.reason}</small></span><Status value={item.status} /></button>)}</div>)}</section>
      <section className="feedback-detail" aria-label="Feedback detail">{selected ? <><div className="section-heading"><div><p className="eyebrow">Knowledge gap</p><h2>{selected.query}</h2></div><Status value={selected.status} /></div><dl className="detail-list"><div><dt>Reason</dt><dd>{selected.reason}</dd></div><div><dt>Expected result</dt><dd>{selected.expected ?? "Not provided"}</dd></div><div><dt>Release</dt><dd className="mono">{selected.releaseId ?? "No release"}</dd></div><div><dt>Created</dt><dd>{new Date(selected.createdAt).toLocaleString()}</dd></div><div><dt>Updated</dt><dd>{new Date(selected.updatedAt).toLocaleString()}</dd></div><div><dt>Citations</dt><dd>{selected.citations.length ? <div className="citations">{selected.citations.map((item) => <button key={`${item.path}-${item.startLine}-${item.endLine}`} onClick={() => setCitation(item)} aria-label={`${item.path} lines ${item.startLine} to ${item.endLine}`}><FileCode2 aria-hidden="true" />{item.path}<span>:{item.startLine}-{item.endLine}</span></button>)}</div> : "No relevant citations were found for this query."}</dd></div></dl><Actions item={selected} api={api} />{citation && <aside className="feedback-source source-panel" aria-label="Feedback source excerpt"><header><div><p className="eyebrow">Exact source</p><h2>{citation.path}</h2></div><button className="icon-button" aria-label="Close feedback source excerpt" onClick={() => setCitation(null)}><X aria-hidden="true" /></button></header><p className="source-meta">Lines {citation.startLine}-{citation.endLine}</p>{source.isLoading ? <Loading /> : source.error ? <ErrorState message={errorMessage(source.error)} /> : source.data && <><pre><code>{source.data.content}</code></pre><dl><div><dt>Commit</dt><dd>{source.data.commitSha.slice(0, 12)}</dd></div><div><dt>Blob</dt><dd>{source.data.blobHash.slice(0, 12)}</dd></div></dl></>}</aside>}</> : <div className="document-empty"><Hammer aria-hidden="true" /><h2>Select feedback</h2><p>Choose an item to inspect its context and valid actions.</p></div>}</section></div>
  </div>;
}
