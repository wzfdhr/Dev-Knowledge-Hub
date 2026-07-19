import type { SourceRef } from "../../../shared/api-contracts.js";
import type { FrontendEdge, FrontendEntity } from "../../../shared/frontend-ir.js";
import type { FrontendKnowledgePage } from "./knowledge-generator.js";

export interface FrontendSearchDocument {
  documentKey: string;
  kind: string;
  title: string;
  content: string;
  citations: SourceRef[];
  metadata: Record<string, string | number | boolean>;
}

export interface FrontendSearchAccess {
  canReadProject: boolean;
  visibility: "published" | "shadow";
  viewerRole: "admin" | "member" | "reader";
  buildId: string;
  currentReleaseBuildId: string | null;
}

export interface FrontendSearchResult {
  entityId: string;
  entityKey: string;
  kind: FrontendEntity["kind"];
  title: string;
  path: string;
  score: number;
  matchReason: string;
  citations: SourceRef[];
  factKeys: string[];
}

const kindTerms: Record<FrontendEntity["kind"], readonly string[]> = {
  workspace_package: ["workspace", "package", "工作区", "包"],
  application_entry: ["typescript module", "javascript module", "module", "typescript 模块", "模块"],
  symbol: ["symbol", "function", "interface", "variable", "符号", "函数", "接口"],
  route: ["route", "router", "loader", "lazy", "路由", "动态路由", "根路由"],
  layout: ["layout", "布局"], page: ["page", "页面"],
  component: ["react", "component", "jsx", "render tree", "组件", "渲染树"],
  dom_landmark: ["html", "mount point", "landmark", "挂载点"], form: ["form", "表单"],
  hook_or_composable: ["hook", "effect", "composable", "钩子", "副作用"],
  state_store: ["zustand", "context", "state store", "状态仓库", "状态"],
  state_field: ["state field", "状态字段"],
  api_operation: ["axios", "fetch", "request", "api", "接口操作", "接口", "请求"],
  data_schema: ["schema", "数据结构"],
  style_token: ["sass", "scss", "less", "token", "design token", "设计令牌"],
  style_scope: ["css module", "css modules", "style scope", "css 模块", "样式作用域"],
  visualization: ["echarts", "chart", "dataset", "series", "dispose", "visualization", "图表", "可视化"],
  test_case: ["test", "unit test", "component test", "playwright", "e2e", "测试", "组件测试", "端到端"],
  test_fixture: ["fixture", "测试夹具"],
  tooling_config: ["vite", "tsconfig", "tooling", "config", "配置", "插件", "alias", "sourcemap"]
};

const relationPriority: Partial<Record<FrontendEntity["kind"], readonly string[]>> = {
  workspace_package: ["contains", "configures"], application_entry: ["exports", "imports"],
  component: ["renders", "reads_state", "requests", "injects", "styles"],
  dom_landmark: ["contains"], route: ["routes_to", "lazy_loads"],
  state_store: ["reads_state", "contains"], api_operation: ["requests"],
  style_scope: ["styles", "contains"], style_token: ["configures", "contains"],
  visualization: ["visualizes"], test_case: ["tests"], tooling_config: ["configures"]
};

function normalized(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}_:/.@-]+/gu, " ").trim();
}

function sourceRefKey(reference: SourceRef): string {
  return `${reference.snapshotId}\0${reference.path}\0${reference.startLine}\0${reference.endLine}\0${reference.blobHash}`;
}

function uniqueRefs(references: readonly SourceRef[]): SourceRef[] {
  return [...new Map(references.map((reference) => [sourceRefKey(reference), reference])).values()];
}

export function buildFrontendSearchDocuments(pages: readonly FrontendKnowledgePage[]): FrontendSearchDocument[] {
  return pages.flatMap((page) => page.chunks.map((chunk, position) => ({
    documentKey: `${page.slug}:${position}`,
    kind: "page" as const,
    title: page.title,
    content: chunk.content,
    citations: chunk.citations,
    metadata: { pageId: page.id, pageSlug: page.slug, heading: chunk.heading, position }
  })));
}

function searchAllowed(access: FrontendSearchAccess): boolean {
  if (!access.canReadProject) return false;
  if (access.visibility === "shadow") return access.viewerRole === "admin";
  return access.currentReleaseBuildId === access.buildId;
}

function entityScore(query: string, entity: FrontendEntity): { score: number; reason: string } {
  const name = normalized(entity.name);
  const path = normalized(entity.canonicalPath);
  const semanticKey = entity.identity.type === "named" ? entity.identity.semanticKey : entity.identity.enclosingSemanticKey;
  const haystack = normalized(`${entity.qualifiedName} ${entity.canonicalPath} ${semanticKey} ${JSON.stringify(entity.facets)} ${JSON.stringify(entity.attributes)}`);
  let score = 0;
  const reasons: string[] = [];
  if (name.length >= 3 && query.includes(name)) { score += 20; reasons.push("exact-name"); }
  if (path.length >= 3 && query.includes(path)) { score += 16; reasons.push("exact-path"); }
  for (const term of kindTerms[entity.kind]) {
    if (query.includes(normalized(term))) { score += term.length > 5 ? 10 : 6; reasons.push(`kind:${term}`); }
  }
  const tokens = query.split(" ").filter((token) => token.length >= 3 && !/^\d+$/u.test(token));
  const matchedTokens = tokens.filter((token) => haystack.includes(token));
  score += Math.min(12, matchedTokens.length * 3);
  if (matchedTokens.length) reasons.push("field-match");
  return { score, reason: reasons.join(",") || "none" };
}

function structuralScore(
  query: string,
  entity: FrontendEntity,
  edges: readonly FrontendEdge[],
  entities: ReadonlyMap<string, FrontendEntity>
): { score: number; reason: string | null } {
  const connectedNameMatch = (kinds: readonly FrontendEdge["kind"][]) => edges.some((edge) =>
    edge.evidenceClass === "fact" && kinds.includes(edge.kind)
    && (edge.fromEntityId === entity.id || edge.toEntityId === entity.id)
    && (() => {
      const other = entities.get(edge.fromEntityId === entity.id ? edge.toEntityId : edge.fromEntityId);
      return Boolean(other && normalized(other.name).length >= 3 && query.includes(normalized(other.name)));
    })());
  if (entity.kind === "application_entry" && connectedNameMatch(["exports"])
    && !query.includes("css")
    && (query.includes("module") || query.includes("模块") || query.includes("typescript") || query.includes("type script"))) {
    return { score: 40, reason: "exports-query-target" };
  }
  if (entity.kind === "route" && connectedNameMatch(["routes_to"])) return { score: 26, reason: "routes-to-query-target" };
  if (entity.kind === "test_case" && connectedNameMatch(["tests"])) return { score: 28, reason: "tests-query-target" };
  if (entity.kind === "visualization" && connectedNameMatch(["visualizes"])
    && (query.includes("echarts") || query.includes("dataset") || query.includes("dispose")
      || query.includes("visualization") || query.includes("图表") || query.includes("可视化"))) {
    return { score: 22, reason: "visualization-owner" };
  }
  if (entity.kind === "dom_landmark" && (query.includes("html") || query.includes("mount point") || query.includes("挂载点"))) {
    return { score: 20, reason: "html-landmark" };
  }
  if (entity.kind === "component" && /Page$/u.test(entity.name)
    && (query.includes(normalized(entity.name)) || query.includes("jsx") || query.includes("react") || query.includes("渲染"))) {
    return { score: 8, reason: "page-component" };
  }
  if (entity.kind === "style_scope" && entity.canonicalPath.endsWith(".module.css")
    && !entity.name.startsWith(":global") && !entity.name.startsWith("@")) {
    return { score: 20, reason: "css-module-selector" };
  }
  if (entity.kind === "style_token" && entity.name.startsWith("$")
    && (query.includes("sass") || query.includes("scss") || query.includes("设计令牌"))) {
    return { score: 8, reason: "sass-token" };
  }
  const testKind = entity.kind === "test_case" && entity.attributes.testKind.state === "known"
    ? entity.attributes.testKind.value : null;
  if (testKind === "e2e" && (query.includes("playwright") || query.includes("e2e") || query.includes("端到端"))) {
    return { score: 16, reason: "e2e-test" };
  }
  if (testKind === "component" && (query.includes("component test") || query.includes("组件测试") || query.includes("测试渲染"))) {
    return { score: 16, reason: "component-test" };
  }
  return { score: 0, reason: null };
}

function factKey(edge: FrontendEdge, entities: ReadonlyMap<string, FrontendEntity>): string {
  const key = (id: string) => {
    const entity = entities.get(id);
    if (!entity) return id;
    return entity.identity.type === "named" ? entity.identity.semanticKey : `${entity.identity.enclosingSemanticKey}#${entity.identity.astOrdinal}`;
  };
  return `${edge.kind}:${key(edge.fromEntityId)}->${key(edge.toEntityId)}`;
}

function bestFact(entity: FrontendEntity, edges: readonly FrontendEdge[], entities: ReadonlyMap<string, FrontendEntity>): string[] {
  const priorities = relationPriority[entity.kind] ?? [];
  const candidates = edges.filter((edge) => edge.evidenceClass === "fact"
    && (edge.fromEntityId === entity.id || edge.toEntityId === entity.id));
  candidates.sort((left, right) => {
    const leftRank = priorities.indexOf(left.kind);
    const rightRank = priorities.indexOf(right.kind);
    return (leftRank < 0 ? 100 : leftRank) - (rightRank < 0 ? 100 : rightRank)
      || Number(left.fromEntityId !== entity.id) - Number(right.fromEntityId !== entity.id)
      || (() => {
        const endpointRank = (edge: FrontendEdge) => {
          const other = entities.get(edge.fromEntityId === entity.id ? edge.toEntityId : edge.fromEntityId);
          if (entity.kind === "application_entry") {
            if (other?.kind === "component" && /Page$/u.test(other.name)) return 0;
            if (other?.kind === "component") return 1;
            return 2;
          }
          if (entity.kind === "component" && edge.kind === "renders") {
            return other?.kind === "component" && /Chart$/u.test(other.name) ? 0 : 1;
          }
          return 0;
        };
        return endpointRank(left) - endpointRank(right);
      })()
      || left.canonicalEvidenceKey.localeCompare(right.canonicalEvidenceKey);
  });
  return candidates[0] ? [factKey(candidates[0], entities)] : [];
}

export function searchFrontendKnowledge(input: {
  query: string;
  documents: readonly FrontendSearchDocument[];
  graph: { nodes: readonly FrontendEntity[]; edges: readonly FrontendEdge[] };
  access: FrontendSearchAccess;
  limit?: number;
}): FrontendSearchResult[] {
  const query = normalized(input.query);
  if (!query || !searchAllowed(input.access)) return [];
  const entities = new Map(input.graph.nodes.map((entity) => [entity.id, entity]));
  const documentPaths = new Set(input.documents.flatMap((document) => document.citations.map((citation) => citation.path)));
  return input.graph.nodes.flatMap((entity) => {
    const cited = entity.sourceRefs.filter((reference) => documentPaths.has(reference.path));
    if (!cited.length) return [];
    const lexical = entityScore(query, entity);
    const structural = structuralScore(query, entity, input.graph.edges, entities);
    const match = {
      score: lexical.score + structural.score,
      reason: [lexical.reason, structural.reason].filter(Boolean).join(",")
    };
    if (match.score < 5) return [];
    const entityKey = entity.identity.type === "named"
      ? entity.identity.semanticKey
      : `${entity.identity.enclosingSemanticKey}#${entity.identity.astOrdinal}`;
    return [{
      entityId: entity.id,
      entityKey,
      kind: entity.kind,
      title: entity.qualifiedName,
      path: entity.canonicalPath,
      score: match.score,
      matchReason: match.reason,
      citations: (() => {
        const primary = cited.filter((reference) => reference.path === entity.canonicalPath);
        return uniqueRefs(primary.length ? primary : cited)
        .sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine)
          || left.path.localeCompare(right.path) || left.startLine - right.startLine)
          .slice(0, 1);
      })(),
      factKeys: bestFact(entity, input.graph.edges, entities)
    }];
  }).sort((left, right) => right.score - left.score || left.entityKey.localeCompare(right.entityKey))
    .slice(0, input.limit ?? 5);
}
