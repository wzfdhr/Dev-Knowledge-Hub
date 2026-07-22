import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenCheck, Filter, Search, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { errorMessage, type ApiClient } from "../api/client";
import { ExperienceReviewPanel } from "../components/experience-review-panel";
import { Empty, ErrorState, Loading } from "../components/ui";

const messages = {
  no_current_project: "请先选择当前项目",
  no_release: "当前项目尚无已发布版本",
  stale: "当前项目知识已落后于最新快照",
  unsupported: "当前项目暂不支持经验适用性分析",
  no_applicable_experience: "暂无适用的团队工程经验",
  evidence_revoked: "经验证据已失权",
  ready: "已按当前项目硬约束筛选"
} as const;

export function WorkspaceExperiencesPage({ api, role }: {
  api: ApiClient;
  role: "admin" | "member" | "reader";
}) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"library" | "review">("library");
  const currentProjectId = localStorage.getItem("devkh:active-project-id") ?? undefined;
  const experiences = useQuery({
    queryKey: ["workspace-experiences", currentProjectId, query],
    queryFn: () => api.listWorkspaceExperiences({ currentProjectId, query }),
    retry: false
  });
  const reviews = useQuery({
    queryKey: ["experience-review-items"], queryFn: () => api.listExperienceReviewItems(),
    enabled: role === "admin" && view === "review", retry: false
  });
  const review = useMutation({
    mutationFn: ({ experienceId, action, reason }: { experienceId: string; action: string; reason: string }) => {
      const item = reviews.data?.reviewItems.find((candidate) => candidate.patternGroupId === experienceId);
      return api.reviewExperience(experienceId, {
        action, reason, basisEvidenceIds: item?.evidenceId ? [item.evidenceId] : []
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-experiences"] }),
        queryClient.invalidateQueries({ queryKey: ["experience-review-items"] })
      ]);
    }
  });
  return <div className="page workspace-experiences-page">
    <header className="page-header"><div><p className="eyebrow">团队知识 / 工程经验</p><h1>工程经验库</h1><p>只展示当前成员可见、有引用且通过硬条件的历史实现。</p></div><span className="experience-role"><ShieldCheck aria-hidden="true" />{role}</span></header>
    <nav className="experience-view-switch" aria-label="工程经验视图"><button type="button" className={view === "library" ? "is-active" : ""} onClick={() => setView("library")}><BookOpenCheck aria-hidden="true" />经验浏览</button>{role === "admin" && <button type="button" className={view === "review" ? "is-active" : ""} onClick={() => setView("review")}><ShieldCheck aria-hidden="true" />审核队列</button>}</nav>
    {view === "review" && role === "admin" ? reviews.isLoading ? <Loading label="正在加载审核队列" /> : reviews.error ? <ErrorState message={errorMessage(reviews.error)} /> : <ExperienceReviewPanel role={role} items={reviews.data?.reviewItems ?? []} onReview={(experienceId, action, reason) => review.mutate({ experienceId, action, reason })} /> : <>
      <div className="experience-search"><Search aria-hidden="true" /><label className="sr-only" htmlFor="experience-search">搜索工程经验</label><input id="experience-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：图表下钻、表单校验、缓存" /><Filter aria-hidden="true" /></div>
      {experiences.isLoading ? <Loading label="正在计算适用经验" /> : experiences.error ? <ErrorState message={errorMessage(experiences.error)} retry={() => void experiences.refetch()} /> : experiences.data && <><section className={`experience-state-band ${experiences.data.state}`} aria-label="经验库状态"><strong>{messages[experiences.data.state]}</strong><span>{experiences.data.state}</span></section>{experiences.data.experiences.length ? <div className="experience-list">{experiences.data.experiences.map((item) => <article key={item.id}><header><div><p className="eyebrow">{item.capability}</p><h2>{item.title}</h2></div><span>{item.state}</span></header><p>{item.observedFacts.join("；")}</p><footer><strong>Trust {Math.round(item.trustScore * 100)}%</strong><span>{item.evidenceCount} 个可见实现</span><div>{item.citations.map((citation) => <code key={`${citation.path}:${citation.startLine}`}>{citation.path}:{citation.startLine}-{citation.endLine}</code>)}</div></footer></article>)}</div> : <Empty><span>{messages[experiences.data.state]}</span><span>仍保留当前事实、未知项、影响与验证计划，不生成伪团队经验。</span></Empty>}</>}
    </>}
  </div>;
}
