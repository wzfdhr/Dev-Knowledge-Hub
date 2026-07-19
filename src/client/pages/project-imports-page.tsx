import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Modal, Segmented, Tag } from "antd";
import { FolderOpen, GitBranch, HardDriveUpload, Server } from "lucide-react";
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
import { FolderFilterReport, formatBytes, ImportResultReport } from "../components/import-report";
import { ImportProgress } from "../components/import-progress";
import { ErrorState, Loading } from "../components/ui";
import { keys, projectKeys } from "../hooks/use-domain";

type SourceKind = "upload" | "git" | "local";

function idleProgress(): ImportProgressValue {
  return { phase: "reading", status: "idle", percent: 0 };
}

function uploadFailure(error: unknown): { message: string; description: string } {
  if (error instanceof ApiError && ["UPLOAD_SESSION_EXPIRED", "UPLOAD_SESSION_INVALIDATED", "UPLOAD_SESSION_NOT_FOUND"].includes(error.code)) {
    return {
      message: "上传会话已失效，请重新选择项目文件夹",
      description: "当前已发布知识不会自动变化。请先刷新导入历史确认处理结果；重新选择后会开始新的安全上传。"
    };
  }
  if (!(error instanceof ApiError) || error.status >= 500 || ["TEMPORARY", "RATE_LIMITED"].includes(error.code)) {
    return {
      message: "上传暂时中断，已验证文件会保留约 24 小时",
      description: "上传结果尚未确认，当前已发布知识不会自动变化。直接安全重试，或刷新后重新选择同一文件夹即可继续；不会重复上传已验证文件，也不会重复创建内容版本。"
    };
  }
  const knownMessages: Record<string, string> = {
    TOO_MANY_FILES: "可采集文件数量超过上限",
    FOLDER_SIZE_LIMIT: "可采集源码总大小超过 2 GiB",
    MANIFEST_INCOMPLETE: "文件清单不完整，请重新选择项目文件夹",
    MANIFEST_DIGEST_MISMATCH: "文件夹内容已变化，请重新选择后再试",
    PROJECT_ACCESS_DENIED: "你已没有该项目的上传权限",
    UPLOAD_SESSION_STATE: "当前上传状态无法继续，请重新选择项目文件夹"
  };
  return {
    message: knownMessages[error.code] ?? "上传未完成，请检查项目文件夹后重试",
    description: `当前已发布知识不会自动变化。请刷新导入历史确认处理结果，修正问题后可以安全重试。错误代码：${error.code}`
  };
}

export function ProjectImportsPage({ api, projectId: explicitProjectId }: { api: ApiClient; projectId?: string }) {
  const params = useParams();
  const projectId = explicitProjectId ?? params.projectId ?? "";
  const queryClient = useQueryClient();
  const folderInput = useRef<HTMLInputElement>(null);
  const repository = useQuery({ queryKey: projectKeys.repository(projectId), queryFn: api.getRepository, retry: false });
  const importHistory = useQuery({
    queryKey: ["import-reports", projectId],
    queryFn: () => api.listImportReports(projectId, { limit: 20, offset: 0 }),
    retry: false
  });
  const missingRepository = repository.data?.repository === null
    || (repository.error instanceof ApiError && repository.error.status === 404);
  const currentRepository = repository.data?.repository ?? null;
  const [sourceKind, setSourceKind] = useState<SourceKind>("upload");
  const [report, setReport] = useState<FolderImportReport | null>(null);
  const [completedFilter, setCompletedFilter] = useState<FolderImportReport["ignored"] | null>(null);
  const [progress, setProgress] = useState<ImportProgressValue>(idleProgress());
  const [result, setResult] = useState<UploadSnapshotSummary | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [location, setLocation] = useState("");
  const [token, setToken] = useState("");

  useEffect(() => { folderInput.current?.setAttribute("webkitdirectory", ""); }, []);

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
      setProgress((current) => ({ ...current, phase: "snapshot", status: "completed", percent: 100, detail: value.unchanged ? "内容没有变化" : "已创建新的内容版本" }));
      void rememberSnapshot(value, report);
    },
    onError: () => { setProgress((value) => ({ ...value, status: "failed" })); }
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
    onSuccess: () => { setLocation(""); setToken(""); setReplaceOpen(false); void repository.refetch(); }
  });

  if (repository.isLoading) return <div className="page"><Loading label="正在加载资料来源" /></div>;
  if (repository.error && !missingRepository) return <div className="page"><ErrorState message={errorMessage(repository.error)} retry={() => void repository.refetch()} /></div>;

  return <div className="page project-imports-page">
    <header className="page-header"><div><p className="eyebrow">项目资料</p><h1>资料上传</h1><p>直接选择原始项目文件夹。系统会在本机过滤依赖、构建产物和敏感文件；图片、字体等资源只登记元数据，不读取或上传内容。</p></div>{currentRepository && <Button icon={<FolderOpen aria-hidden="true" />} onClick={() => setReplaceOpen(true)}>更换资料来源</Button>}</header>
    <div className="import-workspace">
      <section className="import-dropzone">
        <div className="import-dropzone-icon"><FolderOpen aria-hidden="true" /></div>
        <p className="eyebrow">推荐方式</p>
        <h2>选择完整项目文件夹</h2>
        <p>无需手动删除 <code>node_modules</code>、<code>dist</code> 或密钥文件，过滤发生在上传之前。</p>
        <p className="import-resume-note">上传中断后，会话最多保留 24 小时；重新选择同一文件夹即可继续，已验证文件不会重复上传。</p>
        <p className="import-limit-note">单次上限：100,000 条清单、50,000 个源码文件、2 GiB 可采集源码。</p>
        <input ref={folderInput} className="visually-hidden" aria-label="项目文件夹" type="file" multiple onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length) void inspect(() => scanSelectedFiles(files, { onProgress: setProgress }));
        }} />
        <Button type="primary" size="large" icon={<FolderOpen aria-hidden="true" />} onClick={chooseFolder}>选择项目文件夹</Button>
      </section>
      <ImportProgress progress={progress} />
    </div>
    {report && <div className="import-report-row"><FolderFilterReport report={report} /><div className="import-confirm-panel"><h2>确认上传这些资料</h2><p>{currentRepository && currentRepository.kind !== "upload" ? "当前资料来源会保留为只读归档，完成上传后切换到新内容版本。" : "上传完成后仍需人工构建并发布，当前线上知识不会自动变化。"}</p><Button type="primary" loading={upload.isPending} disabled={!report.acceptedFiles.length} onClick={uploadFolder}>确认并开始上传</Button></div></div>}
    {result && <ImportResultReport upload={result} localIgnored={completedFilter} />}
    {upload.error && <ErrorState {...uploadFailure(upload.error)} retry={uploadFolder} />}
    <section className="import-history" aria-labelledby="import-history-title">
      <header><div><p className="eyebrow">服务端记录</p><h2 id="import-history-title">导入历史</h2></div></header>
      {importHistory.isLoading ? <Loading label="正在加载导入历史" /> : importHistory.error ? <ErrorState message={errorMessage(importHistory.error)} retry={() => void importHistory.refetch()} /> : importHistory.data?.reports.length ? <div className="import-history-list">{importHistory.data.reports.map((item) => <div className="import-history-item" key={item.id}><div><strong>{item.sourceKind === "upload" ? "文件夹上传" : item.sourceKind}</strong><small>{new Date(item.startedAt).toLocaleString("zh-CN")}</small></div><div><span>{item.collectedFileCount} 个文件 · {formatBytes(item.collectedTextBytes)}</span>{item.ignored.total > 0 && <small>服务端过滤 {item.ignored.total} 项</small>}</div><div>{item.status === "succeeded" ? <Tag color="green">成功</Tag> : item.status === "failed" ? <Tag color="red">失败</Tag> : <Tag>{item.status === "running" ? "进行中" : "已取消"}</Tag>}{item.failureCode && <small>{item.failureCode}</small>}</div></div>)}</div> : <div className="document-empty"><h2>暂无服务端导入记录</h2><p>完成一次资料上传后，这里会显示服务端实际采集结果和二次过滤原因。</p></div>}
    </section>
    <section className="source-options"><div><p className="eyebrow">其他来源</p><h2>服务器目录或 Git 仓库</h2><p>本地路径只适用于服务器自身可以读取的目录；电脑上的项目优先使用文件夹上传。</p></div><Button onClick={() => setReplaceOpen(true)}>配置其他来源</Button></section>
    <Modal title="更换资料来源" open={replaceOpen} onCancel={() => setReplaceOpen(false)} footer={null} destroyOnHidden>
      <p className="modal-description">旧来源和已发布知识会保留为只读历史，新来源不会自动发布。</p>
      <Segmented block value={sourceKind} onChange={(value) => setSourceKind(value as SourceKind)} options={[
        { value: "upload", label: "项目文件夹", icon: <HardDriveUpload aria-hidden="true" /> },
        { value: "git", label: "Git HTTPS", icon: <GitBranch aria-hidden="true" /> },
        { value: "local", label: "服务器路径", icon: <Server aria-hidden="true" /> }
      ]} />
      {sourceKind === "upload" ? <div className="modal-upload-choice"><p>关闭此窗口后，使用页面上方的“选择项目文件夹”即可更换来源。</p><Button type="primary" onClick={() => { setReplaceOpen(false); chooseFolder(); }}>选择项目文件夹</Button></div> : <form className="form-stack modal-source-form" onSubmit={(event) => { event.preventDefault(); connectAlternative.mutate(); }}>
        <label>{sourceKind === "git" ? "HTTPS URL" : "服务器绝对路径"}<input required type={sourceKind === "git" ? "url" : "text"} value={location} onChange={(event) => setLocation(event.target.value)} placeholder={sourceKind === "git" ? "https://github.com/org/repo.git" : "/srv/projects/example"} /></label>
        {sourceKind === "git" && <label>个人访问 Token <span>（可选）</span><input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></label>}
        {connectAlternative.error && <ErrorState message={errorMessage(connectAlternative.error)} />}
        <Button type="primary" htmlType="submit" loading={connectAlternative.isPending}>确认更换</Button>
      </form>}
    </Modal>
  </div>;
}
