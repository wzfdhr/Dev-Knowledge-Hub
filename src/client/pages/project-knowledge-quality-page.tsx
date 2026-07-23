import { useQuery } from "@tanstack/react-query";
import { Braces, Clipboard, GitCompare, Network } from "lucide-react";
import { useParams, useSearchParams } from "react-router-dom";

import { activeProjectId, errorMessage, type ApiClient } from "../api/client";
import { QualityGovernancePanel } from "../components/quality-governance-panel";
import { Empty, ErrorState, Loading } from "../components/ui";

const diagnosticLabels = {
  SOURCE_MISSING: "尚未接入资料来源",
  SNAPSHOT_MISSING: "资料已接入，等待首次同步",
  BUILD_FAILED: "最近一次构建失败",
  RELEASE_MISSING: "尚未发布知识版本",
  REBUILD_RECOMMENDED: "资料已变更，建议重新构建",
  PUBLISHED: "当前知识版本已发布"
} as const;

export function ProjectKnowledgeQualityPage({
  api,
  projectId: explicitProjectId
}: {
  api: ApiClient;
  projectId?: string;
}) {
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = explicitProjectId ?? params.projectId ?? activeProjectId();
  const quality = useQuery({
    queryKey: ["project-knowledge-quality", projectId],
    queryFn: () => api.getProjectKnowledgeQuality(projectId!),
    enabled: Boolean(projectId),
    retry: false
  });
  const releases = useQuery({
    queryKey: ["project-releases", "quality", projectId],
    queryFn: () => api.listProjectReleases(projectId!, { limit: 100, offset: 0 }),
    enabled: Boolean(projectId),
    retry: false
  });
  const requestedReleaseId = searchParams.get("releaseId");
  const release = requestedReleaseId
    ? releases.data?.releases.find((item) => item.id === requestedReleaseId)
    : releases.data?.releases[0];
  const metadata = useQuery({
    queryKey: ["knowledge-metadata", release?.id],
    queryFn: () => api.getKnowledgeMetadata(release!.id),
    enabled: Boolean(release),
    retry: false
  });

  if (!projectId) return <div className="page"><Empty>请先进入一个项目。</Empty></div>;

  return <div className="page project-knowledge-quality-page">
    <header className="page-header">
      <div>
        <p className="eyebrow">知识资料 · 治理</p>
        <h1>知识质量</h1>
        <p>集中处理质量、修复建议和代码元数据，不打断正文阅读。</p>
      </div>
      {release && <label className="quality-release-select">版本
        <select
          aria-label="质量分析版本"
          value={release.id}
          onChange={(event) => setSearchParams({ releaseId: event.target.value })}
        >
          {releases.data?.releases.map((item) =>
            <option key={item.id} value={item.id}>{item.version}{item.publishedAt ? "" : "（草稿）"}</option>
          )}
        </select>
      </label>}
    </header>
    {quality.isLoading
      ? <Loading label="正在加载知识质量" />
      : quality.error
        ? <ErrorState message={errorMessage(quality.error)} retry={() => void quality.refetch()} />
        : quality.data && <>
          <section className="quality-summary-grid" aria-label="知识质量摘要">
            <article><GitCompare aria-hidden="true" /><span><small>资料变化</small><strong>
              {(quality.data.change?.added.length ?? 0)
                + (quality.data.change?.modified.length ?? 0)
                + (quality.data.change?.deleted.length ?? 0)}
            </strong><em>{quality.data.change?.requiresBuild ? "需要人工构建" : "无需重新构建"}</em></span></article>
            <article><Network aria-hidden="true" /><span><small>页面 / 引用</small><strong>
              {quality.data.knowledge.pageCount} / {quality.data.knowledge.citationCount}
            </strong><em>{quality.data.indexedTextBytes.toLocaleString()} 字节已索引</em></span></article>
            <article><Braces aria-hidden="true" /><span><small>治理状态</small><strong>
              {quality.data.remediation.open + quality.data.remediation.accepted + quality.data.remediation.rebuilding}
            </strong><em>{quality.data.diagnostics.map((item) => diagnosticLabels[item.code]).join("；")}</em></span></article>
          </section>
          <QualityGovernancePanel api={api} projectId={projectId} assessment={quality.data.assessment} />
        </>}
    <section className="quality-metadata-panel" aria-labelledby="code-metadata-title">
      <div className="section-heading"><div><p className="eyebrow">可追溯代码信息</p><h2 id="code-metadata-title">代码元数据</h2></div></div>
      {releases.isLoading || metadata.isLoading
        ? <Loading label="正在加载代码元数据" />
        : releases.error
          ? <ErrorState message={errorMessage(releases.error)} retry={() => void releases.refetch()} />
          : !release
            ? <Empty>创建知识草稿后会显示符号和依赖关系。</Empty>
            : metadata.error
              ? <ErrorState message={errorMessage(metadata.error)} retry={() => void metadata.refetch()} />
              : <div className="quality-metadata-grid">
                <div>
                  <h3>符号 <span>{metadata.data?.symbols.length ?? 0}</span></h3>
                  {metadata.data?.symbols.slice(0, 20).map((symbol) =>
                    <div className="metadata-row" key={`${symbol.path}-${symbol.startLine}-${symbol.endLine}-${symbol.name}`}>
                      <span><strong>{symbol.name}</strong><small>{symbol.kind}</small></span>
                      <div className="truncated-path">
                        <code title={`${symbol.path}:${symbol.startLine}-${symbol.endLine}`}>
                          {symbol.path}:{symbol.startLine}-{symbol.endLine}
                        </code>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`复制 ${symbol.name} 路径`}
                          onClick={() => void navigator.clipboard?.writeText(`${symbol.path}:${symbol.startLine}-${symbol.endLine}`)}
                        ><Clipboard aria-hidden="true" /></button>
                      </div>
                    </div>
                  )}
                </div>
                <div>
                  <h3>依赖关系 <span>{metadata.data?.dependencies.length ?? 0}</span></h3>
                  {metadata.data?.dependencies.slice(0, 20).map((dependency) =>
                    <div className="metadata-row" key={`${dependency.kind}-${dependency.path}-${dependency.startLine}-${dependency.endLine}-${dependency.source}-${dependency.target}`}>
                      <span><strong>{dependency.source} → {dependency.target}</strong><small>{dependency.kind}</small></span>
                      <div className="truncated-path">
                        <code title={`${dependency.path}:${dependency.startLine}`}>{dependency.path}:{dependency.startLine}</code>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`复制 ${dependency.source} 依赖路径`}
                          onClick={() => void navigator.clipboard?.writeText(`${dependency.path}:${dependency.startLine}`)}
                        ><Clipboard aria-hidden="true" /></button>
                      </div>
                    </div>
                  )}
                </div>
              </div>}
    </section>
  </div>;
}
