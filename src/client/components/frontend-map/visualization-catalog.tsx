import { EntityCollection, type FrontendMapPanelProps } from "./frontend-map-shared";

export function VisualizationCatalog({ preview, onOpenSource }: FrontendMapPanelProps) {
  const entities = preview.graph.nodes.filter((entity) => entity.kind === "visualization");
  return <EntityCollection title="可视化" description="图表实例、数据来源、事件和组件封装关系。" entities={entities} preview={preview} onOpenSource={onOpenSource} />;
}
