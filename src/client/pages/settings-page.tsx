import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Link2, LockKeyhole, PlugZap, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { ApiError, errorMessage, LIST_PAGE_SIZE, type ApiClient } from "../api/client";
import type { McpToken, ModelProvider } from "../api/types";
import { Empty, ErrorState, Loading, Status } from "../components/ui";
import { keys, useRepository } from "../hooks/use-domain";

function ConnectionForm({ api, onConnected }: { api: ApiClient; onConnected: () => void }) {
  const [kind, setKind] = useState<"local" | "git">("local");
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [token, setToken] = useState("");
  const connect = useMutation({ mutationFn: () => api.connectRepository(kind === "local" ? { kind, name, path: location } : { kind, name, url: location, ...(token ? { token } : {}) }), onSuccess: () => { setToken(""); onConnected(); } });
  return <form className="form-stack" onSubmit={(event) => { event.preventDefault(); connect.mutate(); }}><div className="segmented compact" role="group" aria-label="Repository type"><button type="button" aria-pressed={kind === "local"} onClick={() => setKind("local")}>Local path</button><button type="button" aria-pressed={kind === "git"} onClick={() => setKind("git")}>Git HTTPS</button></div><label>Repository name<input required value={name} onChange={(event) => setName(event.target.value)} /></label><label>{kind === "local" ? "Local path" : "HTTPS URL"}<input required type={kind === "git" ? "url" : "text"} value={location} onChange={(event) => setLocation(event.target.value)} placeholder={kind === "local" ? "/path/to/repository" : "https://github.com/org/repo.git"} /></label>{kind === "git" && <label>Personal access token <span>(optional)</span><input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></label>}{connect.error && <ErrorState message={errorMessage(connect.error)} />}<button className="button primary" disabled={connect.isPending}><Link2 aria-hidden="true" />{connect.isPending ? "Connecting..." : "Connect repository"}</button></form>;
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
  if (config.isLoading) return <Loading label="Loading model settings" />;
  if (config.error) return <ErrorState message={errorMessage(config.error)} retry={() => void config.refetch()} />;
  return <form className="form-stack" onSubmit={(event) => { event.preventDefault(); update.mutate(); }}>
    {firstRun && <p className="field-note first-run-note">Optional first-run step. Save a provider or skip to repository connection.</p>}
    <div className="model-grid">
      <label>Provider<select value={provider} onChange={(event) => setProvider(event.target.value as ModelProvider)}><option value="openai">OpenAI compatible</option><option value="anthropic">Anthropic</option></select></label>
      <label>Model<input required value={model} onChange={(event) => setModel(event.target.value)} placeholder={provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-5-mini"} /></label>
      <label>API key <span>{config.data?.config?.hasApiKey ? "(leave blank to preserve)" : ""}</span><input aria-label="API key" required={!config.data?.config?.hasApiKey} type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={config.data?.config?.hasApiKey ? "Stored securely" : "Required to enable"} /></label>
    </div>
    {update.error && <ErrorState message={errorMessage(update.error)} />}
    {update.isSuccess && <p className="success-message">Model settings saved.</p>}
    <div className="inline-actions"><button className="button primary" disabled={update.isPending}>Save model settings</button>{firstRun && <a className="button" href="#repository">Skip for now</a>}</div>
  </form>;
}

export function SettingsPage({ api }: { api: ApiClient }) {
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const repository = useRepository(api);
  const missingRepository = repository.error instanceof ApiError && repository.error.status === 404;
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
    <header className="page-header"><div><p className="eyebrow">Workspace administration</p><h1>Settings</h1><p>Repository, model runtime, and agent access.</p></div></header>
    <div className="settings-stack">
      <section className="settings-section" id="repository"><div className="settings-intro"><Link2 aria-hidden="true" /><div><h2>Repository</h2><p>Source connection details are sanitized after storage.</p></div></div>{repository.isLoading ? <Loading /> : missingRepository ? <ConnectionForm api={api} onConnected={() => void queryClient.invalidateQueries({ queryKey: keys.repository })} /> : repository.error ? <ErrorState message={errorMessage(repository.error)} /> : repository.data && <dl className="detail-list horizontal"><div><dt>Name</dt><dd>{repository.data.repository.name}</dd></div><div><dt>Type</dt><dd>{repository.data.repository.kind}</dd></div><div><dt>Location</dt><dd className="mono break">{repository.data.repository.path ?? repository.data.repository.url}</dd></div>{repository.data.repository.kind === "git" && <div><dt>Credential</dt><dd><ShieldCheck aria-hidden="true" />{repository.data.repository.hasCredential ? "Encrypted and stored" : "Not configured"}</dd></div>}</dl>}{params.get("connect") && !missingRepository && <p className="success-message">Repository is already connected.</p>}</section>
      <section className="settings-section"><div className="settings-intro"><LockKeyhole aria-hidden="true" /><div><h2>Model provider</h2><p>Optional encrypted provider configuration for knowledge enhancement.</p></div></div><ModelForm api={api} firstRun={params.get("connect") === "1" && missingRepository} /></section>
      <section className="settings-section"><div className="settings-intro"><PlugZap aria-hidden="true" /><div><h2>MCP connection</h2><p>Connection metadata for coding agents.</p></div></div>{connection.isLoading ? <Loading /> : connection.error ? <ErrorState message={errorMessage(connection.error)} /> : connection.data && <dl className="detail-list horizontal"><div><dt>Endpoint</dt><dd className="mono">{connection.data.endpoint}</dd></div><div><dt>Transport</dt><dd>{connection.data.transport}</dd></div><div><dt>Authorization</dt><dd>{connection.data.authorization}</dd></div><div><dt>Tools</dt><dd>{connection.data.tools.length} available</dd></div></dl>}</section>
      <section className="settings-section"><div className="settings-intro"><KeyRound aria-hidden="true" /><div><h2>Access tokens</h2><p>Plain token values are disclosed once at creation.</p></div></div><form className="token-form" onSubmit={(event) => { event.preventDefault(); create.mutate(tokenName); }}><label>Token name<input required value={tokenName} onChange={(event) => setTokenName(event.target.value)} placeholder="Local agent" /></label><button className="button primary" disabled={create.isPending}>Create token</button></form>{create.error && <ErrorState message={errorMessage(create.error)} />}{tokens.isLoading ? <Loading /> : tokens.error ? <ErrorState message={errorMessage(tokens.error)} /> : listedTokens.length === 0 ? <Empty>No MCP tokens created.</Empty> : <div><div className="token-list">{listedTokens.map((item) => <div key={item.id}><KeyRound aria-hidden="true" /><span><strong>{item.name}</strong><small className="mono">{item.tokenPrefix}</small></span><Status value={item.revokedAt ? "revoked" : "active"} />{!item.revokedAt && <button className="icon-button danger-text" aria-label={`Revoke ${item.name}`} onClick={() => revoke.mutate(item.id)}><Trash2 aria-hidden="true" /></button>}</div>)}</div>{tokens.hasNextPage && <button className="button continuation" onClick={() => void tokens.fetchNextPage()} disabled={tokens.isFetchingNextPage}>{tokens.isFetchingNextPage ? "Loading tokens..." : "Load more tokens"}</button>}</div>}</section>
    </div>
    {plaintext && <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="token-dialog-title"><div className="modal-icon"><KeyRound aria-hidden="true" /></div><h2 id="token-dialog-title">MCP token created</h2><p>Copy this token now. It will never be displayed again.</p><div className="secret-row"><code>{plaintext}</code><button className="icon-button" aria-label="Copy token" onClick={async () => { await navigator.clipboard?.writeText(plaintext); setCopied(true); }}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button></div><button ref={closeRef} className="button primary full" onClick={() => { setPlaintext(null); setCopied(false); }}>I have copied it</button></div></div>}
  </div>;
}
