import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BookOpenCheck, MessageSquareText, UploadCloud, Users } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import { errorMessage, type ApiClient } from "../api/client";
import { ErrorState, Loading, Status } from "../components/ui";
import { projectKeys, useFeedback } from "../hooks/use-domain";

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

  return <div className="page project-overview-page">
    <header className="page-header"><div><p className="eyebrow">项目运行状态</p><h1>项目概览</h1><p>查看当前线上知识、最近资料和团队待办，然后进入对应工作区处理。</p></div></header>
    <section className="overview-status-band" aria-label="项目状态摘要">
      <div><span>当前发布</span><strong>{currentRelease?.version ?? "暂无发布"}</strong><small>{currentRelease?.publishedAt ? new Date(currentRelease.publishedAt).toLocaleString() : "尚未向 Codex 提供知识"}</small></div>
      <div><span>知识状态</span><strong>{latestBuild ? <Status value={latestBuild.status} /> : "尚未构建"}</strong><small>{latestBuild ? `构建 ${latestBuild.id.slice(0, 8)}` : "上传资料后开始首次构建"}</small></div>
      <div><span>{sourceLabel}</span><strong className="mono">{sourceVersion?.slice(0, 12) ?? "暂无资料"}</strong><small>{latestSnapshot ? `${latestSnapshot.fileCount ?? 0} 个可采集文件` : "等待导入项目资料"}</small></div>
      <div><span>团队协作</span><strong>{memberCount} 人</strong><small>{openFeedback} 项反馈待处理</small></div>
    </section>
    <div className="overview-actions">
      <Link aria-label="上传新资料" to={`/projects/${projectId}/imports`}><UploadCloud aria-hidden="true" /><span><strong>上传新资料</strong><small>选择完整项目文件夹，自动过滤并生成内容版本</small></span><ArrowRight aria-hidden="true" /></Link>
      <Link aria-label="管理知识版本" to={`/projects/${projectId}/versions`}><BookOpenCheck aria-hidden="true" /><span><strong>管理知识版本</strong><small>构建、审核和发布可信的项目知识</small></span><ArrowRight aria-hidden="true" /></Link>
      <Link aria-label="处理团队反馈" to="/feedback"><MessageSquareText aria-hidden="true" /><span><strong>处理团队反馈</strong><small>{openFeedback ? `${openFeedback} 项需要确认或修复` : "当前没有待处理反馈"}</small></span><ArrowRight aria-hidden="true" /></Link>
    </div>
    <section className="overview-current-source">
      <div><Users aria-hidden="true" /><span><p className="eyebrow">当前资料来源</p><h2>{repository?.name ?? "尚未连接资料来源"}</h2></span></div>
      <dl><div><dt>来源类型</dt><dd>{repository ? repository.kind === "upload" ? "文件夹 / ZIP 上传" : repository.kind === "git" ? "Git HTTPS" : "服务器本地路径" : "-"}</dd></div><div><dt>最近快照</dt><dd>{latestSnapshot ? new Date(latestSnapshot.commitTimestamp).toLocaleString() : "暂无"}</dd></div></dl>
    </section>
    {feedback.error && <ErrorState message={`无法读取反馈数量：${errorMessage(feedback.error)}`} retry={() => void feedback.refetch()} />}
  </div>;
}
