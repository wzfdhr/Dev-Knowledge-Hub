import { EntityCollection, type FrontendMapPanelProps } from "./frontend-map-shared";

export function DataFlow({ preview, onOpenSource }: FrontendMapPanelProps) {
  const entities = preview.graph.nodes.filter((entity) => ["state_store", "state_field", "api_operation", "data_schema", "hook_or_composable"].includes(entity.kind));
  return <EntityCollection title="状态与数据" description="Context、store、Hook、API 操作和数据结构。" entities={entities} preview={preview} onOpenSource={onOpenSource} />;
}
