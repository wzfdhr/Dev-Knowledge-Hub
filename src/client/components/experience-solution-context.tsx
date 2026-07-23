import { AlertTriangle, CheckCircle2, FileCode2, History, ListChecks, ShieldCheck } from "lucide-react";

import type { FrontendSolutionContext } from "../api/types";

function Citations({ citations }: { citations: Array<{ path: string; startLine: number; endLine: number }> }) {
  if (!citations.length) return null;
  return <div className="experience-citations" aria-label="来源引用">{citations.map((citation) => <span key={`${citation.path}:${citation.startLine}:${citation.endLine}`}><FileCode2 aria-hidden="true" />{citation.path}:{citation.startLine}-{citation.endLine}</span>)}</div>;
}

export function ExperienceSolutionContext({ context }: { context: FrontendSolutionContext }) {
  return <div className="experience-solution-context">
    <section className="experience-context-band" aria-label="当前项目事实"><header><ShieldCheck aria-hidden="true" /><div><p className="eyebrow">CURRENT FACTS</p><h3>当前项目事实</h3></div><span className={`experience-state ${context.currentProject.status}`}>{context.currentProject.status}</span></header>{context.currentProjectFacts.length ? <dl>{context.currentProjectFacts.map((fact) => <div key={fact.key}><dt>{fact.label}</dt><dd>{fact.value}<Citations citations={fact.citations} /></dd></div>)}</dl> : <p>当前状态没有可用的已发布事实。</p>}</section>
    <section className="experience-context-band" aria-label="硬约束"><header><ListChecks aria-hidden="true" /><div><p className="eyebrow">HARD CONSTRAINTS</p><h3>硬约束</h3></div></header>{context.hardConstraints.length ? <ul>{context.hardConstraints.map((item) => <li key={item.key}>{item.statement}<Citations citations={item.citations} /></li>)}</ul> : <p>暂无已确认硬约束。</p>}</section>
    <section className="experience-context-band" aria-label="历史工程经验"><header><History aria-hidden="true" /><div><p className="eyebrow">PRIOR EXPERIENCE</p><h3>历史工程经验</h3></div></header>{context.applicableExperiences.length ? context.applicableExperiences.map((item) => <article key={item.id} className="experience-reference"><div><h4>{item.title}</h4><span>{item.state} · Trust {Math.round(item.trustScore * 100)}% · {item.evidenceCount} 个可见实现</span></div><p>{item.observedFacts.join("；")}</p><Citations citations={item.citations} /></article>) : <p>暂无适用团队经验；不会生成伪经验。</p>}</section>
    <section className="experience-context-band is-rejected" aria-label="已排除方案"><header><AlertTriangle aria-hidden="true" /><div><p className="eyebrow">REJECTED</p><h3>已排除方案</h3></div></header>{context.rejectedExperiences.length ? <ul>{context.rejectedExperiences.map((item) => <li key={item.experienceId}><code>{item.experienceId}</code><span>{item.reasons.join(" · ")}</span></li>)}</ul> : <p>没有需要展示的已拒候选。</p>}</section>
    <section className="experience-context-band is-unknown" aria-label="待确认条件"><header><AlertTriangle aria-hidden="true" /><div><p className="eyebrow">UNKNOWNS</p><h3>待确认条件</h3></div></header>{context.unknowns.length ? <ul>{context.unknowns.map((item) => <li key={item.key}><strong>{item.key}</strong><span>{item.reason}</span>{item.requiredForRecommendation && <em>推荐前必须确认</em>}</li>)}</ul> : <p>关键条件已知。</p>}</section>
    <section className="experience-context-band" aria-label="影响与验证计划"><header><CheckCircle2 aria-hidden="true" /><div><p className="eyebrow">IMPACT & VERIFY</p><h3>影响与验证计划</h3></div></header><div className="experience-impact-grid"><div><h4>变更影响</h4>{context.changeImpact.length ? <ul>{context.changeImpact.map((item) => <li key={item.path}><code>{item.path}</code><span>{item.reason}</span></li>)}</ul> : <p>未指定 changed paths。</p>}</div><div><h4>验证计划</h4><ol>{context.verificationPlan.map((item) => <li key={item.step}>{item.step}<small>{item.reason}</small></li>)}</ol></div></div></section>
  </div>;
}
