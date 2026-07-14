import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle2, FileCode2, Hammer, MessageSquareText, RotateCw, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { errorMessage, type ApiClient } from "../api/client";
import type { Citation, Feedback } from "../api/types";
import { Empty, ErrorState, Loading, Status } from "../components/ui";
import { keys, useFeedback, useFeedbackTransition } from "../hooks/use-domain";
import type { AgentFeedbackStatus } from "../../server/persistence/store";

const filters: Array<{ value: AgentFeedbackStatus | undefined; label: string }> = [
  { value: undefined, label: "全部" }, { value: "open", label: "待处理" },
  { value: "acknowledged", label: "已确认" }, { value: "fixed", label: "已修复" },
  { value: "dismissed", label: "已忽略" }
];

function Actions({ item, api }: { item: Feedback; api: ApiClient }) {
  const client = useQueryClient();
  const transition = useFeedbackTransition(api);
  const rebuild = useMutation({ mutationFn: () => api.rebuildFeedback(item.id), onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: ["feedback"] }), client.invalidateQueries({ queryKey: keys.builds })]) });
  const action = (status: AgentFeedbackStatus) => transition.mutate({ id: item.id, status });
  return <><div className="feedback-actions" role="group" aria-label="反馈操作">
    {item.status === "open" && <button className="button primary" onClick={() => action("acknowledged")}><Check aria-hidden="true" />确认处理</button>}
    {["open", "acknowledged"].includes(item.status) && <button className="button" onClick={() => action("dismissed")}><XCircle aria-hidden="true" />忽略</button>}
    {item.status === "acknowledged" && <button className="button" onClick={() => action("fixed")}><CheckCircle2 aria-hidden="true" />标记为已修复</button>}
    {item.status === "acknowledged" && <button className="button" onClick={() => rebuild.mutate()}><RotateCw aria-hidden="true" />请求重新构建</button>}
  </div>{(transition.error || rebuild.error) && <ErrorState message={errorMessage(transition.error ?? rebuild.error)} />}{rebuild.isSuccess && <p className="success-message">已请求重新构建，审核前不会发布。</p>}</>;
}

export function FeedbackPage({ api }: { api: ApiClient }) {
  const [filter, setFilter] = useState<AgentFeedbackStatus | undefined>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [citationSelection, setCitationSelection] = useState<{
    citation: Citation; feedbackId: string; releaseId: string | null;
  } | null>(null);
  const query = useFeedback(api, filter);
  const items = query.data?.pages.flatMap((page) => page.feedback) ?? [];
  useEffect(() => {
    if (selectedId && !items.some((item) => item.id === selectedId)) {
      setSelectedId(null);
      setCitationSelection(null);
    }
  }, [items, selectedId]);
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const citationContextMatches = Boolean(
    citationSelection && selected?.id === citationSelection.feedbackId
      && selected.releaseId === citationSelection.releaseId
  );
  const citation = citationContextMatches ? citationSelection!.citation : null;
  const source = useQuery({
    queryKey: ["feedback-source", citationSelection?.releaseId, citation],
    queryFn: () => api.getSource({
      path: citation!.path,
      startLine: citation!.startLine,
      endLine: citation!.endLine,
      ...(citationSelection?.releaseId ? { releaseId: citationSelection.releaseId } : {})
    }),
    enabled: Boolean(citation && citationSelection?.releaseId)
  });
  const selectFeedback = (id: string) => {
    setCitationSelection(null);
    setSelectedId(id);
  };
  const selectFilter = (value: AgentFeedbackStatus | undefined) => {
    setCitationSelection(null);
    setSelectedId(null);
    setFilter(value);
  };
  const grouped = filters.slice(1).map(({ value, label }) => ({ value, label, items: items.filter((item) => item.status === value) })).filter((group) => group.items.length);

  return <div className="page feedback-page">
    <header className="page-header"><div><p className="eyebrow">人工审核队列</p><h1>反馈</h1><p>处理报告的知识缺口，并主动请求重新构建。</p></div></header>
    <div className="segmented" role="group" aria-label="筛选反馈">{filters.map((item) => <button key={item.label} aria-pressed={filter === item.value} onClick={() => selectFilter(item.value)}>{item.label}</button>)}</div>
    <div className="feedback-layout"><section className="feedback-list" aria-label="反馈列表">{query.isLoading ? <Loading /> : query.error ? <ErrorState message={errorMessage(query.error)} retry={() => void query.refetch()} /> : items.length === 0 ? <Empty>当前没有来自可访问项目的反馈。</Empty> : (filter ? [{ value: filter, label: filters.find((item) => item.value === filter)?.label ?? filter, items }] : grouped).map((group) => <div className="feedback-group" key={group.label}><h2>{group.label}<span>{group.items.length}</span></h2>{group.items.map((item) => <button key={item.id} className={selectedId === item.id ? "active" : ""} onClick={() => selectFeedback(item.id)} aria-label={item.query}><MessageSquareText aria-hidden="true" /><span><strong>{item.query}</strong><small>{item.projectName} · {item.releaseVersion}</small><small>{item.reason}</small></span><Status value={item.status} /></button>)}</div>)}{query.hasNextPage && <button className="button continuation full" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? "正在加载反馈..." : "加载更多反馈"}</button>}</section>
      <section className="feedback-detail" aria-label="反馈详情">{selected ? <><div className="section-heading"><div><p className="eyebrow">{selected.projectName} · {selected.releaseVersion}</p><h2>{selected.query}</h2></div><Status value={selected.status} /></div><dl className="detail-list"><div><dt>原因</dt><dd>{selected.reason}</dd></div><div><dt>期望结果</dt><dd>{selected.expected ?? "未提供"}</dd></div><div><dt>版本</dt><dd className="mono">{selected.releaseVersion}</dd></div><div><dt>创建时间</dt><dd>{new Date(selected.createdAt).toLocaleString()}</dd></div><div><dt>更新时间</dt><dd>{new Date(selected.updatedAt).toLocaleString()}</dd></div><div><dt>引用</dt><dd>{selected.citations.length ? <div className="citations">{selected.citations.map((item) => <button key={`${item.path}-${item.startLine}-${item.endLine}`} onClick={() => setCitationSelection({ citation: item, feedbackId: selected.id, releaseId: selected.releaseId })} aria-label={`${item.path} 第 ${item.startLine} 至 ${item.endLine} 行`}><FileCode2 aria-hidden="true" />{item.path}<span>:{item.startLine}-{item.endLine}</span></button>)}</div> : "此查询没有相关来源引用。"} </dd></div></dl><Actions item={selected} api={api} />{citation && <aside className="feedback-source source-panel" aria-label="反馈来源代码"><header><div><p className="eyebrow">精确来源</p><h2>{citation.path}</h2></div><button className="icon-button" aria-label="关闭反馈来源代码" onClick={() => setCitationSelection(null)}><X aria-hidden="true" /></button></header><p className="source-meta">第 {citation.startLine}-{citation.endLine} 行</p>{source.isLoading ? <Loading /> : source.error ? <ErrorState message={errorMessage(source.error)} /> : source.data && <><pre><code>{source.data.content}</code></pre><dl><div><dt>Commit</dt><dd>{source.data.commitSha.slice(0, 12)}</dd></div><div><dt>Blob</dt><dd>{source.data.blobHash.slice(0, 12)}</dd></div></dl></>}</aside>}</> : <div className="document-empty"><Hammer aria-hidden="true" /><h2>选择反馈</h2><p>选择一项以查看其上下文和可用操作。</p></div>}</section></div>
  </div>;
}
