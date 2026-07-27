import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, GitBranch, Play, RefreshCw, Send, Square, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { errorMessage, LIST_PAGE_SIZE, type ApiClient } from "../api/client";
import type { Build, PipelineStageRun, Release, Repository, SnapshotSummary } from "../api/types";
import { Empty, ErrorState, Loading, Status } from "../components/ui";
import { statusLabel } from "../copy";
import { projectKeys, useFeedback } from "../hooks/use-domain";
import "../progress.css";

type PrimaryKind = "connect" | "sync" | "start-build" | "retry-build" | "review" | "publish" | "none";
interface OverviewState { repository: Repository | null; builds: Build[]; releases: Release[]; snapshotId?: string }

export function shadowPipelineMessage(status: Build["status"] | null): { title: string; detail: string } {
  if (status === "failed") return {
    title: "影子验证发现问题",
    detail: "正式版本保持不变；请检查失败阶段后重试影子验证。"
  };
  if (status === "ready" || status === "published") return {
    title: "影子验证已完成",
    detail: "结果仅用于新内核验证，当前正式版本仍使用 legacy 内核。"
  };
  if (status === null) return { title: "尚未运行影子验证", detail: "当前正式构建不受影响。" };
  return { title: "影子验证进行中", detail: "当前正式版本继续使用 legacy 内核。" };
}

export function canEnableLlmBuild(
  workspaceRole: "admin" | "member" | "reader" | undefined,
  projectRole: "admin" | "member" | "reader" | undefined
): boolean {
  return workspaceRole === "admin" || projectRole === "admin";
}

export function llmEnhancementStatus(build: Pick<Build, "allowLlm" | "warnings">): {
  label: string;
  detail: string;
  tone: "success" | "warning" | "neutral";
} {
  if (!build.allowLlm) return { label: "未启用", detail: "本次使用基础生成。", tone: "neutral" };
  const warning = build.warnings.find((item) => ["ENHANCER_FAILED", "ENHANCER_UNAVAILABLE"].includes(item.code ?? ""));
  if (warning) return {
    label: "LLM 未生效，已使用基础生成",
    detail: warning.message ?? "LLM 增强不可用。",
    tone: "warning"
  };
  return {
    label: "LLM 增强成功",
    detail: "已使用 LLM 为本次知识生成补充说明。",
    tone: "success"
  };
}

export function canCreateFrontendDraft(
  workspaceRole: "admin" | "member" | "reader" | undefined,
  projectRole: "admin" | "member" | "reader" | undefined
): boolean {
  return workspaceRole === "admin" || (workspaceRole === "member" && projectRole === "admin");
}

export function frontendDraftAvailability(stages: readonly PipelineStageRun[] | undefined): { ready: boolean; reason: string | null } {
  if (!stages) return { ready: false, reason: "正在检查前端候选包状态。" };
  if (stages.some((stage) => stage.stage === "package" && ["succeeded", "reused"].includes(stage.status))) {
    return { ready: true, reason: null };
  }
  const parserFailure = stages.find((stage) => stage.stage === "extract" && stage.errorCode === "PARSER_RUNTIME_UNAVAILABLE");
  if (parserFailure) {
    return { ready: false, reason: "前端候选包未生成：解析器连接暂时中断。重新构建后再创建 active 图谱草稿。" };
  }
  return { ready: false, reason: "前端候选包尚未生成；完成影子构建后再创建 active 图谱草稿。" };
}

export function canRunProjectCommand(
  kind: PrimaryKind,
  workspaceRole: "admin" | "member" | "reader" | undefined,
  projectRole: "admin" | "member" | "reader" | undefined
): boolean {
  if (kind === "none" || workspaceRole === "reader") return false;
  if (workspaceRole === "admin") return true;
  if (workspaceRole !== "member" || !["admin", "member"].includes(projectRole ?? "")) return false;
  return kind !== "publish" || projectRole === "admin";
}

export function suggestNextReleaseVersion(releases: Array<Pick<Release, "version">>): string {
  let highest: [number, number, number] | null = null;
  for (const release of releases) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(release.version);
    if (!match) continue;
    const candidate: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (!highest || candidate[0] > highest[0]
      || (candidate[0] === highest[0] && candidate[1] > highest[1])
      || (candidate[0] === highest[0] && candidate[1] === highest[1] && candidate[2] > highest[2])) {
      highest = candidate;
    }
  }
  return highest ? `${highest[0]}.${highest[1]}.${highest[2] + 1}` : "1.0.0";
}

export function derivePrimaryAction(state: OverviewState): { kind: PrimaryKind; label: string } {
  if (!state.repository) return { kind: "connect", label: "连接仓库" };
  const latestBuild = state.builds[0];
  if (latestBuild && !["ready", "published", "failed"].includes(latestBuild.status)) {
    return { kind: "none", label: "构建进行中" };
  }
  if (latestBuild?.status === "ready") {
    const draft = state.releases.find((release) => release.buildId === latestBuild.id && !release.publishedAt);
    return draft ? { kind: "publish", label: "发布版本" } : { kind: "review", label: "审核就绪构建" };
  }
  if (latestBuild?.status === "failed" && (state.snapshotId ?? latestBuild.snapshotId)) {
    return { kind: "retry-build", label: "重试知识构建" };
  }
  if (state.snapshotId && latestBuild?.snapshotId === state.snapshotId && latestBuild.status === "published") {
    return { kind: "sync", label: state.repository.kind === "upload" ? "导入新文件夹版本" : "同步仓库" };
  }
  if (state.snapshotId) return { kind: "start-build", label: "开始构建知识" };
  return { kind: "sync", label: state.repository.kind === "upload" ? "导入项目文件夹" : "同步仓库" };
}

const snapshotKey = "devkh:last-snapshot";
const terminal = new Set(["ready", "published", "failed"]);

export function shouldPollShadowPipeline(
  legacyStatus: Build["status"] | null,
  pipelineStatus: Build["status"] | null
): boolean {
  return Boolean(legacyStatus && (
    !terminal.has(legacyStatus)
    || (pipelineStatus && !terminal.has(pipelineStatus))
  ));
}

export function ProjectVersionsPage({ api }: { api: ApiClient }) {
  const navigate = useNavigate();
  const { projectId = "" } = useParams();
  const queryClient = useQueryClient();
  const repositoryQuery = useQuery({ queryKey: projectKeys.repository(projectId), queryFn: api.getRepository, retry: false });
  const repository = repositoryQuery.data?.repository ?? null;
  const repositoryStatusQuery = useQuery({
    queryKey: ["repository-status", repository?.id],
    queryFn: () => api.getRepositoryStatus?.() ?? Promise.resolve({ repository: repository!, latestSnapshot: null }),
    enabled: Boolean(repository),
    retry: false
  });
  const buildsQuery = useInfiniteQuery({
    queryKey: projectKeys.builds(projectId),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.listBuilds({ limit: LIST_PAGE_SIZE, offset: pageParam }),
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    enabled: Boolean(repository),
    refetchInterval: 3000
  });
  const releasesQuery = useQuery({ queryKey: projectKeys.releases(projectId), queryFn: () => api.listReleases({ limit: LIST_PAGE_SIZE, offset: 0 }), enabled: Boolean(repository), retry: false });
  const feedbackQuery = useFeedback(api, undefined, Boolean(repository));
  const sessionQuery = useQuery({
    queryKey: ["session"],
    queryFn: api.session,
    enabled: typeof api.session === "function",
    retry: false
  });
  const projectMembersQuery = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: () => api.listProjectMembers(projectId),
    enabled: Boolean(projectId && sessionQuery.data && typeof api.listProjectMembers === "function"),
    retry: false
  });
  const [sessionSnapshot, setSessionSnapshot] = useState<SnapshotSummary | null>(() => {
    const raw = sessionStorage.getItem(snapshotKey);
    return raw ? JSON.parse(raw) as SnapshotSummary : null;
  });
  const [reviewBuild, setReviewBuild] = useState<Build | null>(null);
  const [version, setVersion] = useState("1.0.0");
  const [allowLlm, setAllowLlm] = useState(false);
  const [eventState, setEventState] = useState<"idle" | "connecting" | "connected" | "reconnecting">("idle");

  const builds = buildsQuery.data?.pages.flatMap((page) => page.builds) ?? [];
  const releases = releasesQuery.data?.releases ?? [];
  const latestBuild = builds[0];
  const activeBuild = latestBuild && !terminal.has(latestBuild.status) ? latestBuild : undefined;
  const failedBuild = latestBuild?.status === "failed" ? latestBuild : undefined;
  const serverSnapshot = repositoryStatusQuery.data?.latestSnapshot;
  const snapshot: SnapshotSummary | null = serverSnapshot ? {
    snapshotId: serverSnapshot.id,
    commitSha: serverSnapshot.commitSha,
    ref: serverSnapshot.ref,
    fileCount: serverSnapshot.fileCount ?? 0,
    unchanged: sessionSnapshot?.snapshotId === serverSnapshot.id ? sessionSnapshot.unchanged : true
  } : sessionSnapshot;
  const effectiveSnapshotId = snapshot?.snapshotId ?? failedBuild?.snapshotId;
  const shadowPipelineQuery = useQuery({
    queryKey: ["build-stages", projectId, latestBuild?.id],
    queryFn: () => api.getBuildStages(latestBuild!.id),
    enabled: Boolean(latestBuild),
    retry: false,
    refetchInterval: (query) => shouldPollShadowPipeline(
      latestBuild?.status ?? null,
      query.state.data?.pipelineStatus ?? null
    ) ? 3000 : false
  });
  const requiredLoading = Boolean(repository) && (buildsQuery.isLoading || releasesQuery.isLoading || repositoryStatusQuery.isLoading);
  const blockingError = repositoryQuery.error
    ? repositoryQuery.error
    : buildsQuery.error ?? releasesQuery.error ?? repositoryStatusQuery.error;
  const action = blockingError || requiredLoading
    ? null
    : derivePrimaryAction({ repository, builds, releases, snapshotId: effectiveSnapshotId });
  const projectRole = projectMembersQuery.data?.members.find((member) => member.id === sessionQuery.data?.admin.id)?.role;
  const canUseLlm = canEnableLlmBuild(sessionQuery.data?.admin.role, projectRole);
  const canCreateActiveGraph = canCreateFrontendDraft(sessionQuery.data?.admin.role, projectRole);
  const frontendDraft = frontendDraftAvailability(shadowPipelineQuery.data?.stages);
  const usesPermissionApi = typeof api.session === "function" && typeof api.listProjectMembers === "function";
  const canContribute = !usesPermissionApi || canRunProjectCommand("start-build", sessionQuery.data?.admin.role, projectRole);
  const canRunAction = Boolean(action && (!usesPermissionApi
    || canRunProjectCommand(action.kind, sessionQuery.data?.admin.role, projectRole)));

  useEffect(() => {
    if (!activeBuild) {
      setEventState("idle");
      return;
    }
    setEventState("connecting");
    const source = new EventSource(`/api/builds/${encodeURIComponent(activeBuild.id)}/events`);
    source.onopen = () => setEventState("connected");
    source.addEventListener("build", (event) => {
      setEventState("connected");
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { status?: string };
        if (payload.status && terminal.has(payload.status)) {
          source.close();
          setEventState("idle");
        }
      } catch {
        // A malformed event should not disable the browser's native reconnect behavior.
      }
      void queryClient.invalidateQueries({ queryKey: projectKeys.builds(projectId) });
    });
    source.onerror = () => setEventState("reconnecting");
    return () => source.close();
  }, [activeBuild, projectId, queryClient]);

  const invalidate = async () => Promise.all([
    queryClient.invalidateQueries({ queryKey: projectKeys.builds(projectId) }),
    queryClient.invalidateQueries({ queryKey: projectKeys.releases(projectId) }),
    queryClient.invalidateQueries({ queryKey: ["build-stages", projectId] }),
    queryClient.invalidateQueries({ queryKey: ["repository-status"] })
  ]);
  const sync = useMutation({ mutationFn: api.syncRepository, onSuccess: (value) => {
    setSessionSnapshot(value);
    sessionStorage.setItem(snapshotKey, JSON.stringify(value));
  } });
  const start = useMutation({
    mutationFn: ({ snapshotId, allowLlm: useLlm }: { snapshotId: string; allowLlm: boolean }) =>
      api.startBuild(snapshotId, { allowLlm: useLlm }),
    onSuccess: invalidate
  });
  const createRelease = useMutation({
    mutationFn: ({ buildId, value }: {
      buildId: string;
      value: string;
      navigateToKnowledge?: boolean;
    }) => api.createRelease(buildId, value),
    onSuccess: async (result, variables) => {
      setReviewBuild(null);
      await invalidate();
      if (variables.navigateToKnowledge) {
        navigate(`/projects/${projectId}/knowledge/pages?releaseId=${encodeURIComponent(result.release.id)}`);
      }
    }
  });
  const createFrontendRelease = useMutation({
    mutationFn: ({ buildId, value }: { buildId: string; value: string }) => api.createFrontendReleaseDraft(buildId, value),
    onSuccess: async () => { setReviewBuild(null); await invalidate(); }
  });
  const publish = useMutation({ mutationFn: api.publishRelease, onSuccess: invalidate });
  const cancel = useMutation({ mutationFn: api.cancelBuild, onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.builds(projectId) }) });
  const operationError = sync.error ?? start.error ?? createRelease.error ?? createFrontendRelease.error ?? publish.error ?? cancel.error;

  const handlePrimary = () => {
    if (reviewBuild) {
      createRelease.mutate({ buildId: reviewBuild.id, value: version, navigateToKnowledge: true });
      return;
    }
    if (!action) return;
    if (action.kind === "connect") navigate(`/projects/${projectId}/sources`);
    if (action.kind === "sync") {
      if (repository?.kind === "upload") navigate(`/projects/${projectId}/sources`);
      else sync.mutate();
    }
    if (["start-build", "retry-build"].includes(action.kind) && effectiveSnapshotId) {
      start.mutate({ snapshotId: effectiveSnapshotId, allowLlm: canUseLlm && allowLlm });
    }
    if (action.kind === "review") {
      setVersion(suggestNextReleaseVersion(releases));
      setReviewBuild(latestBuild?.status === "ready" ? latestBuild : null);
    }
    if (action.kind === "publish") {
      const draft = releases.find((release) => release.buildId === latestBuild?.id && !release.publishedAt);
      if (draft) publish.mutate(draft.id);
    }
  };
  const inspectKnowledge = () => {
    if (!reviewBuild) return;
    const draft = releases.find((release) => release.buildId === reviewBuild.id);
    if (draft) {
      navigate(`/projects/${projectId}/knowledge/pages?releaseId=${encodeURIComponent(draft.id)}`);
      return;
    }
    createRelease.mutate({
      buildId: reviewBuild.id,
      value: version,
      navigateToKnowledge: true
    });
  };
  const commit = snapshot?.commitSha ?? latestBuild?.commitSha;
  const sourceLabel = repository?.kind === "upload" ? "内容版本" : "Commit";
  const progress = useMemo(() => ({ queued: 8, syncing: 20, parsing: 42, synthesizing: 66, validating: 86, ready: 100, published: 100, failed: 100 }[activeBuild?.status ?? "queued"]), [activeBuild]);
  const retryOverview = () => void Promise.all([
    repositoryQuery.refetch(),
    ...(repository ? [buildsQuery.refetch(), releasesQuery.refetch(), repositoryStatusQuery.refetch()] : [])
  ]);

  if (repositoryQuery.isLoading) return <Loading label="正在加载操作台" />;
  return <div className="page versions-page">
    <header className="page-header"><div><p className="eyebrow">构建与发布</p><h1>知识生产</h1><p>构建、审核并发布可供团队和 Codex 使用的不可变知识版本。</p></div>
      {!blockingError && !requiredLoading && (reviewBuild || canRunAction) && <div className="page-header-actions">
        {!reviewBuild && canUseLlm && ["start-build", "retry-build"].includes(action?.kind ?? "") && <label className="llm-build-option"><input type="checkbox" checked={allowLlm} onChange={(event) => setAllowLlm(event.target.checked)} /><span>本次构建使用 LLM 增强</span></label>}
        <button className="button primary command" onClick={handlePrimary} disabled={sync.isPending || start.isPending || publish.isPending || createRelease.isPending}>
        {!reviewBuild && action?.kind === "sync" && <RefreshCw aria-hidden="true" />}{!reviewBuild && ["start-build", "retry-build"].includes(action?.kind ?? "") && <Play aria-hidden="true" />}{!reviewBuild && action?.kind === "publish" && <Send aria-hidden="true" />}{(reviewBuild || ["connect", "review"].includes(action?.kind ?? "")) && <ArrowRight aria-hidden="true" />}{reviewBuild ? "创建版本草稿" : action?.label}
        </button>
      </div>}
    </header>
    {blockingError && <div className="state error blocking-error" role="alert"><TriangleAlert aria-hidden="true" /><span>{errorMessage(blockingError)}</span><button className="button" onClick={retryOverview}>重试总览数据</button></div>}
    {requiredLoading && <Loading label="正在加载构建和版本状态" />}
    {!blockingError && operationError && <ErrorState message={errorMessage(operationError)} />}
    {!blockingError && !requiredLoading && <>
      <section className="repo-strip" aria-label="仓库状态"><div><span>仓库</span><strong>{repository?.name ?? "未连接"}</strong></div><div><span>{repository?.kind === "upload" ? "来源" : "分支"}</span><strong><GitBranch aria-hidden="true" />{snapshot?.ref ?? repository?.defaultBranch ?? "-"}</strong></div><div><span>{sourceLabel}</span><strong className="mono">{commit?.slice(0, 12) ?? "暂无快照"}</strong></div><div><span>待同步</span><strong>{snapshot ? (snapshot.unchanged ? "没有变更" : `已采集 ${snapshot.fileCount} 个文件`) : repository ? repository.kind === "upload" ? "等待导入项目文件夹" : "需要同步" : "-"}</strong></div></section>
      <section className="metric-grid" aria-label="工作区摘要"><article><span>当前版本</span><strong>{releases.find((release) => release.publishedAt)?.version ?? "未发布"}</strong></article><article><span>人工待处理项</span><strong>{feedbackQuery.data?.pages.flatMap((page) => page.feedback).filter((item) => ["open", "acknowledged"].includes(item.status)).length ?? 0}</strong></article><article><span>构建数</span><strong>{builds.length}</strong></article><article><span>知识状态</span><strong>{latestBuild ? <Status value={latestBuild.status} /> : "尚未构建"}</strong></article></section>
      {shadowPipelineQuery.data?.stages.length ? <section className="panel shadow-pipeline-panel" aria-label="影子验证状态"><div className="section-heading"><div><p className="eyebrow">新内核影子验证</p><h2>{shadowPipelineMessage(shadowPipelineQuery.data.pipelineStatus).title}</h2><p>{shadowPipelineMessage(shadowPipelineQuery.data.pipelineStatus).detail}</p></div><Status value={shadowPipelineQuery.data.pipelineStatus ?? "queued"} /></div><div className="shadow-stage-grid">{shadowPipelineQuery.data.stages.map((stage) => <div className="shadow-stage" key={stage.id}><span>{stage.stage}</span><Status value={stage.status === "reused" ? "ready" : stage.status === "cancelled" ? "failed" : stage.status} /><small>{stage.errorCode ?? ""}</small></div>)}</div></section> : null}
      {shadowPipelineQuery.error && <ErrorState message={`无法读取影子验证状态：${errorMessage(shadowPipelineQuery.error)}`} retry={() => void shadowPipelineQuery.refetch()} />}
      {feedbackQuery.error && <ErrorState message={`无法读取反馈数量：${errorMessage(feedbackQuery.error)}`} retry={() => void feedbackQuery.refetch()} />}
      {activeBuild && <section className="panel active-build"><div className="section-heading"><div><p className="eyebrow">正在构建</p><h2>{statusLabel(activeBuild.status)}</h2></div><Status value={activeBuild.status} /></div><progress className="progress" aria-label="构建进度" max={100} value={progress} /><p className="muted">{sourceLabel} <span className="mono">{activeBuild.commitSha.slice(0, 12)}</span>。{eventState === "reconnecting" ? "正在重新连接构建更新" : eventState === "connected" ? "已连接实时更新" : "正在连接实时更新"}</p>{canContribute && <button className="button danger" onClick={() => cancel.mutate(activeBuild.id)} disabled={activeBuild.cancelRequested}><Square aria-hidden="true" />{activeBuild.cancelRequested ? "已请求取消" : "取消构建"}</button>}</section>}
      {failedBuild && <section className="panel failed-build" role="alert"><div className="section-heading"><div><p className="eyebrow">构建失败</p><h2>{failedBuild.errorMessage ?? "知识构建失败"}</h2></div><Status value="failed" /></div><p className="muted">当前已发布版本未受影响。重试会创建新的候选构建，不会覆盖现有版本。</p></section>}
      {reviewBuild && <section className="panel review-panel" aria-label="版本审核"><div><p className="eyebrow">等待审核</p><h2>构建 {reviewBuild.id.slice(0, 8)}</h2><p>选择草稿版本，然后检查生成的知识。</p></div><div className="review-actions"><button className="button" onClick={inspectKnowledge} disabled={createRelease.isPending}>查看知识</button>{canCreateActiveGraph && <div><button className="button primary" onClick={() => createFrontendRelease.mutate({ buildId: reviewBuild.id, value: version })} disabled={createFrontendRelease.isPending || !frontendDraft.ready}>创建 active 图谱草稿</button>{!frontendDraft.ready && <small className="muted">{frontendDraft.reason}</small>}</div>}<label>版本<input value={version} onChange={(event) => setVersion(event.target.value)} /></label></div></section>}
      <section className="section"><div className="section-heading"><div><p className="eyebrow">历史记录</p><h2>最近构建</h2></div></div>{builds.length === 0 ? <Empty>{repository?.kind === "upload" ? "暂无构建，请先导入项目文件夹。" : "暂无构建，请先同步仓库。"}</Empty> : <><div className="table-wrap"><table><thead><tr><th>状态</th><th>{sourceLabel}</th><th>LLM 增强</th><th>警告</th><th>构建</th></tr></thead><tbody>{builds.map((build) => { const llm = llmEnhancementStatus(build); return <tr key={build.id}><td><Status value={build.status} /></td><td className="mono">{build.commitSha.slice(0, 12)}</td><td><span>{llm.label}</span>{llm.tone === "warning" && <small className="muted">{llm.detail}</small>}</td><td>{build.warnings.length}</td><td className="mono">{build.id.slice(0, 8)}</td></tr>; })}</tbody></table></div>{buildsQuery.hasNextPage && <button className="button continuation" onClick={() => void buildsQuery.fetchNextPage()} disabled={buildsQuery.isFetchingNextPage}>{buildsQuery.isFetchingNextPage ? "正在加载构建..." : "加载更多构建"}</button>}</>}</section>
    </>}
  </div>;
}
