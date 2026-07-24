import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseBackup, KeyRound, LockKeyhole, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { errorMessage, type ApiClient } from "../api/client";
import type { ModelProvider } from "../api/types";
import { ErrorState, Loading } from "../components/ui";

function WorkspaceMcpForm({ api }: { api: ApiClient }) {
  const supported = typeof api.listWorkspaceMcpTokens === "function";
  const queryClient = useQueryClient();
  const tokens = useQuery({
    queryKey: ["workspace-mcp-tokens"],
    queryFn: () => api.listWorkspaceMcpTokens({ limit: 100, offset: 0 }),
    enabled: supported
  });
  const [name, setName] = useState("");
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.createWorkspaceMcpToken(name),
    onSuccess: async (value) => {
      setPlaintext(value.token);
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["workspace-mcp-tokens"] });
    }
  });
  const revoke = useMutation({
    mutationFn: api.revokeWorkspaceMcpToken,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workspace-mcp-tokens"] })
  });
  if (!supported) return null;
  return <section className="settings-section"><div className="settings-intro"><KeyRound aria-hidden="true" /><div><h2>Workspace Agent Token</h2><p>绑定当前用户会话，最长 30 天；用于团队经验查询与结构化方案上下文。</p></div></div>
    <form className="form-stack" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
      <label>Token 名称<input required value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：我的 Codex" /></label>
      <button className="button primary" disabled={create.isPending}>创建 Workspace Token</button>
    </form>
    {create.error && <ErrorState message={errorMessage(create.error)} />}
    {plaintext && <div className="secret-row"><code>{plaintext}</code><button className="button" type="button" onClick={() => setPlaintext(null)}>我已保存</button></div>}
    {tokens.isLoading ? <Loading label="正在加载 Workspace Token" /> : tokens.error ? <ErrorState message={errorMessage(tokens.error)} /> : <div className="codex-token-list">{tokens.data?.tokens.map((token) => <div key={token.id}><KeyRound aria-hidden="true" /><span><strong>{token.name}</strong><small className="mono">{token.tokenPrefix}</small><small>到期：{new Date(token.expiresAt).toLocaleDateString("zh-CN")}</small></span>{!token.revokedAt && <button className="button" type="button" aria-label={`撤销 ${token.name}`} onClick={() => revoke.mutate(token.id)}><Trash2 aria-hidden="true" /></button>}</div>)}</div>}
  </section>;
}

function ModelForm({ api }: { api: ApiClient }) {
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
      setProvider(value.config.provider);
      setModel(value.config.model);
      setApiKey("");
      void config.refetch();
    }
  });
  if (config.isLoading) return <Loading label="正在加载模型设置" />;
  if (config.error) return <ErrorState message={errorMessage(config.error)} retry={() => void config.refetch()} />;
  return <form className="form-stack" onSubmit={(event) => { event.preventDefault(); update.mutate(); }}>
    <div className="model-grid">
      <label>服务商<select value={provider} onChange={(event) => setProvider(event.target.value as ModelProvider)}><option value="openai">兼容 OpenAI</option><option value="anthropic">Anthropic</option></select></label>
      <label>模型<input required value={model} onChange={(event) => setModel(event.target.value)} placeholder={provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-5-mini"} /></label>
      <label>API Key <span>{config.data?.config?.hasApiKey ? "（留空以保留）" : ""}</span><input aria-label="API Key" name="model-api-key" required={!config.data?.config?.hasApiKey} type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={config.data?.config?.hasApiKey ? "已安全存储" : "启用所必需"} /></label>
    </div>
    {update.error && <ErrorState message={errorMessage(update.error)} />}
    {update.isSuccess && <p className="success-message">模型设置已保存。</p>}
    <button className="button primary" disabled={update.isPending}>保存模型设置</button>
  </form>;
}

function MfaForm({ api }: { api: ApiClient }) {
  const status = useQuery({ queryKey: ["mfa-status"], queryFn: api.getMfaStatus });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const enroll = useMutation({
    mutationFn: () => api.enrollMfa(password),
    onSuccess: (value) => { setEnrollment(value); setPassword(""); setCode(""); setRecoveryCodes([]); void status.refetch(); }
  });
  const verify = useMutation({
    mutationFn: () => api.verifyMfa(code),
    onSuccess: (value) => { setRecoveryCodes(value.recoveryCodes); setEnrollment(null); setCode(""); }
  });
  const disable = useMutation({
    mutationFn: () => api.disableMfa({ currentPassword: password, code }),
    onSuccess: () => { setPassword(""); setCode(""); setRecoveryCodes([]); void status.refetch(); }
  });
  if (recoveryCodes.length) return <div className="form-stack"><p className="success-message">MFA 已启用。恢复码仅显示一次。</p><pre className="recovery-codes">{recoveryCodes.join("\n")}</pre><button className="button primary" type="button" onClick={() => setRecoveryCodes([])}>我已保存恢复码</button></div>;
  if (status.isLoading) return <Loading label="正在加载 MFA 状态" />;
  if (status.error) return <ErrorState message={errorMessage(status.error)} retry={() => void status.refetch()} />;
  if (enrollment) return <form className="form-stack" onSubmit={(event) => { event.preventDefault(); verify.mutate(); }}>
    <label>密钥<input aria-label="TOTP 密钥" readOnly value={enrollment.secret} /></label>
    <label>验证代码<input inputMode="numeric" autoComplete="one-time-code" pattern="\\d{6}" required value={code} onChange={(event) => setCode(event.target.value)} /></label>
    {verify.error && <ErrorState message={errorMessage(verify.error)} />}
    <div className="form-actions"><button className="button primary" disabled={verify.isPending}>启用 MFA</button><button className="button" type="button" onClick={() => setEnrollment(null)}>取消</button></div>
  </form>;
  if (status.data?.enabled) return <form className="form-stack" onSubmit={(event) => { event.preventDefault(); disable.mutate(); }}>
    <p className="success-message">已启用</p>
    <label>当前密码<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
    <label>验证代码<input inputMode="numeric" autoComplete="one-time-code" pattern="\\d{6}" required value={code} onChange={(event) => setCode(event.target.value)} /></label>
    {disable.error && <ErrorState message={errorMessage(disable.error)} />}
    <button className="button" disabled={disable.isPending}>停用 MFA</button>
  </form>;
  return <form className="form-stack" onSubmit={(event) => { event.preventDefault(); enroll.mutate(); }}>
    <label>当前密码<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
    {enroll.error && <ErrorState message={errorMessage(enroll.error)} />}
    <button className="button primary" disabled={enroll.isPending}>设置 MFA</button>
  </form>;
}

export function SystemSettingsPage({ api }: { api: ApiClient }) {
  return <div className="page settings-page">
    <header className="page-header"><div><p className="eyebrow">系统管理</p><h1>设置</h1><p>只管理影响整个团队空间的模型、安全和存储策略。项目资料与 Codex 接入已移至项目工作台。</p></div></header>
    <div className="settings-stack">
      <section className="settings-section"><div className="settings-intro"><LockKeyhole aria-hidden="true" /><div><h2>模型服务商</h2><p>用于可选的中文摘要和知识增强。</p></div></div><ModelForm api={api} /></section>
      <section className="settings-section"><div className="settings-intro"><ShieldCheck aria-hidden="true" /><div><h2>多因素认证</h2><p>仅管理员账户可配置。</p></div></div><MfaForm api={api} /></section>
      <WorkspaceMcpForm api={api} />
      <section className="settings-section"><div className="settings-intro"><ShieldCheck aria-hidden="true" /><div><h2>安全策略</h2><p>工作区凭据与访问边界。</p></div></div><dl className="detail-list horizontal"><div><dt>凭据加密</dt><dd>AES-256-GCM</dd></div><div><dt>会话</dt><dd>安全 HttpOnly Cookie</dd></div><div><dt>项目访问</dt><dd>Token 按项目隔离</dd></div><div><dt>明文 Token</dt><dd>仅创建时展示</dd></div></dl></section>
      <section className="settings-section"><div className="settings-intro"><DatabaseBackup aria-hidden="true" /><div><h2>存储与备份</h2><p>线上资料的持久化边界。</p></div></div><dl className="detail-list horizontal"><div><dt>长期保存</dt><dd>过滤后的源码、配置和文档</dd></div><div><dt>原始压缩包</dt><dd>导入成功后删除</dd></div><div><dt>知识版本</dt><dd>不可变快照</dd></div><div><dt>发布切换</dt><dd>人工确认后原子切换</dd></div></dl></section>
    </div>
  </div>;
}
