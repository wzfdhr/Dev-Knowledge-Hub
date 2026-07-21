import { EntityCollection, type FrontendMapPanelProps } from "./frontend-map-shared";

export function ComponentCatalog({ preview, onOpenSource }: FrontendMapPanelProps) {
  const entities = preview.graph.nodes.filter((entity) => ["component", "form", "style_scope", "style_token", "dom_landmark"].includes(entity.kind));
  return <EntityCollection title="组件与设计系统" description="组件、表单、样式作用域与设计令牌。" entities={entities} preview={preview} onOpenSource={onOpenSource} />;
}
