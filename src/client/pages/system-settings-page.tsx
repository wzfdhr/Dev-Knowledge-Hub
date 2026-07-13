import { useMutation, useQuery } from "@tanstack/react-query";
import { DatabaseBackup, LockKeyhole, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { errorMessage, type ApiClient } from "../api/client";
import type { ModelProvider } from "../api/types";
import { ErrorState, Loading } from "../components/ui";

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
      <label>API Key <span>{config.data?.config?.hasApiKey ? "（留空以保留）" : ""}</span><input aria-label="API Key" required={!config.data?.config?.hasApiKey} type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={config.data?.config?.hasApiKey ? "已安全存储" : "启用所必需"} /></label>
    </div>
    {update.error && <ErrorState message={errorMessage(update.error)} />}
    {update.isSuccess && <p className="success-message">模型设置已保存。</p>}
    <button className="button primary" disabled={update.isPending}>保存模型设置</button>
  </form>;
}

export function SystemSettingsPage({ api }: { api: ApiClient }) {
  return <div className="page settings-page">
    <header className="page-header"><div><p className="eyebrow">系统管理</p><h1>设置</h1><p>只管理影响整个团队空间的模型、安全和存储策略。项目资料与 Codex 接入已移至项目工作台。</p></div></header>
    <div className="settings-stack">
      <section className="settings-section"><div className="settings-intro"><LockKeyhole aria-hidden="true" /><div><h2>模型服务商</h2><p>用于可选的中文摘要和知识增强。</p></div></div><ModelForm api={api} /></section>
      <section className="settings-section"><div className="settings-intro"><ShieldCheck aria-hidden="true" /><div><h2>安全策略</h2><p>工作区凭据与访问边界。</p></div></div><dl className="detail-list horizontal"><div><dt>凭据加密</dt><dd>AES-256-GCM</dd></div><div><dt>会话</dt><dd>安全 HttpOnly Cookie</dd></div><div><dt>项目访问</dt><dd>Token 按项目隔离</dd></div><div><dt>明文 Token</dt><dd>仅创建时展示</dd></div></dl></section>
      <section className="settings-section"><div className="settings-intro"><DatabaseBackup aria-hidden="true" /><div><h2>存储与备份</h2><p>线上资料的持久化边界。</p></div></div><dl className="detail-list horizontal"><div><dt>长期保存</dt><dd>过滤后的源码、配置和文档</dd></div><div><dt>原始压缩包</dt><dd>导入成功后删除</dd></div><div><dt>知识版本</dt><dd>不可变快照</dd></div><div><dt>发布切换</dt><dd>人工确认后原子切换</dd></div></dl></section>
    </div>
  </div>;
}

