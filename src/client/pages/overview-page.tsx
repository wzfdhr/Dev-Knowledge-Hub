import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, GitBranch, Play, RefreshCw, Send, Square, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { ApiError, errorMessage, type ApiClient } from "../api/client";
import type { Build, Release, Repository, SnapshotSummary } from "../api/types";
import { Empty, ErrorState, Loading, Status } from "../components/ui";
import { keys, useRepository } from "../hooks/use-domain";

type PrimaryKind = "connect" | "sync" | "start-build" | "retry-build" | "review" | "publish" | "none";
interface OverviewState { repository: Repository | null; builds: Build[]; releases: Release[]; snapshotId?: string }

export function derivePrimaryAction(state: OverviewState): { kind: PrimaryKind; label: string } {
  if (!state.repository) return { kind: "connect", label: "Connect repository" };
  const latestBuild = state.builds[0];
  if (latestBuild && !["ready", "published", "failed"].includes(latestBuild.status)) {
    return { kind: "none", label: "Build in progress" };
  }
  if (latestBuild?.status === "ready") {
    const draft = state.releases.find((release) => release.buildId === latestBuild.id && !release.publishedAt);
    return draft ? { kind: "publish", label: "Publish release" } : { kind: "review", label: "Review ready build" };
  }
  if (latestBuild?.status === "failed" && (state.snapshotId ?? latestBuild.snapshotId)) {
    return { kind: "retry-build", label: "Retry knowledge build" };
  }
  if (state.snapshotId && latestBuild?.snapshotId === state.snapshotId && latestBuild.status === "published") {
    return { kind: "sync", label: "Sync repository" };
  }
  if (state.snapshotId) return { kind: "start-build", label: "Start knowledge build" };
  return { kind: "sync", label: "Sync repository" };
}

const snapshotKey = "devkh:last-snapshot";
const terminal = new Set(["ready", "published", "failed"]);

export function OverviewPage({ api }: { api: ApiClient }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const repositoryQuery = useRepository(api);
  const repositoryMissing = repositoryQuery.error instanceof ApiError && repositoryQuery.error.status === 404;
  const repository = repositoryMissing ? null : repositoryQuery.data?.repository ?? null;
  const buildsQuery = useQuery({ queryKey: keys.builds, queryFn: api.listBuilds, enabled: Boolean(repository), refetchInterval: 3000 });
  const releasesQuery = useQuery({ queryKey: keys.releases, queryFn: api.listReleases, enabled: Boolean(repository), retry: false });
  const feedbackQuery = useQuery({ queryKey: keys.feedback(), queryFn: () => api.listFeedback(), enabled: Boolean(repository) });
  const [snapshot, setSnapshot] = useState<SnapshotSummary | null>(() => {
    const raw = sessionStorage.getItem(snapshotKey);
    return raw ? JSON.parse(raw) as SnapshotSummary : null;
  });
  const [reviewBuild, setReviewBuild] = useState<Build | null>(null);
  const [version, setVersion] = useState("1.0.0");
  const [eventState, setEventState] = useState<"idle" | "connecting" | "connected" | "reconnecting">("idle");

  const builds = buildsQuery.data?.builds ?? [];
  const releases = releasesQuery.data?.releases ?? [];
  const latestBuild = builds[0];
  const activeBuild = latestBuild && !terminal.has(latestBuild.status) ? latestBuild : undefined;
  const failedBuild = latestBuild?.status === "failed" ? latestBuild : undefined;
  const effectiveSnapshotId = snapshot?.snapshotId ?? failedBuild?.snapshotId;
  const requiredLoading = Boolean(repository) && (buildsQuery.isLoading || releasesQuery.isLoading);
  const blockingError = repositoryQuery.error && !repositoryMissing
    ? repositoryQuery.error
    : buildsQuery.error ?? releasesQuery.error;
  const action = blockingError || requiredLoading
    ? null
    : derivePrimaryAction({ repository, builds, releases, snapshotId: effectiveSnapshotId });

  useEffect(() => {
    if (!activeBuild) {
      setEventState("idle");
      return;
    }
    setEventState("connecting");
    const source = new EventSource(`/api/builds/${encodeURIComponent(activeBuild.id)}/events`);
    source.onopen = () => setEventState("connected");
    source.addEventListener("build", () => {
      setEventState("connected");
      void queryClient.invalidateQueries({ queryKey: keys.builds });
    });
    source.onerror = () => setEventState("reconnecting");
    return () => source.close();
  }, [activeBuild, queryClient]);

  const invalidate = async () => Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.builds }),
    queryClient.invalidateQueries({ queryKey: keys.releases })
  ]);
  const sync = useMutation({ mutationFn: api.syncRepository, onSuccess: (value) => {
    setSnapshot(value);
    sessionStorage.setItem(snapshotKey, JSON.stringify(value));
  } });
  const start = useMutation({ mutationFn: (id: string) => api.startBuild(id), onSuccess: invalidate });
  const createRelease = useMutation({
    mutationFn: ({ buildId, value }: { buildId: string; value: string }) => api.createRelease(buildId, value),
    onSuccess: async () => { setReviewBuild(null); await invalidate(); }
  });
  const publish = useMutation({ mutationFn: api.publishRelease, onSuccess: invalidate });
  const cancel = useMutation({ mutationFn: api.cancelBuild, onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.builds }) });
  const operationError = sync.error ?? start.error ?? createRelease.error ?? publish.error ?? cancel.error;

  const handlePrimary = () => {
    if (reviewBuild) {
      createRelease.mutate({ buildId: reviewBuild.id, value: version });
      return;
    }
    if (!action) return;
    if (action.kind === "connect") navigate("/settings?connect=1");
    if (action.kind === "sync") sync.mutate();
    if (["start-build", "retry-build"].includes(action.kind) && effectiveSnapshotId) start.mutate(effectiveSnapshotId);
    if (action.kind === "review") setReviewBuild(latestBuild?.status === "ready" ? latestBuild : null);
    if (action.kind === "publish") {
      const draft = releases.find((release) => release.buildId === latestBuild?.id && !release.publishedAt);
      if (draft) publish.mutate(draft.id);
    }
  };
  const commit = snapshot?.commitSha ?? latestBuild?.commitSha;
  const progress = useMemo(() => ({ queued: 8, syncing: 20, parsing: 42, synthesizing: 66, validating: 86, ready: 100, published: 100, failed: 100 }[activeBuild?.status ?? "queued"]), [activeBuild]);
  const retryOverview = () => void Promise.all([
    repositoryQuery.refetch(),
    ...(repository ? [buildsQuery.refetch(), releasesQuery.refetch()] : [])
  ]);

  if (repositoryQuery.isLoading) return <Loading label="Loading command console" />;
  return <div className="page overview-page">
    <header className="page-header"><div><p className="eyebrow">Operations</p><h1>Overview</h1><p>Repository knowledge status and the next required command.</p></div>
      {!blockingError && !requiredLoading && (reviewBuild || (action && action.kind !== "none")) && <button className="button primary command" onClick={handlePrimary} disabled={sync.isPending || start.isPending || publish.isPending || createRelease.isPending}>
        {!reviewBuild && action?.kind === "sync" && <RefreshCw aria-hidden="true" />}{!reviewBuild && ["start-build", "retry-build"].includes(action?.kind ?? "") && <Play aria-hidden="true" />}{!reviewBuild && action?.kind === "publish" && <Send aria-hidden="true" />}{(reviewBuild || ["connect", "review"].includes(action?.kind ?? "")) && <ArrowRight aria-hidden="true" />}{reviewBuild ? "Create release draft" : action?.label}
      </button>}
    </header>
    {blockingError && <div className="state error blocking-error" role="alert"><TriangleAlert aria-hidden="true" /><span>{errorMessage(blockingError)}</span><button className="button" onClick={retryOverview}>Retry overview data</button></div>}
    {requiredLoading && <Loading label="Loading build and release state" />}
    {!blockingError && operationError && <ErrorState message={errorMessage(operationError)} />}
    {!blockingError && !requiredLoading && <>
      <section className="repo-strip" aria-label="Repository state"><div><span>Repository</span><strong>{repository?.name ?? "Not connected"}</strong></div><div><span>Branch</span><strong><GitBranch aria-hidden="true" />{snapshot?.ref ?? repository?.defaultBranch ?? "-"}</strong></div><div><span>Commit</span><strong className="mono">{commit?.slice(0, 12) ?? "No snapshot"}</strong></div><div><span>Pending sync</span><strong>{snapshot ? (snapshot.unchanged ? "No changes" : `${snapshot.fileCount} files captured`) : repository ? "Required" : "-"}</strong></div></section>
      <section className="metric-grid" aria-label="Workspace summary"><article><span>Current release</span><strong>{releases.find((release) => release.publishedAt)?.version ?? "Unpublished"}</strong></article><article><span>Human exceptions</span><strong>{feedbackQuery.data?.feedback.filter((item) => ["open", "acknowledged"].includes(item.status)).length ?? 0}</strong></article><article><span>Builds</span><strong>{builds.length}</strong></article><article><span>Knowledge state</span><strong>{latestBuild?.status ?? "Not built"}</strong></article></section>
      {feedbackQuery.error && <ErrorState message={`Feedback count unavailable: ${errorMessage(feedbackQuery.error)}`} retry={() => void feedbackQuery.refetch()} />}
      {activeBuild && <section className="panel active-build"><div className="section-heading"><div><p className="eyebrow">Active build</p><h2>{activeBuild.status}</h2></div><Status value={activeBuild.status} /></div><div className="progress"><span style={{ width: `${progress}%` }} /></div><p className="muted">Commit <span className="mono">{activeBuild.commitSha.slice(0, 12)}</span>. {eventState === "reconnecting" ? "Reconnecting to build updates" : eventState === "connected" ? "Live updates connected" : "Connecting to live updates"}</p><button className="button danger" onClick={() => cancel.mutate(activeBuild.id)} disabled={activeBuild.cancelRequested}><Square aria-hidden="true" />{activeBuild.cancelRequested ? "Cancellation requested" : "Cancel build"}</button></section>}
      {failedBuild && <section className="panel failed-build" role="alert"><div className="section-heading"><div><p className="eyebrow">Build failed</p><h2>{failedBuild.errorMessage ?? "Knowledge build failed"}</h2></div><Status value="failed" /></div><p className="muted">Retry this snapshot after correcting the reported failure.</p></section>}
      {reviewBuild && <section className="panel review-panel" aria-label="Release review"><div><p className="eyebrow">Ready for review</p><h2>Build {reviewBuild.id.slice(0, 8)}</h2><p>Inspect generated knowledge, choose a version, then use the single command above to create the draft.</p></div><div className="review-actions"><button className="button" onClick={() => navigate("/knowledge")}>Inspect knowledge</button><label>Version<input value={version} onChange={(event) => setVersion(event.target.value)} /></label></div></section>}
      <section className="section"><div className="section-heading"><div><p className="eyebrow">History</p><h2>Recent builds</h2></div></div>{builds.length === 0 ? <Empty>No builds yet. Sync the repository to begin.</Empty> : <div className="table-wrap"><table><thead><tr><th>Status</th><th>Commit</th><th>Warnings</th><th>Build</th></tr></thead><tbody>{builds.map((build) => <tr key={build.id}><td><Status value={build.status} /></td><td className="mono">{build.commitSha.slice(0, 12)}</td><td>{build.warnings.length}</td><td className="mono">{build.id.slice(0, 8)}</td></tr>)}</tbody></table></div>}</section>
    </>}
  </div>;
}
