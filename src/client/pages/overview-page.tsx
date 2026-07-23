import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, Circle, Users } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import { errorMessage, type ApiClient } from "../api/client";
import { ErrorState, Loading, Status } from "../components/ui";
import { deriveProjectLifecycle, projectPrimaryAction, type ProjectLifecycleState } from "../features/project-lifecycle";
import { projectKeys, useFeedback } from "../hooks/use-domain";

const lifecycleSteps = ["接入资料", "创建快照", "构建知识", "审核草稿", "发布版本"];
const lifecycleIndex: Record<ProjectLifecycleState, number> = {
  "source-missing": 0,
  "source-connected": 1,
  "snapshot-ready": 2,
  building: 2,
  "review-ready": 3,
  "draft-review": 3,
  published: 4,
  failed: 2
};

const lifecycleCopy: Record<ProjectLifecycleState, string> = {
  "source-missing": "接入仓库或上传项目资料，创建第一份可追溯快照。",
  "source-connected": "资料来源已连接，请创建第一份不可变快照；正式知识不会自动变化。",
  "snapshot-ready": "资料已接入，正式知识尚未变化。开始构建后可创建草稿并审核。",
  building: "知识正在构建中，正式知识保持不变。",
  "review-ready": "候选构建已就绪，请创建草稿并检查正文与引用。",
  "draft-review": "草稿仍未发布；确认内容和来源后再发布版本。",
  published: "当前知识版本已发布，可直接阅读或用于 Codex。",
  failed: "构建失败未影响正式知识，请查看原因后重试。"
};

export function ProjectOverviewPage({ api }: { api: ApiClient }) {
  const { projectId = "" } = useParams();
  const summary = useQuery({
    queryKey: projectKeys.summary(projectId),
    queryFn: () => api.getProjectSummary(projectId),
    enabled: Boolean(projectId),
    retry: false
  });
  const feedback = useFeedback(api, undefined, Boolean(projectId));

  if (summary.isLoading) return <div className="page"><Loading label="正在加载项目概览" /></div>;
  if (summary.error) return <div className="page"><ErrorState message={errorMessage(summary.error)} retry={() => void summary.refetch()} /></div>;
  if (!summary.data) return null;

  const { repository, latestSnapshot, currentRelease, latestBuild, memberCount } = summary.data;
  const openFeedback = feedback.data?.pages.flatMap((page) => page.feedback)
    .filter((item) => item.status === "open" || item.status === "acknowledged").length ?? 0;
  const sourceLabel = repository?.kind === "upload" ? "内容版本" : "Commit";
  const sourceVersion = latestSnapshot?.commitSha ?? latestBuild?.commitSha;
  const lifecycle = deriveProjectLifecycle({ repository, latestSnapshot, latestBuild, currentRelease, releases: [] });
  const primaryAction = projectPrimaryAction(lifecycle);
  const currentStep = lifecycleIndex[lifecycle];

  return <div className="page project-overview-page">
    <header className="page-header"><div><p className="eyebrow">项目运行状态</p><h1>项目概览</h1><p>查看当前线上知识、最近资料和团队待办，然后进入对应工作区处理。</p></div></header>
    <section className="overview-lifecycle" aria-labelledby="lifecycle-title">
      <div className="overview-lifecycle-heading"><div><p className="eyebrow">资料生命周期</p><h2 id="lifecycle-title">从接入到发布</h2></div><span className={`status status-${lifecycle}`}>{lifecycle === "failed" ? "失败 · 可重试" : `当前：${lifecycleSteps[currentStep]}`}</span></div>
      <ol>{lifecycleSteps.map((step, index) => <li className={index === currentStep ? "current" : index < currentStep ? "complete" : undefined} key={step}>{index < currentStep ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}<span><small>步骤 {index + 1}</small><strong>{step}</strong></span></li>)}</ol>
    </section>
    <section className="overview-primary-task" aria-labelledby="primary-task-title">
      <div><p className="eyebrow">唯一主任务</p><h2 id="primary-task-title">下一步：{primaryAction.label}</h2><p>{lifecycleCopy[lifecycle]}</p></div>
      <Link className="button primary" to={`/projects/${projectId}/${primaryAction.section}`}>{primaryAction.label}<ArrowRight aria-hidden="true" /></Link>
    </section>
    <section className="overview-status-band" aria-label="项目状态摘要">
      <div><span>当前发布</span><strong>{currentRelease?.version ?? "暂无发布"}</strong><small>{currentRelease?.publishedAt ? new Date(currentRelease.publishedAt).toLocaleString() : "尚未向 Codex 提供知识"}</small></div>
      <div><span>知识状态</span><strong>{latestBuild ? <Status value={latestBuild.status} /> : "尚未构建"}</strong><small>{latestBuild ? `构建 ${latestBuild.id.slice(0, 8)}` : "上传资料后开始首次构建"}</small></div>
      <div><span>{sourceLabel}</span><strong className="mono">{sourceVersion?.slice(0, 12) ?? "暂无资料"}</strong><small>{latestSnapshot ? `${latestSnapshot.fileCount ?? 0} 个可采集文件` : "等待导入项目资料"}</small></div>
      <div><span>团队协作</span><strong>{memberCount} 人</strong><small>{openFeedback} 项反馈待处理</small></div>
    </section>
    <section className="overview-current-source">
      <div><Users aria-hidden="true" /><span><p className="eyebrow">当前资料来源</p><h2>{repository?.name ?? "尚未连接资料来源"}</h2></span></div>
      <dl><div><dt>来源类型</dt><dd>{repository ? repository.kind === "upload" ? "文件夹上传" : repository.kind === "git" ? "Git HTTPS" : "服务器本地路径" : "-"}</dd></div><div><dt>最近快照</dt><dd>{latestSnapshot ? new Date(latestSnapshot.commitTimestamp).toLocaleString() : "暂无"}</dd></div></dl>
    </section>
    {feedback.error && <ErrorState message={`无法读取反馈数量：${errorMessage(feedback.error)}`} retry={() => void feedback.refetch()} />}
  </div>;
}
