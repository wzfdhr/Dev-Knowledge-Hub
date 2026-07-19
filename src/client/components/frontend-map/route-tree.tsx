import { EntityCollection, type FrontendMapPanelProps } from "./frontend-map-shared";

export function RouteTree({ preview, onOpenSource }: FrontendMapPanelProps) {
  const routes = preview.graph.nodes.filter((entity) => ["route", "layout", "page"].includes(entity.kind));
  return <EntityCollection title="路由与页面" description="路由、布局与页面组件的确定性连接。" entities={routes} preview={preview} onOpenSource={onOpenSource} />;
}
