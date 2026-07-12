import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, FileArchive, KeyRound, Link2, LockKeyhole, PlugZap, ShieldCheck, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { ApiError, errorMessage, LIST_PAGE_SIZE, type ApiClient } from "../api/client";
import type { McpToken, ModelProvider, UploadSnapshotSummary } from "../api/types";
import { Empty, ErrorState, Loading, Status } from "../components/ui";
import { keys, useRepository } from "../hooks/use-domain";

type RepositoryInput =
  | { kind: "local"; name: string; path: string }
  | { kind: "git"; name: string; url: string; token?: string }
  | { kind: "upload"; name: string };

const ignoredReasonLabel: Record<string, string> = {
  binary: "二进制文件",
  excluded_directory: "忽略目录",
  file_too_large: "超过大小限制",
  generated: "生成文件",
  sensitive_file: "敏感文件",
  unsupported_extension: "不支持的文件类型"
};

function UploadSummary({ upload }: { upload: UploadSnapshotSummary }) {
  const reasons = Object.entries(upload.ignored.reasons)
    .map(([reason, count]) => `${ignoredReasonLabel[reason] ?? reason} ${count}`)
    .join("、");
  return <p className="success-message">已采集 {upload.fileCount} 个文件；<strong>已忽略 {upload.ignored.total} 个文件</strong>{reasons ? `（${reasons}）` : ""}。</p>;
}

function ConnectionForm({ api, onConnected, mode = "connect" }: {
  api: ApiClient;
  onConnected: (upload?: UploadSnapshotSummary) => void;
  mode?: "connect" | "replace";
}) {
  const [kind, setKind] = useState<RepositoryInput["kind"]>("local");
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [token, setToken] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const connect = useMutation({
    mutationFn: async () => {
      if (kind === "upload" && !file) throw new Error("请选择 ZIP 项目包");
      const input: RepositoryInput = kind === "local"
        ? { kind, name, path: location }
        : kind === "git"
          ? { kind, name, url: location, ...(token ? { token } : {}) }
          : { kind, name };
      const connection = mode === "replace"
        ? await api.replaceRepository(input)
        : await api.connectRepository(input);
      if (kind === "upload") {
        return mode === "replace" && "pendingUpload" in connection && connection.pendingUpload
          ? api.uploadReplacementZip(connection.repository.id, file!)
          : api.uploadZip(file!);
      }
      return undefined;
    },
    onSuccess: (upload) => { setToken(""); setFile(null); onConnected(upload); }
  });
  return <form className="form-stack" onSubmit={(event) => { event.preventDefault(); connect.mutate(); }}><div className="segmented compact" role="group" aria-label="仓库类型"><button type="button" aria-pressed={kind === "local"} onClick={() => setKind("local")}>本地路径</button><button type="button" aria-pressed={kind === "git"} onClick={() => setKind("git")}>Git HTTPS</button><button type="button" aria-pressed={kind === "upload"} onClick={() => setKind("upload")}>上传 ZIP</button></div><label>仓库名称<input required value={name} onChange={(event) => setName(event.target.value)} /></label>{kind === "upload" ? <label>ZIP 项目包<input aria-label="ZIP 项目包" type="file" accept="application/zip,.zip" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label> : <><label>{kind === "local" ? "本地路径" : "HTTPS URL"}<input required type={kind === "git" ? "url" : "text"} value={location} onChange={(event) => setLocation(event.target.value)} placeholder={kind === "local" ? "/path/to/repository" : "https://github.com/org/repo.git"} /></label>{kind === "git" && <label>个人访问 Token <span>（可选）</span><input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></label>}</>}{connect.error && <ErrorState message={errorMessage(connect.error)} />}<button className="button primary" disabled={connect.isPending}><Link2 aria-hidden="true" />{connect.isPending ? "正在处理中..." : mode === "replace" ? "确认更换" : "连接仓库"}</button></form>;
}

function UploadForm({ api, onUploaded }: { api: ApiClient; onUploaded: (upload: UploadSnapshotSummary) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const upload = useMutation({ mutationFn: () => {
    if (!file) throw new Error("请选择 ZIP 项目包");
    return api.uploadZip(file);
  }, onSuccess: (value) => { setFile(null); onUploaded(value); } });
  return <form className="form-stack" onSubmit={(event) => { event.preventDefault(); upload.mutate(); }}><label>更新 ZIP 项目包<input aria-label="更新 ZIP 项目包" type="file" accept="application/zip,.zip" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>{upload.error && <ErrorState message={errorMessage(upload.error)} />} {upload.isSuccess && <p className="success-message">已创建新的不可变内容版本，请前往总览构建知识。</p>}<button className="button primary" disabled={upload.isPending}><Upload aria-hidden="true" />{upload.isPending ? "正在导入..." : "导入 ZIP"}</button></form>;
}

function ModelForm({ api, firstRun }: { api: ApiClient; firstRun: boolean }) {
  const config = useQuery({ queryKey: ["model-config"], queryFn: api.getModelConfig });
  const [provider, setProvider] = useState<ModelProvider>("openai");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  useEffect(() => {
    if (!config.data?.config) return;
    setProvider(config.data.config.provider);
    setModel(config.data.config.model);
  }, [config.data]);
  const update = useMutation({
    mutationFn: () => api.updateModelConfig({ provider, model, apiKey }),
    onSuccess: (value) => {
      config.refetch();
      setProvider(value.config.provider);
      setModel(value.config.model);
      setApiKey("");
    }
  });
  if (config.isLoading) return <Loading label="正在加载模型设置" />;
  if (config.error) return <ErrorState message={errorMessage(config.error)} retry={() => void config.refetch()} />;
  return <form className="form-stack" onSubmit={(event) => { event.preventDefault(); update.mutate(); }}>
    {firstRun && <p className="field-note first-run-note">首次设置可选。保存服务商配置，或跳过并连接仓库。</p>}
    <div className="model-grid">
      <label>服务商<select value={provider} onChange={(event) => setProvider(event.target.value as ModelProvider)}><option value="openai">兼容 OpenAI</option><option value="anthropic">Anthropic</option></select></label>
      <label>模型<input required value={model} onChange={(event) => setModel(event.target.value)} placeholder={provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-5-mini"} /></label>
      <label>API Key <span>{config.data?.config?.hasApiKey ? "（留空以保留）" : ""}</span><input aria-label="API Key" required={!config.data?.config?.hasApiKey} type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={config.data?.config?.hasApiKey ? "已安全存储" : "启用所必需"} /></label>
    </div>
    {update.error && <ErrorState message={errorMessage(update.error)} />}
    {update.isSuccess && <p className="success-message">模型设置已保存。</p>}
    <div className="inline-actions"><button className="button primary" disabled={update.isPending}>保存模型设置</button>{firstRun && <a className="button" href="#repository">暂时跳过</a>}</div>
  </form>;
}

export function SettingsPage({ api }: { api: ApiClient }) {
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const repository = useRepository(api);
  const missingRepository = repository.error instanceof ApiError && repository.error.status === 404;
  const archived = useQuery({ queryKey: ["archived-repositories"], queryFn: () => (api as Partial<ApiClient>).listArchivedRepositories?.() ?? Promise.resolve({ repositories: [] }), enabled: Boolean(repository.data) });
  const connection = useQuery({ queryKey: ["mcp-connection"], queryFn: api.getMcpConnection });
  const tokens = useInfiniteQuery({
    queryKey: keys.tokens,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.listMcpTokens({ limit: LIST_PAGE_SIZE, offset: pageParam }),
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined
  });
  const [tokenName, setTokenName] = useState("");
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [lastUpload, setLastUpload] = useState<UploadSnapshotSummary | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const create = useMutation({ mutationFn: api.createMcpToken, onSuccess: async (value) => { setPlaintext(value.token); setTokenName(""); await queryClient.invalidateQueries({ queryKey: keys.tokens }); } });
  const revoke = useMutation({ mutationFn: api.revokeMcpToken, onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.tokens }) });
  useEffect(() => { if (plaintext) closeRef.current?.focus(); }, [plaintext]);
  const listedTokens: McpToken[] = tokens.data?.pages.flatMap((page) => page.tokens) ?? [];
  const refreshRepository = (upload?: UploadSnapshotSummary) => {
    if (upload) {
      setLastUpload(upload);
      sessionStorage.setItem("devkh:last-snapshot", JSON.stringify({
        snapshotId: upload.snapshotId,
        commitSha: upload.sourceVersion,
        ref: "upload",
        fileCount: upload.fileCount,
        unchanged: upload.unchanged
      }));
    }
    void Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.repository }),
    queryClient.invalidateQueries({ queryKey: keys.builds }),
    queryClient.invalidateQueries({ queryKey: keys.releases }),
    queryClient.invalidateQueries({ queryKey: ["feedback"] }),
    queryClient.invalidateQueries({ queryKey: ["archived-repositories"] })
    ]);
  };

  return <div className="page settings-page">
    <header className="page-header"><div><p className="eyebrow">工作区管理</p><h1>设置</h1><p>管理仓库、模型运行时和 Agent 访问。</p></div></header>
    <div className="settings-stack">
      <section className="settings-section" id="repository"><div className="settings-intro"><Link2 aria-hidden="true" /><div><h2>仓库</h2><p>保存后会脱敏来源连接信息。</p></div></div>{lastUpload && <UploadSummary upload={lastUpload} />}{repository.isLoading ? <Loading /> : missingRepository ? <ConnectionForm api={api} onConnected={refreshRepository} /> : repository.error ? <ErrorState message={errorMessage(repository.error)} /> : repository.data && <div><dl className="detail-list horizontal"><div><dt>名称</dt><dd>{repository.data.repository.name}</dd></div><div><dt>类型</dt><dd>{repository.data.repository.kind === "local" ? "本地路径" : repository.data.repository.kind === "upload" ? "上传 ZIP" : "Git HTTPS"}</dd></div>{repository.data.repository.kind !== "upload" && <div><dt>位置</dt><dd className="mono break">{repository.data.repository.path ?? repository.data.repository.url}</dd></div>}{repository.data.repository.kind === "git" && <div><dt>凭据</dt><dd><ShieldCheck aria-hidden="true" />{repository.data.repository.hasCredential ? "已加密存储" : "未配置"}</dd></div>}</dl>{repository.data.repository.kind === "upload" && <UploadForm api={api} onUploaded={refreshRepository} />}<button className="button" onClick={() => setReplaceOpen(true)}><FileArchive aria-hidden="true" />更换仓库</button>{archived.data?.repositories.length ? <div className="archive-list"><h3>已归档仓库</h3>{archived.data.repositories.map((item) => <p key={item.id}><strong>{item.name}</strong><span>{item.kind === "upload" ? "上传 ZIP" : item.kind === "local" ? "本地路径" : "Git HTTPS"} · {new Date(item.archivedAt).toLocaleString()}</span></p>)}</div> : null}</div>}{params.get("connect") && !missingRepository && <p className="success-message">仓库已连接。</p>}</section>
      <section className="settings-section"><div className="settings-intro"><LockKeyhole aria-hidden="true" /><div><h2>模型服务商</h2><p>可选的加密服务商配置，用于增强知识内容。</p></div></div><ModelForm api={api} firstRun={params.get("connect") === "1" && missingRepository} /></section>
      <section className="settings-section"><div className="settings-intro"><PlugZap aria-hidden="true" /><div><h2>MCP 连接</h2><p>供编码 Agent 使用的连接元数据。</p></div></div>{connection.isLoading ? <Loading /> : connection.error ? <ErrorState message={errorMessage(connection.error)} /> : connection.data && <dl className="detail-list horizontal"><div><dt>端点</dt><dd className="mono">{connection.data.endpoint}</dd></div><div><dt>传输方式</dt><dd>{connection.data.transport}</dd></div><div><dt>授权方式</dt><dd>{connection.data.authorization}</dd></div><div><dt>工具</dt><dd>{connection.data.tools.length} 个可用</dd></div></dl>}</section>
      <section className="settings-section"><div className="settings-intro"><KeyRound aria-hidden="true" /><div><h2>访问 Token</h2><p>Token 明文仅在创建时展示一次。</p></div></div><form className="token-form" onSubmit={(event) => { event.preventDefault(); create.mutate(tokenName); }}><label>Token 名称<input required value={tokenName} onChange={(event) => setTokenName(event.target.value)} placeholder="本地 Agent" /></label><button className="button primary" disabled={create.isPending}>创建 Token</button></form>{create.error && <ErrorState message={errorMessage(create.error)} />}{tokens.isLoading ? <Loading /> : tokens.error ? <ErrorState message={errorMessage(tokens.error)} /> : listedTokens.length === 0 ? <Empty>尚未创建 MCP Token。</Empty> : <div><div className="token-list">{listedTokens.map((item) => <div key={item.id}><KeyRound aria-hidden="true" /><span><strong>{item.name}</strong><small className="mono">{item.tokenPrefix}</small></span><Status value={item.revokedAt ? "revoked" : "active"} />{!item.revokedAt && <button className="icon-button danger-text" aria-label={`撤销 ${item.name}`} onClick={() => revoke.mutate(item.id)}><Trash2 aria-hidden="true" /></button>}</div>)}</div>{tokens.hasNextPage && <button className="button continuation" onClick={() => void tokens.fetchNextPage()} disabled={tokens.isFetchingNextPage}>{tokens.isFetchingNextPage ? "正在加载 Token..." : "加载更多 Token"}</button>}</div>}</section>
    </div>
    {replaceOpen && repository.data && <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="replace-repository-title"><div className="modal-icon"><FileArchive aria-hidden="true" /></div><h2 id="replace-repository-title">更换仓库</h2><p>当前仓库“{repository.data.repository.name}”会保留为只读归档历史。新的仓库不会自动同步、构建或发布。</p><ConnectionForm api={api} mode="replace" onConnected={(upload) => { setReplaceOpen(false); refreshRepository(upload); }} /><button className="button full" onClick={() => setReplaceOpen(false)}>取消</button></div></div>}
    {plaintext && <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="token-dialog-title"><div className="modal-icon"><KeyRound aria-hidden="true" /></div><h2 id="token-dialog-title">已创建 MCP Token</h2><p>请立即复制此 Token，它不会再次显示。</p><div className="secret-row"><code>{plaintext}</code><button className="icon-button" aria-label="复制 Token" onClick={async () => { await navigator.clipboard?.writeText(plaintext); setCopied(true); }}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button></div><button ref={closeRef} className="button primary full" onClick={() => { setPlaintext(null); setCopied(false); }}>我已复制</button></div></div>}
  </div>;
}
