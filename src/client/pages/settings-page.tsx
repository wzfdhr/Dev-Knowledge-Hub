import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, LockKeyhole, PlugZap, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { errorMessage, LIST_PAGE_SIZE, type ApiClient } from "../api/client";
import type { McpToken, ModelProvider } from "../api/types";
import { Empty, ErrorState, Loading, Status } from "../components/ui";
import { keys } from "../hooks/use-domain";

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
  const closeRef = useRef<HTMLButtonElement>(null);
  const create = useMutation({ mutationFn: api.createMcpToken, onSuccess: async (value) => { setPlaintext(value.token); setTokenName(""); await queryClient.invalidateQueries({ queryKey: keys.tokens }); } });
  const revoke = useMutation({ mutationFn: api.revokeMcpToken, onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.tokens }) });
  useEffect(() => { if (plaintext) closeRef.current?.focus(); }, [plaintext]);
  const listedTokens: McpToken[] = tokens.data?.pages.flatMap((page) => page.tokens) ?? [];

  return <div className="page settings-page">
    <header className="page-header"><div><p className="eyebrow">系统管理</p><h1>设置</h1><p>管理模型运行时和全局安全配置。项目资料请在对应项目工作台中维护。</p></div></header>
    <div className="settings-stack">
      <section className="settings-section"><div className="settings-intro"><LockKeyhole aria-hidden="true" /><div><h2>模型服务商</h2><p>可选的加密服务商配置，用于增强知识内容。</p></div></div><ModelForm api={api} firstRun={params.get("connect") === "1"} /></section>
      <section className="settings-section"><div className="settings-intro"><PlugZap aria-hidden="true" /><div><h2>MCP 连接</h2><p>供编码 Agent 使用的连接元数据。</p></div></div>{connection.isLoading ? <Loading /> : connection.error ? <ErrorState message={errorMessage(connection.error)} /> : connection.data && <dl className="detail-list horizontal"><div><dt>端点</dt><dd className="mono">{connection.data.endpoint}</dd></div><div><dt>传输方式</dt><dd>{connection.data.transport}</dd></div><div><dt>授权方式</dt><dd>{connection.data.authorization}</dd></div><div><dt>工具</dt><dd>{connection.data.tools.length} 个可用</dd></div></dl>}</section>
      <section className="settings-section"><div className="settings-intro"><KeyRound aria-hidden="true" /><div><h2>访问 Token</h2><p>Token 明文仅在创建时展示一次。</p></div></div><form className="token-form" onSubmit={(event) => { event.preventDefault(); create.mutate(tokenName); }}><label>Token 名称<input required value={tokenName} onChange={(event) => setTokenName(event.target.value)} placeholder="本地 Agent" /></label><button className="button primary" disabled={create.isPending}>创建 Token</button></form>{create.error && <ErrorState message={errorMessage(create.error)} />}{tokens.isLoading ? <Loading /> : tokens.error ? <ErrorState message={errorMessage(tokens.error)} /> : listedTokens.length === 0 ? <Empty>尚未创建 MCP Token。</Empty> : <div><div className="token-list">{listedTokens.map((item) => <div key={item.id}><KeyRound aria-hidden="true" /><span><strong>{item.name}</strong><small className="mono">{item.tokenPrefix}</small></span><Status value={item.revokedAt ? "revoked" : "active"} />{!item.revokedAt && <button className="icon-button danger-text" aria-label={`撤销 ${item.name}`} onClick={() => revoke.mutate(item.id)}><Trash2 aria-hidden="true" /></button>}</div>)}</div>{tokens.hasNextPage && <button className="button continuation" onClick={() => void tokens.fetchNextPage()} disabled={tokens.isFetchingNextPage}>{tokens.isFetchingNextPage ? "正在加载 Token..." : "加载更多 Token"}</button>}</div>}</section>
    </div>
    {plaintext && <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="token-dialog-title"><div className="modal-icon"><KeyRound aria-hidden="true" /></div><h2 id="token-dialog-title">已创建 MCP Token</h2><p>请立即复制此 Token，它不会再次显示。</p><div className="secret-row"><code>{plaintext}</code><button className="icon-button" aria-label="复制 Token" onClick={async () => { await navigator.clipboard?.writeText(plaintext); setCopied(true); }}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button></div><button ref={closeRef} className="button primary full" onClick={() => { setPlaintext(null); setCopied(false); }}>我已复制</button></div></div>}
  </div>;
}
