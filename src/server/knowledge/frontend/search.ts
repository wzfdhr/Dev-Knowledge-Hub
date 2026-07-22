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
  tooling_config: ["vite", "tsconfig", "tooling", "config", "plugin", "配置", "插件", "alias", "sourcemap"]
};

const relationPriority: Partial<Record<FrontendEntity["kind"], readonly string[]>> = {
  workspace_package: ["contains", "configures"], application_entry: ["exports", "imports"],
  component: ["renders", "reads_state", "requests", "injects", "styles"],
  dom_landmark: ["contains"], route: ["routes_to", "lazy_loads"],
  state_store: ["reads_state", "contains"], api_operation: ["requests"],
  style_scope: ["styles", "contains"], style_token: ["configures", "contains"],
  visualization: ["visualizes"], test_case: ["tests"], tooling_config: ["configures"]
};

const queryStopWords = new Set([
  "and", "application", "cite", "codebase", "configured", "definition", "does", "entity", "explain",
  "find", "for", "from", "how", "implemented", "implementation", "in", "its", "knowledge", "locate",
  "of", "opens", "project", "represents", "source", "that", "the", "this", "through", "trace", "where",
  "which", "with", "type", "script", "owns", "configuration", "path", "reads", "renders", "dynamic",
  "loads", "alias"
]);

const chineseQueryStopPhrases = [
  "并给出源码位置", "在这个项目里如何实现", "对应的知识实体", "哪个文件负责", "查找与", "请定位",
  "在哪里", "如何实现", "哪个", "项目", "源码", "位置", "知识", "实体", "对应", "负责", "通过",
  "进入", "消费", "状态", "渲染", "加载", "打开", "标题", "前端", "应用", "路径", "别名", "配置",
  "动态", "页面", "组件", "模块", "测试", "路由", "请求", "接口", "图表", "可视化", "状态仓库",
  "挂载点", "设计令牌", "作用域", "的", "并", "和"
].sort((left, right) => right.length - left.length);

const termPatterns = new Map<string, RegExp>();

function normalized(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([\p{Script=Han}])([A-Za-z0-9_$@])/gu, "$1 $2")
    .replace(/([A-Za-z0-9_$@])([\p{Script=Han}])/gu, "$1 $2")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}_:/.@-]+/gu, " ")
    .trim();
}

function normalizedPathSubject(value: string): string {
  return normalized(value
    .replace(/\$\{[A-Za-z_$][\w$]*\}/gu, ":param")
    .replace(/(?<=\/):[A-Za-z_$][\w$]*(?=\/|\s|$)/gu, ":param"));
}

function searchableTerm(term: string): boolean {
  return term.length >= 3 || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2}/u.test(term);
}

function containsTerm(text: string, term: string): boolean {
  if (/[^\p{ASCII}]/u.test(term)) return text.includes(term);
  if (!text.includes(term)) return false;
  let pattern = termPatterns.get(term);
  if (!pattern) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u");
    termPatterns.set(term, pattern);
  }
  return pattern.test(text);
}

export function frontendUnknownQuerySubjects(rawQuery: string, documents: readonly FrontendSearchDocument[]): string[] {
  const corpus = normalized(documents.map((document) => `${document.title} ${document.content}`).join(" "));
  const aliases = new Set(Object.values(kindTerms).flatMap((terms) => terms.map(normalized))
    .flatMap((term) => term.split(" ")));
  const latinTokens = normalized(rawQuery).split(" ")
    .filter((token) => /^[a-z][a-z0-9_$@./:-]*$/u.test(token) && token.length >= 4)
    .filter((token) => !token.includes("/"))
    .filter((token) => !queryStopWords.has(token) && !aliases.has(token));
  const unknown = latinTokens.filter((token) => !containsTerm(corpus, token));
  const pathSubjects = rawQuery.match(/\/[A-Za-z0-9_:@.-]+(?:\/[A-Za-z0-9_:@.-]+)+/gu) ?? [];
  const canonicalPathCorpus = normalizedPathSubject(documents.map((document) => `${document.title} ${document.content}`).join(" "));
  const unknownPaths: string[] = [];
  for (const subject of pathSubjects) {
    const normalizedSubject = normalizedPathSubject(subject);
    if (!containsTerm(canonicalPathCorpus, normalizedSubject)) unknownPaths.push(normalizedSubject);
  }
  if (pathSubjects.length) return [...new Set(unknownPaths)];

  const chineseSegments = rawQuery.match(/[\p{Script=Han}]+/gu) ?? [];
  for (const segment of chineseSegments) {
    let subject = segment;
    for (const phrase of chineseQueryStopPhrases) subject = subject.replaceAll(phrase, "");
    if (subject.length >= 2 && !corpus.includes(subject)) unknown.push(subject);
  }
  return [...new Set(unknown)];
}

export function frontendQuerySubjectsAreKnown(rawQuery: string, documents: readonly FrontendSearchDocument[]): boolean {
  return frontendUnknownQuerySubjects(rawQuery, documents).length === 0;
}

function sourceRefKey(reference: SourceRef): string {
  return `${reference.snapshotId}\0${reference.path}\0${reference.startLine}\0${reference.endLine}\0${reference.blobHash}`;
}

function uniqueRefs(references: readonly SourceRef[]): SourceRef[] {
  return [...new Map(references.map((reference) => [sourceRefKey(reference), reference])).values()];
}

export function buildFrontendSearchDocuments(pages: readonly FrontendKnowledgePage[]): FrontendSearchDocument[] {
  return pages.flatMap((page) => page.items.map((item, position) => ({
    documentKey: `${page.slug}:${item.entityId}`,
    kind: "page" as const,
    title: `${page.title}: ${item.qualifiedName}`,
    content: `${item.kind}: ${item.qualifiedName}\n${kindTerms[item.kind].join(" ")}`,
    citations: item.sourceRefs,
    metadata: { pageId: page.id, pageSlug: page.slug, entityId: item.entityId, position }
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
  if (name.length >= 3 && containsTerm(query, name)) {
    score += 20 + name.split(" ").length;
    reasons.push("exact-name");
  }
  if (path.length >= 3 && containsTerm(query, path)) { score += 16; reasons.push("exact-path"); }
  for (const term of kindTerms[entity.kind]) {
    if (containsTerm(query, normalized(term))) { score += term.length > 5 ? 10 : 6; reasons.push(`kind:${term}`); }
  }
  const tokens = query.split(" ").filter((token) => token.length >= 3 && !/^\d+$/u.test(token));
  const matchedTokens = tokens.filter((token) => haystack.includes(token));
  score += Math.min(12, matchedTokens.length * 3);
  if (matchedTokens.length) reasons.push("field-match");
  return { score, reason: reasons.join(",") || "none" };
}

function documentScore(query: string, entity: FrontendEntity, entityDocuments: readonly FrontendSearchDocument[]): number {
  let best = 0;
  for (const document of entityDocuments) {
    const haystack = normalized(`${document.title} ${document.content}`);
    if (!haystack) continue;
    const identityTerms = [entity.name, entity.qualifiedName, entity.canonicalPath,
      entity.identity.type === "named" ? entity.identity.semanticKey : entity.identity.enclosingSemanticKey]
      .map(normalized).filter(searchableTerm);
    const exactIdentity = identityTerms.some((term) => containsTerm(query, term) && containsTerm(haystack, term));
    const aliases = kindTerms[entity.kind].map(normalized)
      .filter((term) => searchableTerm(term) && containsTerm(query, term) && containsTerm(haystack, term));
    const queryTokens = query.split(" ").filter((token) => token.length >= 3 && !/^\d+$/u.test(token));
    const lexicalMatches = queryTokens.filter((token) => haystack.includes(token));
    if (!exactIdentity && !aliases.length) continue;
    const score = (exactIdentity ? 24 : 0) + Math.min(12, aliases.length * 6)
      + Math.min(8, lexicalMatches.length * 2);
    best = Math.max(best, score);
  }
  return best;
}

function structuralScore(
  query: string,
  entity: FrontendEntity,
  connectedEdges: readonly FrontendEdge[],
  entities: ReadonlyMap<string, FrontendEntity>
): { score: number; reason: string | null } {
  const connectedNameMatch = (kinds: readonly FrontendEdge["kind"][]) => connectedEdges.some((edge) =>
    edge.evidenceClass === "fact" && kinds.includes(edge.kind)
    && (edge.fromEntityId === entity.id || edge.toEntityId === entity.id)
    && (() => {
      const other = entities.get(edge.fromEntityId === entity.id ? edge.toEntityId : edge.fromEntityId);
      return Boolean(other && normalized(other.name).length >= 3 && query.includes(normalized(other.name)));
    })());
  if (entity.kind === "application_entry" && connectedNameMatch(["exports"])
    && !query.includes("css")
    && (query.includes("module") || query.includes("模块") || query.includes("typescript") || query.includes("type script"))) {
    return { score: 80, reason: "exports-query-target" };
  }
  if (entity.kind === "route" && connectedNameMatch(["routes_to"])) return { score: 60, reason: "routes-to-query-target" };
  if (entity.kind === "test_case" && connectedNameMatch(["tests"])) return { score: 56, reason: "tests-query-target" };
  if (entity.kind === "visualization" && connectedNameMatch(["visualizes"])
    && (query.includes("echarts") || query.includes("dataset") || query.includes("dispose")
      || query.includes("visualization") || query.includes("图表") || query.includes("可视化"))) {
    return { score: 22, reason: "visualization-owner" };
  }
  if (entity.kind === "api_operation"
    && (query.includes("api") || query.includes("request") || query.includes("接口") || query.includes("请求"))) {
    return { score: 32, reason: "api-operation-intent" };
  }
  if (entity.kind === "dom_landmark" && (query.includes("html") || query.includes("mount point") || query.includes("挂载点"))) {
    return { score: 20, reason: "html-landmark" };
  }
  if (entity.kind === "component" && /Page$/u.test(entity.name)
    && (query.includes(normalized(entity.name)) || query.includes("jsx") || query.includes("react") || query.includes("渲染"))) {
    return { score: 16, reason: "page-component" };
  }
  if (entity.kind === "style_scope" && entity.canonicalPath.endsWith(".module.css")
    && !entity.name.startsWith(":global") && !entity.name.startsWith("@")) {
    return { score: 52, reason: "css-module-selector" };
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

function bestFact(entity: FrontendEntity, connectedEdges: readonly FrontendEdge[], entities: ReadonlyMap<string, FrontendEntity>): string[] {
  const ecosystemFacet = entity.facets["react-ecosystem-core"];
  const stateDataFacet = entity.facets["state-data-core"];
  const priorities = ecosystemFacet?.role === "permission-guard"
    ? ["guards", ...(relationPriority[entity.kind] ?? [])]
    : ecosystemFacet?.encapsulation === "component-library-wrapper"
      ? ["wraps", ...(relationPriority[entity.kind] ?? [])]
      : stateDataFacet?.queryKind === "mutation"
        ? ["invalidates", ...(relationPriority[entity.kind] ?? [])]
        : relationPriority[entity.kind] ?? [];
  const facts = connectedEdges.filter((edge) => edge.evidenceClass === "fact");
  const candidates = priorities.length ? facts.filter((edge) => priorities.includes(edge.kind)) : facts;
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
          if (entity.kind === "workspace_package" && other?.kind === "tooling_config") {
            return other.name === "storybook" ? 1 : 0;
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
  if (!frontendQuerySubjectsAreKnown(input.query, input.documents)) return [];
  const entities = new Map(input.graph.nodes.map((entity) => [entity.id, entity]));
  const edgesByEntity = new Map<string, FrontendEdge[]>();
  for (const edge of input.graph.edges) {
    for (const entityId of new Set([edge.fromEntityId, edge.toEntityId])) {
      const edges = edgesByEntity.get(entityId) ?? [];
      edges.push(edge);
      edgesByEntity.set(entityId, edges);
    }
  }
  const documentsByEntity = new Map<string, FrontendSearchDocument[]>();
  for (const document of input.documents) {
    if (typeof document.metadata.entityId !== "string") continue;
    const documents = documentsByEntity.get(document.metadata.entityId) ?? [];
    documents.push(document);
    documentsByEntity.set(document.metadata.entityId, documents);
  }
  return input.graph.nodes.flatMap((entity) => {
    const entityDocuments = documentsByEntity.get(entity.id) ?? [];
    const indexed = documentScore(query, entity, entityDocuments);
    if (!indexed) return [];
    const indexedReferences = uniqueRefs(entityDocuments.flatMap((document) => document.citations));
    const indexedReferenceKeys = new Set(indexedReferences.map(sourceRefKey));
    const cited = entity.sourceRefs.filter((reference) => indexedReferenceKeys.has(sourceRefKey(reference)));
    if (!cited.length) return [];
    const lexical = entityScore(query, entity);
    const connectedEdges = edgesByEntity.get(entity.id) ?? [];
    const structural = structuralScore(query, entity, connectedEdges, entities);
    const match = {
      score: indexed + lexical.score + structural.score,
      reason: ["index-document", lexical.reason, structural.reason].filter(Boolean).join(",")
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
      factKeys: bestFact(entity, connectedEdges, entities)
    }];
  }).sort((left, right) => right.score - left.score || left.entityKey.localeCompare(right.entityKey))
    .slice(0, input.limit ?? 5);
}
