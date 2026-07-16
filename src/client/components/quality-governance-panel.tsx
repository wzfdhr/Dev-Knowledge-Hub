import { useQuery } from "@tanstack/react-query";
import { FileCode2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { errorMessage, type ApiClient, type RemediationListParams } from "../api/client";
import type { ProjectKnowledgeQuality, RemediationState } from "../api/types";
import { Empty, ErrorState, Loading } from "./ui";

const stateLabels: Record<RemediationState, string> = {
  open: "待处理",
  accepted: "已接受",
  rebuilding: "重建中",
  resolved: "已解决",
  dismissed: "已忽略"
};

function filterParams(state: RemediationState | undefined, severity: "error" | "warning" | "info" | undefined, rule: string): RemediationListParams {
  return {
    limit: 50,
    offset: 0,
    ...(state ? { state } : {}),
    ...(severity ? { severity } : {}),
    ...(rule.trim() ? { rule: rule.trim() } : {})
  };
}

export function QualityGovernancePanel({
  api,
  projectId,
  assessment
}: {
  api: ApiClient;
  projectId: string;
  assessment: ProjectKnowledgeQuality["assessment"];
}) {
  const [state, setState] = useState<RemediationState>();
  const [severity, setSeverity] = useState<"error" | "warning" | "info">();
  const [rule, setRule] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const params = filterParams(state, severity, rule);
  const query = useQuery({
    queryKey: ["project-remediations", projectId, params],
    queryFn: () => api.listProjectRemediations(projectId, params),
    retry: false
  });
  const items = query.data?.remediations ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId && !items.some((item) => item.id === selectedId)) setSelectedId(null);
  }, [items, selectedId]);

  const updateState = (value: string) => {
    setSelectedId(null);
    setState(value ? value as RemediationState : undefined);
  };
  const updateSeverity = (value: string) => {
    setSelectedId(null);
    setSeverity(value ? value as "error" | "warning" | "info" : undefined);
  };

  return <section className="quality-governance" aria-label="质量治理">
    <header className="section-toolbar">
      <div><span className="section-title"><ShieldCheck aria-hidden="true" /><h2>质量治理</h2></span><small>从可信质量评估中筛选需要人工处理的问题。</small></div>
    </header>
    <div className="quality-filters" role="group" aria-label="筛选质量问题">
      <label>处理状态<select aria-label="处理状态" value={state ?? ""} onChange={(event) => updateState(event.target.value)}>
        <option value="">全部状态</option>
        {Object.entries(stateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>严重度<select aria-label="严重度" value={severity ?? ""} onChange={(event) => updateSeverity(event.target.value)}>
        <option value="">全部严重度</option><option value="error">错误</option><option value="warning">警告</option><option value="info">提示</option>
      </select></label>
      <label>规则<input aria-label="规则" value={rule} onChange={(event) => { setSelectedId(null); setRule(event.target.value); }} placeholder="按规则筛选" /></label>
    </div>
    {query.isLoading ? <Loading label="正在加载质量问题" /> : query.error ? <ErrorState message={errorMessage(query.error)} retry={() => void query.refetch()} /> : items.length === 0 ? <Empty>当前筛选条件下没有需要处理的质量问题。</Empty> : <div className="quality-governance-layout">
      <div className="quality-issue-list" aria-label="质量问题列表">
        {items.map((item) => <button key={item.id} className={selectedId === item.id ? "active" : ""} onClick={() => setSelectedId(item.id)}>
          <span className={`quality-severity quality-severity-${item.issue.severity}`}>{item.issue.severity}</span>
          <span><strong>{item.issue.message}</strong><small>{item.issue.rule} · {stateLabels[item.state]}</small></span>
        </button>)}
      </div>
      <aside className="quality-issue-detail" aria-label="质量问题详情">
        {selected ? <><div className="section-heading"><div><p className="eyebrow">{selected.issue.rule}</p><h3>{selected.issue.message}</h3></div><span className={`status status-${selected.state}`}>{stateLabels[selected.state]}</span></div>
          <dl className="detail-list">
            <div><dt>严重度</dt><dd>{selected.issue.severity}</dd></div>
            <div><dt>来源构建</dt><dd className="mono">{selected.sourceBuildId}</dd></div>
            <div><dt>重建关联</dt><dd className="mono">{selected.rebuildBuildId ?? "尚未创建局部重建"}</dd></div>
            <div><dt>来源引用</dt><dd>{selected.issue.sourceRefs.length ? <div className="citations">{selected.issue.sourceRefs.map((ref) => <span key={`${ref.path}-${ref.startLine}-${ref.endLine}`}><FileCode2 aria-hidden="true" />{ref.path}:{ref.startLine}-{ref.endLine}</span>)}</div> : "此问题没有来源引用。"}</dd></div>
            <div><dt>质量依据</dt><dd>{assessment?.trust.reasons.length ? assessment.trust.reasons.join("；") : "当前构建尚未产出可验证的 Trust 说明。"}</dd></div>
          </dl>
        </> : <div className="document-empty"><ShieldCheck aria-hidden="true" /><h3>选择一个质量问题</h3><p>查看来源引用、关联构建和可信质量依据。</p></div>}
      </aside>
    </div>}
  </section>;
}
