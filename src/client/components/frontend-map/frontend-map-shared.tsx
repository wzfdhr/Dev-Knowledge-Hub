import { FileCode2 } from "lucide-react";

import type { FrontendCandidatePreview, FrontendPreviewEntity, GraphSourceRef } from "../../api/types";
import { Empty } from "../ui";

export interface FrontendMapPanelProps {
  preview: FrontendCandidatePreview;
  onOpenSource: (source: GraphSourceRef) => void;
}

export function relatedNames(preview: FrontendCandidatePreview, entityId: string): string[] {
  const names = new Map(preview.graph.nodes.map((entity) => [entity.id, entity.name]));
  return preview.graph.edges.filter((edge) => edge.fromEntityId === entityId || edge.toEntityId === entityId)
    .map((edge) => `${edge.kind}${edge.evidenceClass === "candidate" ? "（候选）" : ""} · ${names.get(edge.fromEntityId === entityId ? edge.toEntityId : edge.fromEntityId) ?? "未知实体"}`);
}

export function EntityCollection({ title, description, entities, preview, onOpenSource }: {
  title: string;
  description: string;
  entities: FrontendPreviewEntity[];
  preview: FrontendCandidatePreview;
  onOpenSource: (source: GraphSourceRef) => void;
}) {
  return <section className="frontend-map-section"><header><div><h2>{title}</h2><p>{description}</p></div><span>{entities.length}</span></header>
    {entities.length ? <div className="frontend-entity-list">{entities.map((entity) => {
      const relations = relatedNames(preview, entity.id);
      return <article className="frontend-entity-row" key={entity.id}>
        <div className="frontend-entity-main"><span className="frontend-kind">{entity.kind}</span><strong>{entity.name}</strong><code>{entity.canonicalPath}</code></div>
        <div className="frontend-relation-list">{relations.length ? relations.slice(0, 4).map((relation) => <span key={relation}>{relation}</span>) : <span>暂无已验证关系</span>}</div>
        <div className="frontend-source-actions">{entity.sourceRefs.slice(0, 2).map((source) => <button key={`${source.path}:${source.startLine}:${source.endLine}`} onClick={() => onOpenSource(source)} aria-label={`${source.path} 第 ${source.startLine} 至 ${source.endLine} 行`}><FileCode2 aria-hidden="true" />{source.path}<small>:{source.startLine}-{source.endLine}</small></button>)}</div>
      </article>;
    })}</div> : <Empty>当前候选构建没有识别到{title}。</Empty>}
  </section>;
}
