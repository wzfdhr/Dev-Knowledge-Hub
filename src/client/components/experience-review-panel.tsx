import { Ban, BadgeCheck, CheckCircle2, GitPullRequestArrow, ShieldAlert } from "lucide-react";
import { useState } from "react";

import type { ExperienceReviewItemDto } from "../api/types";
import { Empty } from "./ui";

const actions = [
  { value: "verify", label: "验证", icon: BadgeCheck },
  { value: "recommend", label: "推荐", icon: CheckCircle2 },
  { value: "standardize", label: "标准化", icon: GitPullRequestArrow },
  { value: "reject", label: "驳回", icon: Ban }
] as const;

export function ExperienceReviewPanel({ role, items, onReview }: {
  role: "admin" | "member" | "reader";
  items: ExperienceReviewItemDto[];
  onReview: (experienceId: string, action: string, reason: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(items[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  if (role !== "admin") return <Empty>审核队列仅工作区管理员可见。</Empty>;
  return <div className="experience-review-layout">
    <aside aria-label="复审项列表">{items.length ? items.map((item) => <button type="button" key={item.id} className={item.id === selected?.id ? "is-active" : ""} onClick={() => setSelectedId(item.id)}><ShieldAlert aria-hidden="true" /><span><strong>{item.priority === "high" ? "高优先级" : "普通复审"}</strong><small>{item.taskSummary}</small></span></button>) : <Empty>当前没有待复审项。</Empty>}</aside>
    <section aria-label="审核操作">{selected ? <><p className="eyebrow">{selected.kind}</p><h3>{selected.taskSummary}</h3><label>审核理由<textarea aria-label="审核理由" maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} /></label><div className="experience-review-actions">{actions.map((action) => <button key={action.value} type="button" className={`button${action.value === "recommend" ? " primary" : ""}`} disabled={!reason.trim()} onClick={() => onReview(selected.patternGroupId, action.value, reason.trim())}><action.icon aria-hidden="true" />{action.label}</button>)}</div></> : <Empty>选择一个复审项后进行操作。</Empty>}</section>
  </div>;
}
