import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FileCode2, Hammer, ShieldCheck, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { ApiError, errorMessage, type ApiClient, type RemediationListParams } from "../api/client";
import type { ProjectKnowledgeQuality, RemediationState } from "../api/types";
import { Empty, ErrorState, Loading } from "./ui";

const stateLabels: Record<RemediationState, string> = {
  open: "待处理",
  accepted: "已接受",
  rebuilding: "重建中",
  resolved: "已解决",
  dismissed: "已忽略"
};

export function remediationGuidance(state: RemediationState) {
  switch (state) {
    case "open":
      return {
        title: "下一步：接受处理或说明忽略",
        description: "确认问题需要修复时接受处理；如果不适用于当前项目，请填写理由后忽略。"
      };
    case "accepted":
      return {
        title: "下一步：请求范围重建",
        description: "已确认修复范围。发起重建会创建候选结果，不会自动替换正式知识。"
      };
    case "rebuilding":
      return {
        title: "下一步：等待候选构建并完成审核",
        description: "候选仍在生成，当前已发布版本不会变化。候选就绪并审核完成后，才可标记已解决。"
      };
    case "resolved":
      return {
        title: "已完成：保留处理记录",
        description: "此问题已标记解决，保留在这里供后续追溯。"
      };
    case "dismissed":
      return {
        title: "已忽略：保留处理理由",
        description: "此问题不再需要处理，仍保留忽略记录供后续追溯。"
      };
  }
}

export function governanceErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === "REMEDIATION_REBUILD_NOT_READY") {
    return "范围重建候选仍在处理中；当前版本未改变。请在候选构建就绪并审核后再标记已解决。";
  }
  return errorMessage(error);
}

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
  const [dismissing, setDismissing] = useState(false);
  const [dismissalReason, setDismissalReason] = useState("");
  const queryClient = useQueryClient();
  const params = filterParams(state, severity, rule);
  const query = useQuery({
    queryKey: ["project-remediations", projectId, params],
    queryFn: () => api.listProjectRemediations(projectId, params),
    retry: false
  });
  const session = useQuery({ queryKey: ["session"], queryFn: api.session, retry: false });
  const members = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: () => api.listProjectMembers(projectId),
    enabled: Boolean(session.data?.admin.id),
    retry: false
  });
  const transition = useMutation({
    mutationFn: ({ remediationId, state, reason }: { remediationId: string; state: "accepted" | "dismissed" | "resolved"; reason?: string }) =>
      api.transitionProjectRemediation(projectId, remediationId, { state, ...(reason ? { reason } : {}) }),
    onSuccess: () => {
      setDismissing(false);
      setDismissalReason("");
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project-remediations", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["project-knowledge-quality", projectId] })
      ]);
    }
  });
  const rebuild = useMutation({
    mutationFn: (remediationId: string) => api.requestProjectRemediationRebuild(projectId, remediationId),
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: ["project-remediations", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["project-knowledge-quality", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["projects", projectId, "builds"] })
    ])
  });
  const items = query.data?.remediations ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const guidance = selected ? remediationGuidance(selected.state) : null;
  const ownMembership = members.data?.members.find((member) => member.id === session.data?.admin.id);
  const canManage = session.data?.admin.role === "admin" || ownMembership?.role === "admin";

  useEffect(() => {
    if (selectedId && !items.some((item) => item.id === selectedId)) {
      setSelectedId(null);
      setDismissing(false);
    }
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
      <div><span className="section-title"><ShieldCheck aria-hidden="true" /><h2>质量治理</h2></span><small>处理顺序：待处理 → 接受处理 → 范围重建 → 审核候选 → 标记解决。已解决和已忽略仅用于追溯。</small></div>
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
          </dl>{guidance && <section className="quality-next-step" aria-label="当前操作指引"><strong>{guidance.title}</strong><p>{guidance.description}</p></section>}{canManage && selected.state === "open" && <div className="quality-actions" role="group" aria-label="质量问题操作">
            <button className="button primary" disabled={transition.isPending} onClick={() => transition.mutate({ remediationId: selected.id, state: "accepted" })}><Check aria-hidden="true" />接受处理</button>
            {!dismissing ? <button className="button" disabled={transition.isPending} onClick={() => setDismissing(true)}><XCircle aria-hidden="true" />忽略</button> : <form className="quality-dismiss-form" onSubmit={(event) => { event.preventDefault(); transition.mutate({ remediationId: selected.id, state: "dismissed", reason: dismissalReason.trim() }); }}><label>忽略理由<input aria-label="忽略理由" value={dismissalReason} onChange={(event) => setDismissalReason(event.target.value)} maxLength={500} /></label><button className="button danger" type="submit" disabled={!dismissalReason.trim() || transition.isPending}>确认忽略</button><button className="button" type="button" disabled={transition.isPending} onClick={() => { setDismissing(false); setDismissalReason(""); }}>取消</button></form>}
          </div>}{canManage && selected.state === "accepted" && <div className="quality-actions" role="group" aria-label="质量问题操作"><button className="button primary" disabled={rebuild.isPending} onClick={() => rebuild.mutate(selected.id)}><Hammer aria-hidden="true" />请求范围重建</button></div>}{canManage && selected.state === "rebuilding" && <div className="quality-actions" role="group" aria-label="质量问题操作"><button className="button primary" disabled={transition.isPending} onClick={() => transition.mutate({ remediationId: selected.id, state: "resolved" })}><Check aria-hidden="true" />标记已解决</button><small className="quality-action-note">确认候选构建已就绪并完成审核后再标记；这不会自动发布。</small></div>}{transition.error || rebuild.error ? <ErrorState message={governanceErrorMessage(transition.error ?? rebuild.error)} /> : null}{rebuild.isSuccess && <p className="success-message">已创建范围重建候选，当前已发布版本未改变。</p>}
        </> : <div className="document-empty"><ShieldCheck aria-hidden="true" /><h3>选择一个质量问题</h3><p>查看来源引用、关联构建和可信质量依据。</p></div>}
      </aside>
    </div>}
  </section>;
}
