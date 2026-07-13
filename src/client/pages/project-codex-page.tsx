import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Modal, Tag } from "antd";
import { Check, Clipboard, Code2, FileText, KeyRound, Link2, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router-dom";

import { errorMessage, LIST_PAGE_SIZE, type ApiClient } from "../api/client";
import type { McpToken } from "../api/types";
import { Empty, ErrorState, Loading } from "../components/ui";

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return <Button icon={copied ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />} onClick={async () => {
    await navigator.clipboard?.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }}>{copied ? "已复制" : label}</Button>;
}

function CodePanel({ title, icon, value }: { title: string; icon: React.ReactNode; value: string }) {
  return <section className="codex-code-panel">
    <header><div>{icon}<h2>{title}</h2></div><CopyButton value={value} label="复制" /></header>
    <pre><code>{value}</code></pre>
  </section>;
}

export function ProjectCodexPage({ api }: { api: ApiClient }) {
  const { projectId = "" } = useParams();
  const queryClient = useQueryClient();
  const connection = useQuery({
    queryKey: ["projects", projectId, "codex-connection"],
    queryFn: () => api.getProjectCodexConnection(projectId),
    enabled: Boolean(projectId),
    retry: false
  });
  const tokens = useInfiniteQuery({
    queryKey: ["projects", projectId, "mcp-tokens"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.listProjectMcpTokens(projectId, { limit: LIST_PAGE_SIZE, offset: pageParam }),
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    enabled: Boolean(projectId)
  });
  const [tokenName, setTokenName] = useState("");
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.createMcpToken(tokenName, projectId),
    onSuccess: async (value) => {
      setPlaintext(value.token);
      setTokenName("");
      await queryClient.invalidateQueries({ queryKey: ["projects", projectId, "mcp-tokens"] });
    }
  });
  const revoke = useMutation({
    mutationFn: api.revokeMcpToken,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projects", projectId, "mcp-tokens"] })
  });
  const listedTokens: McpToken[] = tokens.data?.pages.flatMap((page) => page.tokens) ?? [];

  if (connection.isLoading) return <div className="page"><Loading label="正在生成 Codex 接入配置" /></div>;
  if (connection.error) return <div className="page"><ErrorState message={errorMessage(connection.error)} retry={() => void connection.refetch()} /></div>;
  if (!connection.data) return null;

  return <div className="page project-codex-page">
    <header className="page-header"><div><p className="eyebrow">Agent 连接</p><h1>Codex 接入</h1><p>将 Codex 限定到当前项目的已发布知识。普通闲聊不查询，开发任务开始前优先检索。</p></div><Tag color="green" icon={<ShieldCheck aria-hidden="true" />}>项目隔离已启用</Tag></header>
    <section className="codex-connection-band" aria-label="Codex 连接状态">
      <div><Link2 aria-hidden="true" /><span><small>MCP 端点</small><strong className="mono">{connection.data.endpoint}</strong></span></div>
      <div><KeyRound aria-hidden="true" /><span><small>环境变量</small><strong className="mono">{connection.data.environmentVariable}</strong></span></div>
      <CopyButton value={connection.data.checkCommand} label="复制检查命令" />
    </section>
    <div className="codex-config-grid">
      <CodePanel title=".codex/config.toml" icon={<Code2 aria-hidden="true" />} value={connection.data.configToml} />
      <CodePanel title="AGENTS.md" icon={<FileText aria-hidden="true" />} value={connection.data.agentsMarkdown} />
    </div>
    <section className="codex-tokens" aria-labelledby="project-token-title">
      <div className="section-heading"><div><p className="eyebrow">访问控制</p><h2 id="project-token-title">项目 Token</h2><p>每个 Token 只能查询当前项目，明文仅在创建时展示一次。</p></div></div>
      <form className="codex-token-form" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
        <Input aria-label="Token 名称" required value={tokenName} onChange={(event) => setTokenName(event.target.value)} placeholder="例如：我的 Codex" prefix={<KeyRound aria-hidden="true" />} />
        <Button type="primary" htmlType="submit" loading={create.isPending}>创建 Token</Button>
      </form>
      {create.error && <ErrorState message={errorMessage(create.error)} />}
      {tokens.isLoading ? <Loading label="正在加载项目 Token" /> : tokens.error ? <ErrorState message={errorMessage(tokens.error)} retry={() => void tokens.refetch()} /> : listedTokens.length === 0 ? <Empty>当前项目尚未创建 Token。</Empty> : <div className="codex-token-list">{listedTokens.map((item) => <div key={item.id}><KeyRound aria-hidden="true" /><span><strong>{item.name}</strong><small className="mono">{item.tokenPrefix}</small></span><Tag color={item.revokedAt ? "default" : "green"}>{item.revokedAt ? "已撤销" : "可用"}</Tag>{!item.revokedAt && <Button danger type="text" aria-label={`撤销 ${item.name}`} icon={<Trash2 aria-hidden="true" />} onClick={() => revoke.mutate(item.id)} />}</div>)}</div>}
      {tokens.hasNextPage && <Button onClick={() => void tokens.fetchNextPage()} loading={tokens.isFetchingNextPage}>加载更多 Token</Button>}
    </section>
    {plaintext && <Modal title="已创建项目 Token" open destroyOnHidden onCancel={() => setPlaintext(null)} footer={<Button type="primary" onClick={() => setPlaintext(null)}>我已保存</Button>}>
      <p>请立即保存此 Token。关闭窗口后不会再次显示。</p>
      <div className="secret-row"><code>{plaintext}</code><CopyButton value={plaintext} label="复制 Token" /></div>
    </Modal>}
  </div>;
}
