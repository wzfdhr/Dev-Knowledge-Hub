import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { ApiError, errorMessage, type ApiClient } from "../api/client";
import {
  scanDirectory,
  scanSelectedFiles,
  type DirectoryDirectoryHandle,
  type FolderImportReport
} from "../api/folder-import";
import type { ImportProgress as ImportProgressValue, Repository, UploadSnapshotSummary } from "../api/types";
import { ImportHistory } from "../components/import-history";
import { FolderFilterReport, ImportResultReport } from "../components/import-report";
import { ImportProgress } from "../components/import-progress";
import { ImportSourceSwitcher, type ImportSourceKind } from "../components/import-source-switcher";
import { CoreFlowErrorCard, CoreFlowErrorDialog } from "../components/core-flow-error-dialog";
import { ErrorState, Loading } from "../components/ui";
import { describeCoreFlowError, type CoreFlowErrorDescriptor } from "../errors/core-flow-error";
import { keys, projectKeys } from "../hooks/use-domain";

function idleProgress(): ImportProgressValue {
  return { phase: "reading", status: "idle", percent: 0 };
}

function isTerminalUploadSessionError(error: unknown) {
  return error instanceof ApiError
    && [
      "UPLOAD_SESSION_EXPIRED",
      "UPLOAD_SESSION_INVALIDATED",
      "UPLOAD_SESSION_NOT_FOUND",
      "UPLOAD_SESSION_STATE",
      "IDEMPOTENCY_KEY_REUSED"
    ].includes(error.code);
}

export function ProjectImportsPage({ api, projectId: explicitProjectId }: { api: ApiClient; projectId?: string }) {
  const params = useParams();
  const projectId = explicitProjectId ?? params.projectId ?? "";
  const queryClient = useQueryClient();
  const folderInput = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const repository = useQuery({ queryKey: projectKeys.repository(projectId), queryFn: api.getRepository, retry: false });
  const importHistory = useQuery({
    queryKey: ["import-reports", projectId],
    queryFn: () => api.listImportReports(projectId, { limit: 20, offset: 0 }),
    retry: false
  });
  const missingRepository = repository.data?.repository === null
    || (repository.error instanceof ApiError && repository.error.status === 404);
  const currentRepository = repository.data?.repository ?? null;
  const [sourceKind, setSourceKind] = useState<ImportSourceKind>("upload");
  const [report, setReport] = useState<FolderImportReport | null>(null);
  const [completedFilter, setCompletedFilter] = useState<FolderImportReport["ignored"] | null>(null);
  const [progress, setProgress] = useState<ImportProgressValue>(idleProgress());
  const [result, setResult] = useState<UploadSnapshotSummary | null>(null);
  const [location, setLocation] = useState("");
  const [token, setToken] = useState("");
  const [uploadIssue, setUploadIssue] = useState<CoreFlowErrorDescriptor | null>(null);
  const [uploadIssueOpen, setUploadIssueOpen] = useState(false);

  useEffect(() => { folderInput.current?.setAttribute("webkitdirectory", ""); }, []);
  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result]);
  useEffect(() => {
    if (currentRepository) setSourceKind(currentRepository.kind);
  }, [currentRepository?.id, currentRepository?.kind]);

  const rememberSnapshot = async (upload: UploadSnapshotSummary, localReport: FolderImportReport | null) => {
    sessionStorage.setItem("devkh:last-snapshot", JSON.stringify({
      snapshotId: upload.snapshotId,
      commitSha: upload.sourceVersion,
      ref: "upload",
      fileCount: upload.fileCount,
      unchanged: upload.unchanged
    }));
    setResult(upload);
    setCompletedFilter(localReport?.ignored ?? null);
    setReport(null);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.repository }),
      queryClient.invalidateQueries({ queryKey: projectKeys.repository(projectId) }),
      queryClient.invalidateQueries({ queryKey: keys.builds }),
      queryClient.invalidateQueries({ queryKey: keys.releases }),
      queryClient.invalidateQueries({ queryKey: ["import-reports", projectId] })
    ]);
  };

  const ensureUploadSource = async (): Promise<{ repository: Repository; replacement: boolean }> => {
    if (currentRepository?.kind === "upload") return { repository: currentRepository, replacement: false };
    const name = currentRepository?.name ?? "上传项目";
    if (currentRepository) {
      const value = await api.replaceRepository({ kind: "upload", name });
      return { repository: value.repository, replacement: Boolean(value.pendingUpload) };
    }
    const value = await api.connectRepository({ kind: "upload", name });
    queryClient.setQueryData(projectKeys.repository(projectId), { repository: value.repository });
    return { repository: value.repository, replacement: false };
  };

  const upload = useMutation({
    mutationFn: async (files: FolderImportReport["acceptedFiles"]) => {
      const source = await ensureUploadSource();
      const sourceCount = files.filter((file) => file.kind === "source").length;
      setProgress({ phase: "uploading", status: "running", percent: 0, processedFiles: 0, totalFiles: sourceCount, detail: `正在上传 ${sourceCount} 个源码文件` });
      const summary = source.replacement
        ? await api.uploadReplacementFolder(projectId, source.repository.id, files, { onProgress: setProgress })
        : await api.uploadFolder(source.repository.projectId || projectId, source.repository.id, files, { onProgress: setProgress });
      return summary;
    },
    onSuccess: (value) => {
      setUploadIssue(null);
      setUploadIssueOpen(false);
      setProgress((current) => ({ ...current, phase: "snapshot", status: "completed", percent: 100, detail: value.unchanged ? "内容没有变化" : "已创建新的内容版本" }));
      void rememberSnapshot(value, report);
    },
    onError: (error) => {
      setUploadIssue(describeCoreFlowError("upload", error));
      setUploadIssueOpen(true);
      setProgress((value) => ({ ...value, status: "failed" }));
      if (isTerminalUploadSessionError(error)) setReport(null);
    }
  });

  const inspect = async (action: () => Promise<FolderImportReport>) => {
    setResult(null);
    setCompletedFilter(null);
    setReport(null);
    try {
      const value = await action();
      setReport(value);
    } catch (value) {
      setProgress((current) => ({ ...current, status: "failed", detail: errorMessage(value) }));
    }
  };

  const chooseFolder = () => {
    const picker = (window as Window & { showDirectoryPicker?: () => Promise<DirectoryDirectoryHandle> }).showDirectoryPicker;
    if (picker) {
      void inspect(async () => scanDirectory(await picker(), { onProgress: setProgress }));
    } else {
      folderInput.current?.click();
    }
  };

  const uploadFolder = () => { if (report) upload.mutate([...report.acceptedFiles, ...report.assetFiles]); };

  const connectAlternative = useMutation({
    mutationFn: () => {
      const name = currentRepository?.name ?? "项目仓库";
      const input = sourceKind === "local"
        ? { kind: "local" as const, name, path: location }
        : { kind: "git" as const, name, url: location, ...(token ? { token } : {}) };
      return currentRepository ? api.replaceRepository(input) : api.connectRepository(input);
    },
    onSuccess: (value) => {
      setLocation("");
      setToken("");
      setSourceKind(value.repository.kind);
      queryClient.setQueryData(projectKeys.repository(projectId), { repository: value.repository });
      void queryClient.invalidateQueries({ queryKey: ["import-reports", projectId] });
    }
  });

  if (repository.isLoading) return <div className="page"><Loading label="正在加载资料来源" /></div>;
  if (repository.error && !missingRepository) return <div className="page"><ErrorState message={errorMessage(repository.error)} retry={() => void repository.refetch()} /></div>;

  return <div className="page project-imports-page">
    <header className="page-header"><div><p className="eyebrow">项目资料</p><h1>资料接入</h1><p>管理项目资料来源并创建可追溯的内容版本。</p></div></header>
    <div className="project-imports-workspace">
      <input ref={folderInput} className="visually-hidden" aria-label="项目文件夹" type="file" multiple onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (files.length) void inspect(() => scanSelectedFiles(files, { onProgress: setProgress }));
      }} />
      <ImportSourceSwitcher
        value={sourceKind}
        currentRepository={currentRepository}
        location={location}
        token={token}
        pending={connectAlternative.isPending}
        errorMessage={connectAlternative.error ? errorMessage(connectAlternative.error) : undefined}
        onChange={setSourceKind}
        onLocationChange={setLocation}
        onTokenChange={setToken}
        onChooseFolder={chooseFolder}
        onSubmitAlternative={() => connectAlternative.mutate()}
      />
      {currentRepository && <p className="import-replacement-note">旧来源和已发布知识会保留为只读历史，新来源不会自动发布。</p>}
      <ImportProgress progress={progress} />
      {report && <div className="import-report-row"><FolderFilterReport report={report} /><div className="import-confirm-panel"><h2>确认上传这些资料</h2><p>{currentRepository && currentRepository.kind !== "upload" ? "当前资料来源会保留为只读归档，完成上传后切换到新内容版本。" : "上传完成后仍需人工构建并发布，当前线上知识不会自动变化。"}</p><Button type="primary" loading={upload.isPending} disabled={!report.acceptedFiles.length} onClick={uploadFolder}>确认并开始上传</Button></div></div>}
      {result && <div ref={resultRef} tabIndex={-1}><ImportResultReport upload={result} localIgnored={completedFilter} nextHref={`/projects/${projectId}/production`} /></div>}
      {uploadIssue && <CoreFlowErrorCard descriptor={uploadIssue} onRetry={uploadIssue.retryable ? uploadFolder : undefined} />}
      <CoreFlowErrorDialog descriptor={uploadIssue} open={uploadIssueOpen} onClose={() => setUploadIssueOpen(false)} onRetry={uploadIssue?.retryable ? uploadFolder : undefined} />
      <ImportHistory
        reports={importHistory.data?.reports ?? []}
        loading={importHistory.isLoading}
        error={importHistory.error}
        onRetry={() => void importHistory.refetch()}
      />
    </div>
  </div>;
}
