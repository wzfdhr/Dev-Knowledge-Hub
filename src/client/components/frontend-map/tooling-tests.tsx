import { EntityCollection, type FrontendMapPanelProps } from "./frontend-map-shared";

export function ToolingTests({ preview, onOpenSource }: FrontendMapPanelProps) {
  const entities = preview.graph.nodes.filter((entity) => ["tooling_config", "test_case", "test_fixture", "workspace_package", "application_entry"].includes(entity.kind));
  return <EntityCollection title="构建与测试" description="工程配置、应用入口、测试用例与测试夹具。" entities={entities} preview={preview} onOpenSource={onOpenSource} />;
}
