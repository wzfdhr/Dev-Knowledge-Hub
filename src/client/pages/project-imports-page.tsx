import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Modal, Segmented } from "antd";
import { FileArchive, FolderOpen, GitBranch, HardDriveUpload, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { ApiError, errorMessage, type ApiClient } from "../api/client";
import {
  packageFolderImport,
  scanDirectory,
  scanSelectedFiles,
  type DirectoryDirectoryHandle,
  type FolderImportReport
} from "../api/folder-import";
import {
  createUploadController,
  uploadProjectZipResumably,
  uploadReplacementZipResumably,
  type UploadController
} from "../api/resumable-upload";
import type { ImportProgress as ImportProgressValue, Repository, UploadSnapshotSummary } from "../api/types";
import { FolderFilterReport, formatBytes, ImportResultReport } from "../components/import-report";
import { ImportProgress } from "../components/import-progress";
import { ErrorState, Loading } from "../components/ui";
import { keys } from "../hooks/use-domain";

type SourceKind = "upload" | "git" | "local";

function idleProgress(): ImportProgressValue {
  return { phase: "reading", status: "idle", percent: 0 };
}

export function ProjectImportsPage({ api, projectId: explicitProjectId }: { api: ApiClient; projectId?: string }) {
  const params = useParams();
  const projectId = explicitProjectId ?? params.projectId ?? "";
  const queryClient = useQueryClient();
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const controller = useRef<UploadController | null>(null);
  const repository = useQuery({ queryKey: [...keys.repository, projectId], queryFn: api.getRepository, retry: false });
  const missingRepository = repository.error instanceof ApiError && repository.error.status === 404;
  const [sourceKind, setSourceKind] = useState<SourceKind>("upload");
  const [report, setReport] = useState<FolderImportReport | null>(null);
  const [zip, setZip] = useState<File | null>(null);
  const [progress, setProgress] = useState<ImportProgressValue>(idleProgress());
  const [result, setResult] = useState<UploadSnapshotSummary | null>(null);
  const [paused, setPaused] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [location, setLocation] = useState("");
  const [token, setToken] = useState("");

  useEffect(() => { folderInput.current?.setAttribute("webkitdirectory", ""); }, []);

  const rememberSnapshot = async (upload: UploadSnapshotSummary) => {
    sessionStorage.setItem("devkh:last-snapshot", JSON.stringify({
      snapshotId: upload.snapshotId,
      commitSha: upload.sourceVersion,
      ref: "upload",
      fileCount: upload.fileCount,
      unchanged: upload.unchanged
    }));
    setResult(upload);
    setReport(null);
    setZip(null);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.repository }),
      queryClient.invalidateQueries({ queryKey: keys.builds }),
      queryClient.invalidateQueries({ queryKey: keys.releases })
    ]);
  };

  const ensureUploadSource = async (): Promise<{ repository: Repository; replacement: boolean }> => {
    if (repository.data?.repository.kind === "upload") return { repository: repository.data.repository, replacement: false };
    const name = repository.data?.repository.name ?? "上传项目";
    if (repository.data) {
      const value = await api.replaceRepository({ kind: "upload", name });
      return { repository: value.repository, replacement: Boolean(value.pendingUpload) };
    }
    const value = await api.connectRepository({ kind: "upload", name });
    return { repository: value.repository, replacement: false };
  };

  const upload = useMutation({
    mutationFn: async (selectedFile?: File) => {
      const file = selectedFile ?? zip;
      if (!file) throw new Error("请选择项目文件夹或 ZIP 项目包");
      const source = await ensureUploadSource();
      const nextController = createUploadController();
      controller.current = nextController;
      const options = { controller: nextController, onTransferProgress: setProgress };
      return source.replacement
        ? uploadReplacementZipResumably(api, source.repository.id, file, options)
        : uploadProjectZipResumably(api, source.repository.projectId || projectId, file, options);
    },
    onSuccess: (value) => { controller.current = null; setPaused(false); void rememberSnapshot(value); },
    onError: () => { controller.current = null; setPaused(false); setProgress((value) => ({ ...value, status: "failed" })); }
  });

  const inspect = async (action: () => Promise<FolderImportReport>) => {
    setResult(null);
    setReport(null);
    setZip(null);
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

  const packageAndUpload = async () => {
    if (!report) return;
    try {
      const file = await packageFolderImport(report, { onProgress: setProgress });
      setZip(file);
      upload.mutate(file);
    } catch (value) {
      setProgress((current) => ({ ...current, status: "failed", detail: errorMessage(value) }));
    }
  };

  const connectAlternative = useMutation({
    mutationFn: () => {
      const name = repository.data?.repository.name ?? "项目仓库";
      const input = sourceKind === "local"
        ? { kind: "local" as const, name, path: location }
        : { kind: "git" as const, name, url: location, ...(token ? { token } : {}) };
      return repository.data ? api.replaceRepository(input) : api.connectRepository(input);
    },
    onSuccess: () => { setLocation(""); setToken(""); setReplaceOpen(false); void repository.refetch(); }
  });

  if (repository.isLoading) return <div className="page"><Loading label="正在加载资料来源" /></div>;
  if (repository.error && !missingRepository) return <div className="page"><ErrorState message={errorMessage(repository.error)} retry={() => void repository.refetch()} /></div>;

  return <div className="page project-imports-page">
    <header className="page-header"><div><p className="eyebrow">项目资料</p><h1>资料上传</h1><p>直接选择原始项目文件夹。系统会在本机自动过滤依赖、构建产物、二进制文件和敏感文件，再安全上传到服务器。</p></div>{repository.data && <Button icon={<FileArchive aria-hidden="true" />} onClick={() => setReplaceOpen(true)}>更换资料来源</Button>}</header>
    <div className="import-workspace">
      <section className="import-dropzone">
        <div className="import-dropzone-icon"><FolderOpen aria-hidden="true" /></div>
        <p className="eyebrow">推荐方式</p>
        <h2>选择完整项目文件夹</h2>
        <p>无需手动删除 <code>node_modules</code>、<code>dist</code> 或密钥文件，过滤发生在上传之前。</p>
        <input ref={folderInput} className="visually-hidden" type="file" multiple onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length) void inspect(() => scanSelectedFiles(files, { onProgress: setProgress }));
        }} />
        <Button type="primary" size="large" icon={<FolderOpen aria-hidden="true" />} onClick={chooseFolder}>选择项目文件夹</Button>
        <button className="import-zip-link" type="button" onClick={() => zipInput.current?.click()}><HardDriveUpload aria-hidden="true" />已有 ZIP？也可以直接上传</button>
        <input ref={zipInput} className="visually-hidden" aria-label="ZIP 项目包" type="file" accept="application/zip,.zip" onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          setZip(file);
          setReport(null);
          if (file) setProgress({ phase: "packaging", status: "completed", percent: 100, processedBytes: file.size, totalBytes: file.size, detail: `已选择 ${file.name}` });
        }} />
        {zip && !report && <div className="selected-archive"><FileArchive aria-hidden="true" /><span><strong>{zip.name}</strong><small>{formatBytes(zip.size)}</small></span><Button type="primary" loading={upload.isPending} onClick={() => upload.mutate(zip)}>开始上传</Button></div>}
      </section>
      <ImportProgress progress={progress} paused={paused} onPause={() => { controller.current?.pause(); setPaused(true); }} onResume={() => { controller.current?.resume(); setPaused(false); }} onCancel={() => controller.current?.cancel()} />
    </div>
    {report && <div className="import-report-row"><FolderFilterReport report={report} /><div className="import-confirm-panel"><h2>确认上传这些资料</h2><p>{repository.data && repository.data.repository.kind !== "upload" ? "当前资料来源会保留为只读归档，完成上传后切换到新内容版本。" : "上传完成后仍需人工构建并发布，当前线上知识不会自动变化。"}</p><Button type="primary" loading={upload.isPending} disabled={!report.acceptedFiles.length} onClick={() => void packageAndUpload()}>确认并开始上传</Button></div></div>}
    {result && <ImportResultReport upload={result} />}
    {upload.error && <ErrorState message={errorMessage(upload.error)} />}
    <section className="source-options"><div><p className="eyebrow">其他来源</p><h2>服务器目录或 Git 仓库</h2><p>本地路径只适用于服务器自身可以读取的目录；电脑上的项目优先使用文件夹上传。</p></div><Button onClick={() => setReplaceOpen(true)}>配置其他来源</Button></section>
    <Modal title="更换资料来源" open={replaceOpen} onCancel={() => setReplaceOpen(false)} footer={null} destroyOnHidden>
      <p className="modal-description">旧来源和已发布知识会保留为只读历史，新来源不会自动发布。</p>
      <Segmented block value={sourceKind} onChange={(value) => setSourceKind(value as SourceKind)} options={[
        { value: "upload", label: "文件夹 / ZIP", icon: <HardDriveUpload aria-hidden="true" /> },
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
