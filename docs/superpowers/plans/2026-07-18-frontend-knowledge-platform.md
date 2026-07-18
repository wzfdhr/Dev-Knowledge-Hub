# 前端专业知识平台 Implementation Plan

> **For agentic workers:** 本计划必须按编号串行执行。每个版本依次经过“开发 → 技术经理只读复审 → 测试经理真实测试 → 产品经理黄金流程验收 → 用户确认”。任一环节拒绝都回到开发，并重新走完三层复审。

**Goal:** 将 Dev Knowledge Hub 从基础源码搜索升级为面向前端工程师的可追溯工程知识平台；同时在 workspace 内消除重复源文件和纯语法计算，但始终保留项目语义、权限、Graph 和 release 隔离。

**Architecture:** 保留现有 Fastify/PostgreSQL/pg-boss/React 模块化单体和十阶段流水线。`knowledge-ir-v1` 与 `frontend-ir-v2` 作为两类 artifact 并存；十阶段不增减，每个 stage 在 shadow 中同时处理 v1/v2 artifact family。workspace source blob 只做物理存储去重；文件级语法 cache 不含 path/project/source-ref；TypeChecker、模块解析、Graph、检索和发布始终在项目内计算。

**Design:** `docs/superpowers/specs/2026-07-18-frontend-knowledge-platform-design.md`

**Capability matrix:** `docs/product/frontend-capability-matrix.md`

## 全局门禁

1. 本计划与当前 Phase F 生产观察分支隔离。除 FK17 source blob contract 迁移及 FK26、FK29、FK32、FK36 四个框架生产灰度任务外，其余编号不访问生产、不修改 `hub.starking.icu`、不切换生产的任何 `active`。在 V1 Demo 全部复审后，允许在与生产 DB/卷/域名完全隔离的 staging 中为代表项目开启 v2 `active` 以生成不可变测试 release。五个生产任务的每一级操作都需要用户单独授权；FK17 的 contract SQL 在前置条件完成前不得进入发布包或主分支。
2. 每个编号至少一个原子 commit；每个 Release 一个分支和 Draft PR。PR Evidence 按“开发、技术经理、测试经理、产品经理”四段留存。
3. 每任务先写失败测试，确认失败原因正是缺失该能力；再实现最小改动；最后运行定向测试和阶段门禁。
4. 新 parser、新图引擎、数据库合同、公开 API、持久卷、MCP 权限和生产操作在实施前必须向用户列出选项与影响。
5. 每个 SQL migration 必须同时更新 `src/db/schema.ts`、schema/migration test、PostgreSQL integration 和恢复完整性查询。只做 forward migration。
6. 每个 Release 结束运行：

```bash
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run acceptance
npm run evaluate:knowledge
npm run evaluate:frontend
npm run build
npm run test:e2e
npm run test:backup
npm run delivery:verify
```

`TEST_DATABASE_URL` 缺失视为失败；评测数据缺失、跳过或不可重复均视为失败。

## 纵向交付节奏

| 版本 | 交付范围 | 结束时必须可用 | 一人工程周 |
|---|---|---|---:|
| Foundation | 合同、评测、双读、parser runtime | 可安全承载新 analyzer，不改现有 release | 4–6 |
| V1 Demo | React/Vite + ECharts Core 管理员预览端到端 | TS/JS/JSX、React/Vite、React Router、Context/Zustand、fetch/axios、ECharts、核心测试完成导入 → IR → Graph → 知识页 → 搜索 → 前端地图的管理员预览，正式 release/MCP 不变 | 8–10 |
| V1 Trial | 去重存储、React 生态扩充、正式 v2 项目 MCP、跨项目模式、workspace MCP | Storybook、表单/权限、Redux/TanStack Query、OpenAPI/GraphQL、设计系统通过门槛，并完成“当前项目事实 + 历史项目参考”双 Server 真实 Codex 流程 | 10–14 |
| V1 Production | React/Vite 量化门禁、恢复、灰度 | 指定 React/Vite 项目可生产使用和回滚 | 4–6 |
| V1.1 | 横向工程能力补全 | Webpack/Rspack/Rollup、Nx/Turbo、i18n、静态 a11y、Browser Storage 达到深度门槛；错误监控/Web Vitals 达到可引用基础识别 | 8–12 |
| V2 | Next.js App Router/RSC | Next 真实项目同等端到端能力 | 4–6 |
| V3 | Vue 3/Nuxt/Pinia | Vue/Nuxt 真实项目同等端到端能力 | 6–8 |
| V4 | Angular/SvelteKit/Astro 与高级生态 | 每个标记“深度支持”的能力通过同一门槛 | 独立立项 10–14+ |

V1 可演示约在第 12–16 工程周，可试用约在第 22–30 周，可生产约在第 26–36 周。完成 V1.1 横向能力约为第 34–48 工程周，核心范围到 Vue/Nuxt 生产约为 48–68 工程周；Tier 2 不计入 V1 或核心上线承诺。

## Foundation：合同、评测与安全运行时

### FK01 锁定能力矩阵和 held-out 评测协议

**Files:** Modify `docs/product/frontend-capability-matrix.md`, `package.json`, `.github/workflows/ci.yml`; Create `evaluation/frontend/versions.json`, `evaluation/frontend/train/react-core.jsonl`, `evaluation/frontend/train/security-negative.jsonl`, `evaluation/frontend/held-out/react-core.jsonl`, `evaluation/frontend/held-out/security-negative.jsonl`, `fixtures/frontend/react-vite/package.json`, `fixtures/frontend/react-vite/tsconfig.json`, `fixtures/frontend/react-vite/vite.config.ts`, `fixtures/frontend/react-vite/src/main.tsx`, `fixtures/frontend/react-vite/src/app.tsx`, `scripts/evaluate-frontend-knowledge.mjs`, `src/server/knowledge/frontend/evaluation.test.ts`.

**Tests:** 空集、重复 ID、数据泄漏、无引用、未发布答案、实体匹配规则不确定、micro/macro 分母不一致均失败。

**Acceptance:** 评测输出 micro/macro entity F1、fact-edge precision/recall、Recall@5、MRR、citation validity、empty false-positive、impact precision/recall；held-out 不被 analyzer fixture 直接复用；性能基线固定 CPU/内存/数据集。V1 Core 每个“深度支持”能力至少 12 条 train + 8 条 held-out；整体中文不少于 40%，无结果/负例不少于 15%。`versions.json` 先冻结当前仓库 React/Vite/TypeScript 组合及一个批准的 React 18 兼容 fixture，并记录 parser 精确版本；范围变更必须单独复审。

**Commit:** `test: establish professional frontend capability gates`.

### FK02 冻结可实现 Frontend IR v2 合同

**Files:** Create `src/shared/frontend-ir.ts`, `src/shared/frontend-ir.test.ts`, `src/server/knowledge/frontend/analyzer.ts`, `src/server/knowledge/frontend/analyzer-registry.ts`, `src/server/knowledge/frontend/analyzer-registry.test.ts`; Modify `src/shared/api-contracts.ts`, `src/server/knowledge/pipeline/contracts.ts`.

**Contract:** `FrontendEntity` 为按 `kind` 区分的 typed discriminated union；共有字段包含 stable id、`complete|partial`、typed attributes、由 registry schema 验证的 analyzer facets、source refs 和 analyzer provenance。属性级使用 `known | unknown(reason)` 区分确定值与 dynamic/unresolved/limit/unsupported。`FrontendEdge` 区分 `fact|candidate`；fact 必须有引用，candidate 必须有 reason/confidence。

**ID:** `sha256(schema + kind + packageKey + canonicalPath + semanticKey)`，不使用 AST byte offset；匿名节点使用包围语义 key + 稳定 AST 顺序。

**Merge:** core analyzer 拥有 canonical fields，framework analyzer 只能增加自己 namespace facet。同 ID canonical fields 冲突时产生 lint 并阻止 validate；引用去重后排序合并；输出必须确定。

**Commit:** `feat: freeze frontend ir v2 contracts`.

### FK03 提前建立 Graph v2、双 artifact family 和双读兼容

**Files:** Create `drizzle/0031_frontend_contracts_rollout.sql`, `src/server/knowledge/frontend/compatibility.ts`, `src/server/knowledge/frontend/compatibility.test.ts`; Modify `src/db/schema.ts`, `src/db/schema.test.ts`, `src/db/migrate.test.ts`, `src/shared/api-contracts.ts`, `src/server/app.ts`, `src/server/knowledge/build-service.ts`, `src/server/knowledge/releases.test.ts`, `src/server/knowledge/pipeline/artifact-store.ts`, `src/server/knowledge/pipeline/artifact-store.test.ts`, `src/server/knowledge/pipeline/stage-planner.ts`, `src/server/knowledge/pipeline/stage-planner.test.ts`, `src/server/knowledge/pipeline/extract-stage.ts`, `src/server/knowledge/pipeline/graph-stage.ts`, `src/server/knowledge/pipeline/synthesize-stage.ts`, `src/server/knowledge/pipeline/index-stage.ts`, `src/server/knowledge/pipeline/quality-stage.ts`, `src/server/knowledge/pipeline/quality-stage.test.ts`, `src/server/knowledge/pipeline/viz-stage.ts`, `src/server/knowledge/pipeline/viz.test.ts`, `src/server/knowledge/pipeline/validate-stage.ts`, `src/server/knowledge/pipeline/package-stage.ts`, `src/server/knowledge/pipeline/input-digest.ts`, `src/server/persistence/store.ts`, `src/server/persistence/memory-store.ts`, `src/server/persistence/postgres-store.ts`, `src/server/persistence/postgres-knowledge.integration.test.ts`.

**Compatibility:** shadow 中 `extract` 同时输出 `knowledge-ir-v1` 和 `frontend-ir-v2`；`graph` 分别输出 v1/v2 Graph；后续 stage 保留 artifact family；package 记录完整 manifest，但 legacy release 仍只读 v1。同一 stage run 先按 family 分组上游 manifest，对每个启用 family 要求恰好一套所需 kind，分别校验、执行和产出；只有所有启用 family 的物理 artifact 都存在时整个 run 才可复用，否则重建缺失 family。stage digest 包含有序 family 列表、IR/Graph schema 和 analyzer manifest digest。

**Migration:** 增加 Graph v2 kind 约束、`project_frontend_rollouts`、release 的 `release_artifact_family=knowledge-v1|frontend-v2`、`package_stage_run_id`、`frontend_ir_schema_version`、`frontend_graph_schema_version` 和 `analyzer_manifest_digest`，并扩展 release 不可变触发器；`package_stage_run_id` 外键使用 `ON DELETE RESTRICT`。现有所有 legacy 与 `pipeline-package@1` release 只回填 `release_artifact_family=knowledge-v1`，保持原 `kernel_mode/package_artifact_id` 和读取/回滚规则，绝不自动升级或要求 stage run。`knowledge-v1` 分支要求 v2 专属的 `package_stage_run_id/frontend_ir_schema_version/frontend_graph_schema_version/analyzer_manifest_digest` 全部为空，现有 `package_artifact_id` 仍由原 kernel provenance 约束；`frontend-v2` 分支要求四个 v2 专属字段与 `package_artifact_id` 全部非空，且 IR schema=2、Graph schema=2。v2 触发器联结 release、repository、build、stage run 与 artifact，并验证：run 属于当前 workspace/build，run.project 对应 release.repository，`run.snapshot_id=release.snapshot_id`，stage=`package`、状态为 `succeeded|reused`；`package_artifact_id` 位于该 run 的 `output_manifest_ids`，artifact 的 workspace/project/snapshot 与 release/run 相同，且 `kind=frontend-pipeline-package`、`schema_version=2`。artifact 的 `build_job_id` 只表示首次生产者。release service 在进入事务前通过 artifact store 读取并校验物理内容与 digest；数据库触发器不伪装成文件系统检查。

**Acceptance:** 当前 v1 测试全部通过；v2 artifact 不能被 v1 reader 误读。frontend-v2 release 必须由当前 build 的 terminal package stage run 证明 workspace/repository/project/snapshot/build 归属，并绑定其输出 `frontend-pipeline-package@2` 与 analyzer digest，不要求 artifact 首次生产 build 相同。PostgreSQL 集成测试必须覆盖：已发布 v1 `pipeline-package@1` 执行迁移后仍可读取和回滚；v2 provenance 全有或全无；第二次相同构建十阶段全部复用后仍能成功创建不可变 v2 release；伪造 stage run、跨项目 manifest、同项目跨 snapshot artifact、v1 package 冒充 v2、未完成 run、删除已引用 stage run 和物理 package 丢失均被拒绝。

**Commit:** `feat: add dual frontend pipeline contracts`.

### FK04 定义两套模式的项目级有效状态

**Files:** Create `src/server/knowledge/frontend/rollout-mode.ts`, `src/server/knowledge/frontend/rollout-mode.test.ts`; Modify `src/server/env.ts`, `src/server/env.test.ts`, `src/server/bootstrap.ts`, `src/server/app.ts`, `src/server/persistence/store.ts`, `src/server/persistence/postgres-store.ts`.

**Matrix:** `DEVKH_KNOWLEDGE_KERNEL_MODE=legacy` 时 frontend 强制 legacy；kernel `shadow` 时 frontend 只能 legacy/shadow；kernel `active` 时 frontend 才可按项目 legacy/shadow/active。`DEVKH_FRONTEND_KNOWLEDGE_MODE` 是系统允许上限，DB project override 是实际值，不得越过上限。

**Acceptance:** 无项目 override 默认 legacy；配置不可能组合拒绝启动或拒绝修改；环境变量和 override 都不改历史 release 读取。只有 workspace admin 可修改 override，project admin/member/reader 均返回 403；每次变更在同一事务写 actor、from/to mode、project 和原因的审计事件，不记录凭据。

**Commit:** `feat: enforce project frontend rollout modes`.

### FK05 建立隔离且可终止的 parser service runtime

**Files:** Create `src/server/knowledge/frontend/runtime/parser-service.ts`, `src/server/knowledge/frontend/runtime/parser-service.test.ts`, `src/server/knowledge/frontend/runtime/parser-client.ts`, `src/server/knowledge/frontend/runtime/parser-client.test.ts`, `src/server/knowledge/frontend/runtime/analyzer-worker.ts`, `src/server/knowledge/frontend/runtime/virtual-source-fs.ts`, `src/server/knowledge/frontend/runtime/virtual-source-fs.test.ts`, `docs/operations/parser-runtime.md`; Modify `Dockerfile`, `docker-compose.yml`, `src/server/bootstrap.ts`, `src/server/knowledge/pipeline/extract-stage.ts`, `.github/workflows/ci.yml`.

**Isolation:** 生产 parser 是独立 Compose service，通过共享 runtime volume 上的 Unix domain socket 接收长度分帧消息。parser 容器使用 `network_mode: none`、`read_only: true`、只写 tmpfs、非 root user、`cap_drop: ALL`、`no-new-privileges`、pids/memory/CPU 限额，不挂载生产凭据、数据库或源码卷。它只接收验证后 bytes 和虚拟只读路径，不执行 config/package script；容器内部的 worker 负责 wall-clock timeout、取消、输出 byte/node 限额和 crash replacement。本地单测可用清空环境的 child process transport，但不得被记为生产安全证据。

**Acceptance:** 死循环、OOM 候选、巨型 AST、超大输出、取消、worker crash 和 parser service 重启只失败当前 stage，不终止 API 进程；容器证据验证无网络、无凭据、无项目卷、只读根文件系统和资源限额；parser service 不可用时 v2 stage 稳定失败 `PARSER_RUNTIME_UNAVAILABLE`，legacy 读取不受影响。

**Commit:** `security: isolate frontend analyzers`.

**Foundation gate:** 现有 release/MCP 输出不变；v2 合同可实现、双读顺序闭合、项目灰度有效、parser 失控可终止。

## V1 Demo：React/Vite + ECharts 端到端

### FK06 放行前端文本与受限资产清单

**Files:** Modify `src/shared/import-filter.ts`, `src/shared/import-filter.test.ts`, `src/client/api/folder-import.ts`, `src/client/api/folder-import.test.ts`, `src/server/uploads/folder-import.ts`, `src/server/uploads/folder-import.test.ts`, `src/client/components/import-report.tsx`, `src/client/api/types.ts`.

**Acceptance:** `.vue/.html/.css/.scss/.sass/.less/.svelte/.astro/.d.ts` 和必要前端 config 双端一致；SVG 作受限文本解析但永不直接渲染；图片/字体/媒体只存 `trust=client_unverified` 的 asset manifest，API 和界面显示“未由服务端验证”，不作为服务端内容事实、Graph 事实边或 citation。忽略目录在读取内容前跳过。

**Commit:** `feat: ingest frontend source formats`.

### FK07 建立 monorepo/TypeScript project graph 和文件级语法 cache

**Files:** Create `drizzle/0032_source_analysis_artifacts.sql`, `src/server/knowledge/frontend/project-manifest.ts`, `src/server/knowledge/frontend/project-manifest.test.ts`, `src/server/knowledge/frontend/typescript-program.ts`, `src/server/knowledge/frontend/typescript-program.test.ts`, `src/server/knowledge/frontend/source-analysis-cache.ts`, `src/server/knowledge/frontend/source-analysis-cache.test.ts`; Modify `src/db/schema.ts`, `src/db/schema.test.ts`, `src/db/migrate.test.ts`, `src/server/persistence/store.ts`, `src/server/persistence/postgres-store.ts`, `src/server/persistence/postgres-knowledge.integration.test.ts`, `src/server/knowledge/pipeline/extract-stage.ts`.

**Acceptance:** npm/pnpm/yarn/bun workspace、package exports/imports、tsconfig extends/references/paths 形成受限 Program/TypeChecker；不读 node_modules、不访网络。cache key 为 workspace/hash/analyzer/version/config digest，只存相对位置和纯语法 facts；path/snapshot/source refs 在项目链接阶段重绑定。不改现有 project-scoped `knowledge_artifacts` 隔离索引。

**Commit:** `feat: analyze typed frontend workspaces`.

### FK08 解析 JS/TS/JSX/HTML/CSS 与设计令牌

**Files:** Create `src/server/knowledge/frontend/typescript-analyzer.ts`, `src/server/knowledge/frontend/typescript-analyzer.test.ts`, `src/server/knowledge/frontend/html-analyzer.ts`, `src/server/knowledge/frontend/html-analyzer.test.ts`, `src/server/knowledge/frontend/style-analyzer.ts`, `src/server/knowledge/frontend/style-analyzer.test.ts`; Modify `package.json`, `package-lock.json`, `scripts/licenses-check.mjs`, `src/shared/frontend-ir.ts`, `src/server/knowledge/pipeline/extract-web.ts`.

**Dependency gate:** 实施前交用户审批 parse5、postcss、postcss-selector-parser、postcss-scss、postcss-less 的许可、维护、体积与恶意输入报告。

**Acceptance:** overload/generic/re-export/barrel/dynamic import/JSX render、DOM landmark/form、CSS Modules/custom properties/Sass/Less/media/container query 进入 IR；Tailwind/UnoCSS config/utility 和可静态识别的 CSS-in-JS template 按能力矩阵产生基础事实；标识符稳定；partial 明确表示；所有事实有 source ref。

**Commit:** `feat: extract web language semantics`.

### FK09 深化 React/Vite 核心链路

**Files:** Create `src/server/knowledge/frontend/react-analyzer.ts`, `src/server/knowledge/frontend/react-analyzer.test.ts`, `src/server/knowledge/frontend/react-router-analyzer.ts`, `src/server/knowledge/frontend/react-router-analyzer.test.ts`, `src/server/knowledge/frontend/state-data-analyzer.ts`, `src/server/knowledge/frontend/state-data-analyzer.test.ts`; Modify `src/shared/frontend-ir.ts`, `fixtures/frontend/react-vite/package.json`, `fixtures/frontend/react-vite/src/main.tsx`, `fixtures/frontend/react-vite/src/app.tsx`, `evaluation/frontend/train/react-core.jsonl`, `evaluation/frontend/held-out/react-core.jsonl`.

**Acceptance:** React 18/19 组件、props/defaults/ref、Hook/effect、Context、JSX render tree、React Router route/layout/loader/action/guard/lazy；Context/Zustand、fetch/axios 和基础 error/loading 消费者形成事实链。Redux Toolkit、TanStack Query、OpenAPI/GraphQL、复杂表单/权限放到 V1 Trial；WebSocket/SSE、Feature Flag 和 Browser Storage 在 Demo 只做基础识别。

**Commit:** `feat: model react application flows`.

### FK10 深化 ECharts 和 React 工程生态

**Files:** Create `src/server/knowledge/frontend/visualization-analyzer.ts`, `src/server/knowledge/frontend/visualization-analyzer.test.ts`, `src/server/knowledge/frontend/tooling-test-analyzer.ts`, `src/server/knowledge/frontend/tooling-test-analyzer.test.ts`, `src/server/knowledge/frontend/frontend-static-lint.ts`, `src/server/knowledge/frontend/frontend-static-lint.test.ts`, `fixtures/frontend/visualization/package.json`, `fixtures/frontend/visualization/src/chart.tsx`, `fixtures/frontend/visualization/src/chart.test.tsx`, `fixtures/frontend/visualization/e2e/chart.spec.ts`; Modify `src/shared/frontend-ir.ts`, `evaluation/frontend/train/react-core.jsonl`, `evaluation/frontend/held-out/react-core.jsonl`.

**Acceptance:** ECharts init/setOption/dataset/series/axis/visualMap/dataZoom/brush/event/dispose/resize、封装组件、option builder 和数据源可查询；Vite、Vitest/Jest/Testing Library/Playwright/Cypress 达到 V1 Core 深度门槛。Storybook、Webpack/Rspack/Rollup、Nx/Turbo、i18n、a11y、错误监控/Web Vitals 在 Demo 只做基础识别，按 V1 Trial/V1.1 门禁逐项升级。不宣称替代 runtime profiling/axe/Lighthouse。

**Commit:** `feat: understand react frontend ecosystem`.

### FK11 打通 React Frontend Graph、知识页、检索与影响

**Files:** Create `src/server/knowledge/frontend/graph-builder.ts`, `src/server/knowledge/frontend/graph-builder.test.ts`, `src/server/knowledge/frontend/knowledge-generator.ts`, `src/server/knowledge/frontend/knowledge-generator.test.ts`, `src/server/knowledge/frontend/change-impact.ts`, `src/server/knowledge/frontend/change-impact.test.ts`, `src/server/knowledge/frontend/quality-assessment.ts`, `src/server/knowledge/frontend/quality-assessment.test.ts`; Modify `src/server/knowledge/pipeline/graph.ts`, `src/server/knowledge/pipeline/graph-stage.ts`, `src/server/knowledge/pipeline/synthesize-stage.ts`, `src/server/knowledge/pipeline/index-stage.ts`, `src/server/knowledge/pipeline/quality-stage.ts`, `src/server/knowledge/pipeline/validate-stage.ts`, `src/server/persistence/postgres-store.ts`, `src/server/knowledge/change-impact.ts`.

**Acceptance:** 页面 → 组件 → state/API/style/chart/test 可定向追踪；Graph 事实/候选分层；生成架构、路由、组件、数据、图表、构建测试页；变更返回受影响页面/测试但不自动构建或发布。

**Commit:** `feat: deliver react frontend knowledge graph`.

### FK12 交付 React 前端地图和管理员预览

**Files:** Create `src/client/pages/project-frontend-map-page.tsx`, `src/client/pages/project-frontend-map-page.test.tsx`, `src/client/components/frontend-map/route-tree.tsx`, `src/client/components/frontend-map/component-catalog.tsx`, `src/client/components/frontend-map/data-flow.tsx`, `src/client/components/frontend-map/visualization-catalog.tsx`, `src/client/components/frontend-map/tooling-tests.tsx`; Modify `src/client/app.tsx`, `src/client/components/project-layout.tsx`, `src/client/api/client.ts`, `src/client/api/types.ts`, `src/client/workbench.css`, `src/client/responsive.css`, `src/server/app.ts`, `src/server/app.test.ts`.

**Preview:** Demo 阶段只有 workspace admin 可通过已鉴权的 comparison/preview API 读取 v2 candidate package。现有项目 MCP、workspace 搜索和 current release 继续读 v1，不暴露 v2 shadow 结果。

**Acceptance:** 项目地图含概览、路由/页面、组件/设计系统、状态/数据、可视化、构建/测试；每项可打开引用；1440px 完整操作，390/320px 保证可读和基础导航，不强求在 320px 展开复杂 Graph。

**Commit:** `feat: add react frontend map preview`.

### FK13 V1 Demo 评测、状态矩阵与 shadow 对比

**Files:** Create `src/server/knowledge/frontend/comparison.ts`, `src/server/knowledge/frontend/comparison.test.ts`, `docs/operations/frontend-v1-demo.md`; Modify `scripts/evaluate-frontend-knowledge.mjs`, `src/server/app.ts`, `src/client/pages/project-frontend-map-page.tsx`, `src/client/app.test.tsx`, `playwright.config.ts`.

**States:** 未导入、已导入未构建、构建失败、候选未发布、已发布但快照更新、Graph 为空、权限失效、网络失败、引用失效。每个状态说明发生了什么、数据是否安全、下一步和重试幂等性。

**Acceptance:** 真实 React/Vite + ECharts 项目通过管理员 preview 走完“页面到 API 排错”和“改动影响与测试建议”；shadow 比较 v1/v2 实体、边、页、搜索、影响、质量和引用；当前 release、正式搜索和 MCP 不变。

**Commit:** `test: accept react frontend vertical demo`.

**V1 Demo gate:** 不依赖去重存储或跨项目能力就可以演示完整的 React/Vite 项目知识链。产品价值不得继续被后续基础设施阻塞。

## V1 Trial：去重存储与历史项目经验

### FK14 实现可恢复的分页上传会话

**Files:** Create `drizzle/0033_upload_sessions.sql`, `src/client/api/upload-manifest-worker.ts`, `src/client/api/upload-manifest.test.ts`, `src/server/uploads/upload-session.ts`, `src/server/uploads/upload-session.test.ts`; Modify `src/db/schema.ts`, `src/db/schema.test.ts`, `src/db/migrate.test.ts`, `src/client/api/client.ts`, `src/client/api/types.ts`, `src/server/app.ts`, `src/server/upload-routes.test.ts`, `src/server/persistence/store.ts`, `src/server/persistence/memory-store.ts`, `src/server/persistence/postgres-store.ts`, `src/server/persistence/postgres-knowledge.integration.test.ts`.

**Protocol:** `POST .../upload-sessions` 创建会话；`PUT .../manifest-pages/:page` 上传最多 500 条 JSON manifest；`PUT .../files/:ordinal` 以 `application/octet-stream` 上传 `upload_required` bytes；`POST .../commit` 提交 manifest digest；`DELETE .../:sessionId` 取消。所有 PUT/POST 要求 `Idempotency-Key`。

**Security:** session 绑定 workspace/project/user/sessionVersion，24 小时过期；每次请求重新鉴权；成员失权、禁用或会话版本变更后 manifest/file/commit 均拒绝；过期会话定时清理。

**Acceptance:** 浏览器 Web Crypto Worker 计算 hash；服务端对上传 bytes 重算 hash/过滤/限额；未上传 bytes 的资产响应固定包含 `trust=client_unverified`，前端固定显示“未由服务端验证”且禁止生成事实/Graph/citation；重启、重放、乱序分页、中断和并发 commit 可幂等处理。

**Commit:** `feat: add durable folder upload sessions`.

### FK15 建立同卷 workspace blob store 和统一快照视图

**Files:** Create `drizzle/0034_source_blobs.sql`, `src/server/uploads/source-blob-store.ts`, `src/server/uploads/source-blob-store.test.ts`, `src/server/knowledge/pipeline/source-blob-reader.ts`, `src/server/knowledge/pipeline/source-blob-reader.test.ts`; Modify `src/db/schema.ts`, `src/db/schema.test.ts`, `src/db/migrate.test.ts`, `src/server/uploads/folder-import.ts`, `src/server/git/snapshot.ts`, `src/server/knowledge/pipeline/convert.ts`, `src/server/knowledge/pipeline/convert-stage.ts`, `src/server/knowledge/pipeline/extract-stage.ts`, `src/server/knowledge/pipeline/extract-stage.test.ts`, `src/server/knowledge/pipeline/tables-stage.ts`, `src/server/knowledge/pipeline/tables-stage.test.ts`, `src/server/knowledge/pipeline/stage-planner.ts`, `src/server/knowledge/pipeline/stage-planner.test.ts`, `src/server/persistence/store.ts`, `src/server/persistence/postgres-store.ts`, `src/server/persistence/postgres-knowledge.integration.test.ts`, `src/server/bootstrap.ts`, `src/server/env.ts`, `docker-compose.yml`.

**Storage:** `source_blobs` 使用不可变 generation：`id` 主键、`(workspace_id, content_hash, generation)` 唯一，并对 `active|tombstoned` 建立同 workspace/hash 单代约束；`source_files.source_blob_id` 绑定具体 generation。目标 `snapshot_data` 单卷同时存 `blobs/<workspace>/<prefix>/<sha256>/<generation>` 和 `snapshots/<snapshot>/files/...` hardlink view；不产生跨卷 hardlink。文件夹上传和 Git 快照都通过 blob store。

**Convert:** v2 `normalized-source-refs` artifact 只存 blob hash、规范化元数据和项目 path/ref，不复制全量源码 bytes。`extract`/`tables` 按 artifact family 选择 v1 inline bytes 或 v2 blob reader，对 blob 重验 hash/size/workspace 并重绑定 path/source refs；stage planner 确保两种上游合同不混用。shadow 期 v1 `normalized-sources` 仍保留，只在 v2 active 后新构建停止该重复。

**Concurrency:** 上传与 GC 对 workspace/hash 使用同一 advisory lock；temp write → `fsync` → hash verify → atomic link/rename → active-generation unique insert。同 workspace 并发同 hash 只留一份；旧 generation 已进入 `trash/deleted` 时，重新验证 bytes 后创建新 generation，旧 GC 只可用 fencing token 删除自己锁定的 generation；跨 workspace 永不复用。

**Migration order:** expand：新增 nullable `source_blob_id`、generation 表和索引，不改变 legacy 读取；dual-write/read：shadow 同时写 legacy source 与 blob/view，并逐文件比对 hash/bytes；checkpoint backfill：按 workspace/snapshot 分批回填，可暂停、重入并记录游标；active preflight：要求所有可发布 snapshot 的 source file 均有有效 generation、hardlink 能力、备份恢复和引用完整性通过；contract：active 观察与回滚窗口结束且用户批准后，才收紧 `source_blob_id` 约束并停止 legacy 新写入，不删除仍被历史 release/回滚依赖的旧数据。

**Commit:** `feat: unify snapshots on workspace source blobs`.

### FK16 回填、备份、恢复与延迟 GC

**Files:** Create `scripts/migrations/backfill-source-blobs.mjs`, `scripts/migrations/backfill-source-blobs.test.mjs`, `src/server/uploads/source-blob-gc.ts`, `src/server/uploads/source-blob-gc.test.ts`, `docs/operations/source-blob-rollout.md`; Modify `scripts/backup/devkh-backup.sh`, `scripts/backup/devkh-restore-drill.sh`, `scripts/backup/validate-recovery-evidence.mjs`, `scripts/backup/backup.test.mjs`, `scripts/backup/seed-ci-recovery-fixture.sh`, `docs/architecture.md`, `docs/operations/encrypted-offsite-backups.md`.

**Acceptance:** blob 和 snapshot view 在同一 `snapshots.tgz` 归档，恢复验证 DB 引用、hash、generation、inode 共享和物理占用；回填分批、可恢复、不改 release；`DEVKH_SOURCE_STORAGE_MODE=legacy|shadow|active` 默认 legacy。GC 默认关闭；启用后按 generation 执行 `active -> tombstoned -> trash -> deleted`：workspace/hash advisory lock + 事务内二次确认零引用并写 fencing token/tombstone；同卷原子移动到 `.trash/<workspace>/<hash>/<generation>` 并 `fsync` 父目录；额外宽限期后才删除。reconciliation 覆盖移动前、移动后和物理删除后的崩溃；新引用只能绑定 active generation，移动前出现引用则取消 tombstone；trash/deleted 旧代不复活，但服务端重新验证的相同 bytes 可创建新代。测试覆盖上传与 tombstone、trash 移动、物理删除的全部并发顺序，旧 GC 永不删除新 generation；任何不一致停止并审计。

**Commit:** `feat: make deduplicated snapshots recoverable`.

### FK17 独立执行 source blob contract migration

**Files:** Create `drizzle/0035_source_blobs_contract.sql`, `docs/releases/source-blob-contract-evidence.md`; Modify `src/db/schema.ts`, `src/db/schema.test.ts`, `src/db/migrate.test.ts`, `src/server/persistence/postgres-knowledge.integration.test.ts`, `src/server/uploads/source-blob-store.ts`, `src/server/uploads/source-blob-store.test.ts`, `scripts/release-verify.mjs`, `docs/operations/source-blob-rollout.md`.

**Delivery boundary:** 独立分支、独立 PR、独立部署。`0035_source_blobs_contract.sql` 只能在该任务分支创建，且在 checkpoint backfill 完成、active preflight 全绿、dual-read 生产观察至少 7 天、备份恢复证据有效和用户明确授权前不得合并或进入应用镜像。FK15 的 `0034` 只包含 expand，不包含 NOT NULL、旧写入停止或删除。

**Preflight:** 再次验证 `source_blob_id` 零空值、每条引用的 workspace/hash/generation、active generation 唯一性、snapshot hardlink/inode、物理 hash、备份恢复、磁盘容量和历史 release 依赖。任一失败则不执行 migration，服务继续 dual-read/dual-write。

**Contract:** 先部署仍能 dual-read/write 的 forward-compatible 应用并确认健康，再在单个 PostgreSQL 事务中验证并收紧引用约束，最后切到 blob active write 并停止 legacy 新写入；不删除历史 release 或回滚证据依赖的旧数据。SQL 提交前任一步失败都保持 dual-read/write 并保留诊断；SQL 成功后只能回滚到认识 `source_blob_id` 的 forward-compatible 应用版本，不能回滚到旧 schema 客户端。

**Acceptance:** 独立容器环境和生产前检查均通过；迁移器不会在 FK17 PR 合并前看到 contract SQL；空引用、错 workspace/hash/generation、hardlink 损坏、恢复证据过期和未授权执行全部被阻断。

**Commit:** `migration: contract verified source blob references`.

### FK18 扩充 React Trial 生态能力

**Files:** Create `src/server/knowledge/frontend/react-ecosystem-analyzer.ts`, `src/server/knowledge/frontend/react-ecosystem-analyzer.test.ts`, `evaluation/frontend/train/react-trial.jsonl`, `evaluation/frontend/held-out/react-trial.jsonl`; Modify `src/shared/frontend-ir.ts`, `src/server/knowledge/frontend/state-data-analyzer.ts`, `src/server/knowledge/frontend/tooling-test-analyzer.ts`, `src/server/knowledge/frontend/style-analyzer.ts`, `fixtures/frontend/react-vite/package.json`, `fixtures/frontend/react-vite/src/app.tsx`, `evaluation/frontend/versions.json`, `docs/product/frontend-capability-matrix.md`.

**Acceptance:** Redux Toolkit、TanStack Query、OpenAPI/GraphQL、复杂表单校验、权限守卫、Storybook、设计令牌/组件库封装达到“深度支持”的横向门槛后才在产品中显示为已支持。Webpack/Rspack/Rollup、Nx/Turbo、i18n、a11y、错误监控/Web Vitals 保持基础识别，列入 V1.1，不被 V1 Trial 工期强行承诺。

**Commit:** `feat: deepen approved react ecosystem knowledge`.

### FK19 建立可追溯 workspace patterns 与分区检索

**Files:** Create `drizzle/0036_workspace_patterns_search.sql`, `src/server/knowledge/frontend/patterns.ts`, `src/server/knowledge/frontend/patterns.test.ts`, `src/server/knowledge/frontend/search-intent.ts`, `src/server/knowledge/frontend/search-intent.test.ts`; Modify `src/db/schema.ts`, `src/db/schema.test.ts`, `src/db/migrate.test.ts`, `src/server/persistence/store.ts`, `src/server/persistence/memory-store.ts`, `src/server/persistence/postgres-store.ts`, `src/server/persistence/postgres-knowledge.integration.test.ts`, `src/server/knowledge/pipeline/index-stage.ts`, `src/server/app.ts`, `src/client/api/types.ts`.

**Precondition:** V1 Demo 三层复审通过后，在与生产完全隔离的 staging 中为两个代表项目开启 v2 `active`，人工创建不可变 v2 release。pattern 和 workspace 检索只使用这些已发布 staging release，不读 shadow candidate。

**Response:** REST 搜索请求显式接收 `currentProjectId?: string`；响应强制拆为 `currentProjectFacts` 和 `priorProjectReferences`，另带 `currentProjectStatus=not_selected|ready|no_release|stale`。未选当前项目时只返回团队搜索结果，`currentProjectFacts=[]`；选中后 `priorProjectReferences` 的 evidence、计数、Trust 和排序必须排除当前项目，不得把当前事实重复冒充历史参考；显式提交无权项目返回 `403 PROJECT_ACCESS_DENIED`，不返回普通空状态。

**Acceptance:** 持久层按 evidence 保存已发布 release/Graph/citations 和规范化特征，pattern 主记录只用 opaque id/类别，不把全 workspace 聚合文案作为用户结果。每次查询先实时过滤项目 ACL，再只用可见 evidence 计算标题、特征、Trust、计数、排序、推荐门槛和批准有效性；缓存键包含 ACL revision 与可见 release 集。候选 pattern 不默认推荐；精确符号/路径优先于扩展意图；结果包含 match reason、Trust、project、release 和 citations。负向测试使用“授权普通实现 + 未授权含唯一秘密符号实现”，REST、计数、排序、缓存与 workspace MCP 均不得出现或受该秘密影响。

**Commit:** `feat: derive authorized frontend patterns`.

### FK20 建立独立 workspace MCP 凭据全生命周期

**Files:** Create `drizzle/0037_workspace_mcp_tokens.sql`, `src/server/mcp/workspace-auth.ts`, `src/server/mcp/workspace-auth.test.ts`, `docs/operations/workspace-mcp.md`; Modify `src/db/schema.ts`, `src/db/schema.test.ts`, `src/db/migrate.test.ts`, `src/server/app.ts`, `src/server/mcp/tools.ts`, `src/server/mcp-access.test.ts`, `src/server/persistence/store.ts`, `src/server/persistence/memory-store.ts`, `src/server/persistence/postgres-store.ts`, `src/server/persistence/postgres-knowledge.integration.test.ts`, `src/client/pages/system-settings-page.tsx`, `src/client/pages/project-codex-page.tsx`, `src/client/api/client.ts`, `src/client/api/types.ts`.

**Security:** 现有 project token 模型与 scope 不改。`workspace_mcp_tokens` 绑定 workspace/user/sessionVersion，最长 30 天，只允许当前用户为自己创建；plaintext 只展示一次，DB 只存 hash/prefix；实现过期、撤销、原子轮换、last-used、限流、审计和过期清理。

**MCP:** 项目 `/mcp` 在所绑定 release 具有 v2 provenance 时新增 `dkh_get_frontend_map` 并扩展 `dkh_get_change_context`；否则保持 v1 结果。`/mcp/workspace` 只提供 `dkh_find_prior_implementations(currentProjectId, query, ...)`，且只读已发布 v2 release；`currentProjectId` 必填，缺失返回 MCP invalid params，服务端实时验证调用者对当前项目的权限，并从 evidence、结果、计数、Trust、排序和缓存中排除当前项目。scope 固定 `workspace.patterns.read`；每次调用检查成员禁用、sessionVersion 和项目 ACL。Codex 配置明确列出“当前项目知识”与“历史项目参考”两个 server；普通团队搜索只走 REST。

**UI:** workspace Token 管理位于“工作区设置 → 集成”，展示 scope、有效期、当前可访问项目数、最近使用、撤销和轮换；项目 Codex 页只保留项目 Token 和跳转入口。不缓存项目列表作为授权。

**Commit:** `feat: add user bound workspace mcp access`.

### FK21 升级全局知识页、对比和专业 Graph

**Files:** Create `src/client/components/frontend-search-results.tsx`, `src/client/components/frontend-search-results.test.tsx`, `src/client/components/pattern-comparison.tsx`, `src/client/components/pattern-comparison.test.tsx`, `src/client/components/frontend-map/impact-panel.tsx`; Modify `src/client/pages/knowledge-page.tsx`, `src/client/pages/project-graph-page.tsx`, `src/client/components/knowledge-graph-explorer.tsx`, `src/client/features/graph/graph-view-model.ts`, `src/client/api/client.ts`, `src/client/api/types.ts`, `src/client/styles.css`, `src/client/responsive.css`, `src/client/workbench.css`.

**Graph dependency gate:** 实施前对比扩展当前 SVG 与 Cytoscape.js + 服务端子图分页。技术推荐后者，但修改 lockfile 前必须用户确认。

**Acceptance:** 全局页有实时按 ACL 过滤的“当前项目”选择器，并分区展示当前事实/历史参考；未选项目时明确显示团队搜索模式。支持框架/能力/项目/命中类型筛选、两实现对比和分别针对“当前事实无结果”/“历史参考无结果”的反馈入口。Graph 默认子图 <=500 节点/1,500 边，支持聚类、聚焦、边筛选、事实/候选分层、键盘、源码侧栏和影响高亮；JSON/Mermaid/Markmap 仅作导出。

**Commit:** `feat: deliver workspace frontend knowledge experience`.

### FK22 完成 V1 Trial 黄金流程

**Files:** Create `acceptance/frontend-prior-implementation.acceptance.test.ts`, `acceptance/frontend-page-api.acceptance.test.ts`, `acceptance/frontend-change-impact.acceptance.test.ts`, `docs/operations/frontend-v1-trial.md`; Modify `src/client/app.test.tsx`, `playwright.config.ts`, `evaluation/frontend/train/react-trial.jsonl`, `evaluation/frontend/train/security-negative.jsonl`, `evaluation/frontend/held-out/react-trial.jsonl`, `evaluation/frontend/held-out/security-negative.jsonl`.

**Golden flows:**
1. 新功能历史借鉴：Codex 先从 project MCP 获得当前项目约束，再用同一 `currentProjectId` 从 workspace MCP 获得排除当前项目后的授权历史实现，两类引用不混合。
2. 页面到 API 排错：从 route/page/component/state/query 追踪到 API operation 与 error handling。
3. 改动影响：修改 prop/store/API/style token/chart option 后返回受影响页面和测试。

**Upload report:** 返回 logicalFiles/logicalBytes、uploadedFiles/uploadedBytes、authorizedReusedFiles/authorizedReusedBytes、unchanged。因未授权项目而在服务器内部去重的命中不得进入用户可见统计。

**Commit:** `test: accept frontend workspace trial flows`.

**V1 Trial gate:** 三条黄金流程、权限即时失效、重复上传和状态矩阵均在真实代表项目通过。

## V1 Production：量化门禁与 React/Vite 灰度

### FK23 建立前端量化 CI 门禁

**Files:** Modify `scripts/evaluate-frontend-knowledge.mjs`, `scripts/release-verify.mjs`, `.github/workflows/ci.yml`, `package.json`, `evaluation/frontend/held-out/react-core.jsonl`, `evaluation/frontend/held-out/react-trial.jsonl`, `evaluation/frontend/held-out/security-negative.jsonl`; Create `docs/operations/frontend-quality-gates.md`.

**Thresholds:** citation validity = 100%；unauthorized/unpublished leakage = 0；Recall@5 >= 0.92；MRR >= 0.80；micro/macro core entity F1 >= 0.92；fact-edge precision >= 0.95；impact Top-10 precision >= 0.85；test-impact recall >= 0.90。

**Acceptance:** held-out 指标低于门槛、数据缺失、跳过或性能环境不匹配均失败；任何排序调整只在 Recall@5/MRR 均不下降且至少一项提升 0.01 时启用。

**Commit:** `test: gate react frontend knowledge quality`.

### FK24 完成压力、parser 安全和一致性恢复

**Files:** Create `src/server/frontend-platform-stress.test.ts`, `scripts/security/parser-fuzz.mjs`, `docs/operations/frontend-platform-recovery.md`; Modify `scripts/backup/devkh-backup.sh`, `scripts/backup/devkh-restore-drill.sh`, `scripts/backup/ci-recovery-drill.sh`, `scripts/backup/backup.test.mjs`, `scripts/backup/validate-recovery-evidence.mjs`, `scripts/backup/validate-recovery-evidence.test.mjs`, `scripts/backup/seed-ci-recovery-fixture.sh`, `scripts/verify-delivery.mjs`, `.github/workflows/ci.yml`.

**Acceptance:** 60,000 忽略文件 + 2,000 有效文件不读忽略内容；50,001 有效文件上传前拒绝；同时 3 导入/2 构建/10 搜索不串项目；搜索 P95 <=1s；Graph 首屏 <=2.5s；恢复后 DB/blob/inode/snapshot/artifact/release 一致。

**Commit:** `test: prove frontend platform scale and recovery`.

### FK25 React/Vite 项目级灰度与回滚演练

**Files:** Modify `src/server/knowledge/frontend/rollout-mode.ts`, `src/server/knowledge/releases.test.ts`, `src/server/knowledge/pipeline/package-stage.ts`; Create `docs/operations/frontend-v1-rollout.md`, `acceptance/frontend-release-provenance.acceptance.test.ts`.

**Acceptance:** frontend v2 release 必须绑定当前 build 的成功/复用 package stage run、该 run 输出的 package artifact、IR schema、Graph schema、analyzer manifest digest；artifact 首次生产 build 可以不同。历史 release 读取不依赖当前环境。回滚仅把项目 override 切回 shadow/legacy 并指回最后 legacy release，不删新表/blob/release。

**Commit:** `test: rehearse react frontend release rollback`.

**V1 Production gate:** 量化门禁、恢复、回滚和代表 React/Vite 项目 shadow 连续成功；只能进入 FK26 的 React/Vite 灰度，不自动切换生产。

### FK26 React/Vite 生产灰度

**Files:** Create `docs/releases/frontend-v1-production-evidence.md`; Modify `docs/operations/frontend-v1-rollout.md`.

**Preconditions:** 当前 Phase F 观察已结束；V1 经四角色通过；备份/恢复/回滚有当期证据；用户对每一级单独授权。

**Rollout:** 管理员测试项目 → 一个真实 React/Vite 项目观察 24 小时 → 全部非关键 React/Vite 项目观察 24 小时 → 用户再确认 → React/Vite 项目全 workspace。任一权限泄漏、数据损坏、引用失效、恢复失败、黄金流程失败、连续两次 v2 构建失败、搜索 P95 >1s 或 Graph 首屏 >2.5s 立即切回 shadow/legacy。

**Acceptance:** 在 `hub.starking.icu` 逐项验证导入、构建、发布、知识页、Graph、搜索、反馈、跨项目拒绝和回滚；完整运行 project MCP + workspace MCP 双 Server 黄金流程，验证 workspace Token 过期/撤销即时失效、`currentProjectId` 实时验权且当前项目不进入历史结果/计数/Trust/排序。观察 48 小时并留存指标与用户授权证据。

**Commit:** `release: activate approved react frontend projects`.

## V1.1：横向工程能力补全

### FK27 深化工具链、质量与浏览器运行时知识

**Files:** Create `src/server/knowledge/frontend/toolchain-analyzer.ts`, `src/server/knowledge/frontend/toolchain-analyzer.test.ts`, `src/server/knowledge/frontend/monorepo-task-analyzer.ts`, `src/server/knowledge/frontend/monorepo-task-analyzer.test.ts`, `src/server/knowledge/frontend/i18n-analyzer.ts`, `src/server/knowledge/frontend/i18n-analyzer.test.ts`, `src/server/knowledge/frontend/accessibility-analyzer.ts`, `src/server/knowledge/frontend/accessibility-analyzer.test.ts`, `src/server/knowledge/frontend/runtime-quality-analyzer.ts`, `src/server/knowledge/frontend/runtime-quality-analyzer.test.ts`, `src/server/knowledge/frontend/browser-storage-analyzer.ts`, `src/server/knowledge/frontend/browser-storage-analyzer.test.ts`, `fixtures/frontend/react-vite/webpack.config.ts`, `fixtures/frontend/react-vite/rspack.config.ts`, `fixtures/frontend/react-vite/rollup.config.mjs`, `fixtures/frontend/react-vite/nx.json`, `fixtures/frontend/react-vite/project.json`, `fixtures/frontend/react-vite/turbo.json`, `fixtures/frontend/react-vite/src/i18n.ts`, `fixtures/frontend/react-vite/src/monitoring.ts`, `fixtures/frontend/react-vite/src/storage.ts`, `evaluation/frontend/train/react-horizontal.jsonl`, `evaluation/frontend/held-out/react-horizontal.jsonl`; Modify `src/shared/frontend-ir.ts`, `src/server/knowledge/frontend/analyzer-registry.ts`, `evaluation/frontend/versions.json`, `docs/product/frontend-capability-matrix.md`.

**Acceptance:** Webpack/Rspack/Rollup entry/alias/plugin/chunk、Nx/Turbo task/cache graph、i18n key definition/consumer/missing、静态 a11y name/role/label/keyboard facts 和 Browser Storage reader/writer 达到“深度支持”横向门槛。错误监控与 Web Vitals 只做有精确引用的 boundary/reporter/config 基础识别，不宣称运行时性能诊断；不执行任何 config 或 plugin。

**Commit:** `feat: complete horizontal frontend engineering knowledge`.

### FK28 打通 V1.1 知识产品与评测

**Files:** Create `acceptance/frontend-horizontal-capabilities.acceptance.test.ts`, `docs/operations/frontend-v1-1-rollout.md`; Modify `src/server/knowledge/frontend/graph-builder.ts`, `src/server/knowledge/frontend/knowledge-generator.ts`, `src/server/knowledge/frontend/change-impact.ts`, `src/server/knowledge/frontend/quality-assessment.ts`, `src/client/pages/project-frontend-map-page.tsx`, `scripts/evaluate-frontend-knowledge.mjs`, `evaluation/frontend/train/react-horizontal.jsonl`, `evaluation/frontend/held-out/react-horizontal.jsonl`, `.github/workflows/ci.yml`.

**Acceptance:** 工具链、任务图、i18n、a11y、storage 和监控事实可在知识页、Graph、搜索、影响与项目 MCP 中定位；held-out 指标按能力矩阵门槛单独统计，未支持 runtime 结论保持 partial。真实 React monorepo 完成“构建配置变更影响”“文案 key 追踪”“storage key 消费者”和“静态 a11y 引用”黄金流程。

**Commit:** `test: accept horizontal frontend knowledge`.

### FK29 V1.1 生产灰度

**Files:** Create `docs/releases/frontend-v1-1-production-evidence.md`; Modify `docs/operations/frontend-v1-1-rollout.md`.

**Preconditions:** FK28 经四角色通过；V1 当前生产稳定；V1.1 备份/恢复/回滚有当期证据；用户逐级授权。

**Rollout:** 管理员测试项目 → 一个真实 React monorepo 观察 24 小时 → 全部非关键适用项目观察 24 小时 → 用户再确认 → V1.1 analyzer manifest 对适用项目生效。回滚只撤销 V1.1 release/override，不影响已稳定的 V1 Core。

**Acceptance:** 生产验证 V1.1 Graph、知识页、搜索、影响、project/workspace MCP 双 Server、workspace Token 失效、当前项目排除和回滚；观察 48 小时并留存证据。

**Commit:** `release: activate approved horizontal frontend knowledge`.

## V2：Next.js 纵向支持

### FK30 Next.js App Router/RSC analyzer

**Files:** Create `fixtures/frontend/next-app-router/package.json`, `fixtures/frontend/next-app-router/app/layout.tsx`, `fixtures/frontend/next-app-router/app/page.tsx`, `fixtures/frontend/next-app-router/app/api/example/route.ts`, `evaluation/frontend/train/next-app-router.jsonl`, `evaluation/frontend/held-out/next-app-router.jsonl`, `src/server/knowledge/frontend/next-analyzer.ts`, `src/server/knowledge/frontend/next-analyzer.test.ts`; Modify `evaluation/frontend/versions.json`, `src/shared/frontend-ir.ts`, `src/server/knowledge/frontend/analyzer-registry.ts`.

**Version gate:** 在实现 analyzer 前先依据官方兼容合同和选定 fixture，将 Next/React/parser 的精确支持范围写入 `evaluation/frontend/versions.json` 并经技术经理批准；范围外项目只能返回 `partial/unknown(unsupported_version)`。

**Acceptance:** route groups、parallel/intercepting/dynamic route、layout/page/loading/error/not-found/route handler、`use client`、RSC boundary、server action、metadata、cache/revalidate 进入 IR/Graph；Pages Router 仅基础识别；动态 config 标记 partial。

**Commit:** `feat: model next app router knowledge`.

### FK31 Next 知识闭环、评测与灰度

**Files:** Modify `evaluation/frontend/train/next-app-router.jsonl`, `evaluation/frontend/held-out/next-app-router.jsonl`, `evaluation/frontend/versions.json`, `src/server/knowledge/frontend/knowledge-generator.ts`, `src/server/knowledge/frontend/change-impact.ts`, `src/client/pages/project-frontend-map-page.tsx`, `scripts/evaluate-frontend-knowledge.mjs`; Create `acceptance/next-frontend.acceptance.test.ts`, `docs/operations/frontend-v2-rollout.md`.

**Acceptance:** Next 真实项目完成导入、Graph、知识页、搜索、MCP、影响和 UI；框架分项指标达标；项目级 shadow/回滚通过后才可进入 FK32。

**Commit:** `test: accept next frontend vertical release`.

### FK32 Next.js 生产灰度

**Files:** Create `docs/releases/frontend-v2-production-evidence.md`; Modify `docs/operations/frontend-v2-rollout.md`.

**Preconditions:** FK31 经四角色通过；React/Vite 当前生产稳定；Next 备份/恢复/回滚有当期证据；用户对每一级单独授权。

**Rollout:** 管理员测试项目 → 一个真实 Next 项目观察 24 小时 → 全部非关键 Next 项目观察 24 小时 → 用户再确认 → Next 项目全 workspace。回滚触发器与 V1 相同，但只回滚 Next 项目 override/release channel。

**Acceptance:** 生产验证 Next 导入、RSC/route Graph、知识页、搜索、影响和回滚；完整运行 project/workspace MCP 双 Server 流程，验证 workspace Token 失效和当前 Next 项目排除。观察 48 小时并留存证据。

**Commit:** `release: activate approved next frontend projects`.

## V3：Vue 3/Nuxt 纵向支持

### FK33 Vue 3/Vite/Vue Router/Pinia analyzer

**Files:** Modify `package.json`, `package-lock.json`, `evaluation/frontend/versions.json`, `src/server/knowledge/pipeline/extract-vue.ts`, `src/server/knowledge/pipeline/extract-vue.test.ts`; Create `fixtures/frontend/vue-vite/package.json`, `fixtures/frontend/vue-vite/src/App.vue`, `fixtures/frontend/vue-vite/src/router.ts`, `evaluation/frontend/train/vue3.jsonl`, `evaluation/frontend/held-out/vue3.jsonl`, `src/server/knowledge/frontend/vue-analyzer.ts`, `src/server/knowledge/frontend/vue-analyzer.test.ts`.

**Dependency gate:** 先将 Vue/Vite/Router/Pinia 与 parser 的精确支持范围写入 `evaluation/frontend/versions.json` 并复审；直接声明与 `@vue/compiler-sfc` 同版本的 `@vue/compiler-dom`，不引入 Vue 管理端 runtime。

**Acceptance:** script/script setup/template/style 行号映射；props/emits/slots/expose、ref/reactive/computed/watch、provide/inject、composable、Pinia、组件/指令、scoped/CSS Modules、Vue Router route/guard/meta/lazy 进入 IR/Graph。

**Commit:** `feat: model vue frontend knowledge`.

### FK34 Nuxt analyzer

**Files:** Create `fixtures/frontend/nuxt/package.json`, `fixtures/frontend/nuxt/nuxt.config.ts`, `fixtures/frontend/nuxt/pages/index.vue`, `fixtures/frontend/nuxt/server/api/example.get.ts`, `evaluation/frontend/train/nuxt.jsonl`, `evaluation/frontend/held-out/nuxt.jsonl`, `src/server/knowledge/frontend/nuxt-analyzer.ts`, `src/server/knowledge/frontend/nuxt-analyzer.test.ts`; Modify `evaluation/frontend/versions.json`, `src/server/knowledge/frontend/vue-analyzer.ts`, `src/shared/frontend-ir.ts`.

**Version gate:** 先锁定 Nuxt/Vue/parser 的精确支持范围；不执行 Nuxt config，范围外语法保持 partial。

**Acceptance:** pages/layouts/middleware/plugins/composables/server routes、auto-import、runtime config、`useFetch/useAsyncData`、SSR/client boundary 和 route rules 进入 IR/Graph；不执行 Nuxt config；自定义动态 config 标记 partial。

**Commit:** `feat: model nuxt frontend knowledge`.

### FK35 Vue/Nuxt 知识闭环、评测与灰度

**Files:** Modify `evaluation/frontend/train/vue3.jsonl`, `evaluation/frontend/train/nuxt.jsonl`, `evaluation/frontend/held-out/vue3.jsonl`, `evaluation/frontend/held-out/nuxt.jsonl`, `evaluation/frontend/versions.json`, `src/server/knowledge/frontend/knowledge-generator.ts`, `src/server/knowledge/frontend/change-impact.ts`, `src/client/pages/project-frontend-map-page.tsx`, `scripts/evaluate-frontend-knowledge.mjs`; Create `acceptance/vue-nuxt-frontend.acceptance.test.ts`, `docs/operations/frontend-v3-rollout.md`.

**Acceptance:** Vue/Nuxt 真实项目完成与 React 相同的导入、Graph、知识页、搜索、MCP、影响和 UI 门槛；项目级 shadow/回滚通过后才可进入 FK36。

**Commit:** `test: accept vue nuxt vertical release`.

### FK36 Vue/Nuxt 生产灰度

**Files:** Create `docs/releases/frontend-v3-production-evidence.md`; Modify `docs/operations/frontend-v3-rollout.md`.

**Preconditions:** FK35 经四角色通过；Vue/Nuxt 备份、恢复和回滚有当期证据；用户对每一级单独授权。

**Rollout:** 管理员测试项目 → 一个真实 Vue/Nuxt 项目观察 24 小时 → 全部非关键 Vue/Nuxt 项目观察 24 小时 → 用户再确认 → Vue/Nuxt 项目全 workspace。回滚只影响该框架项目。

**Acceptance:** 生产验证 Vue SFC/Nuxt 导入、Graph、知识页、搜索、影响和回滚；完整运行 project/workspace MCP 双 Server 流程，验证 workspace Token 失效和当前 Vue/Nuxt 项目排除。观察 48 小时并留存证据。

**Commit:** `release: activate approved vue nuxt projects`.

## V4：扩展能力（不阻断 V1–V3）

### FK37 Tier 2 与高级 Web 适配器独立立项

**Files:** Create `docs/superpowers/specs/frontend-tier2-adapter-intake-template.md`, `docs/superpowers/plans/frontend-tier2-adapter-plan-template.md`; Modify `docs/product/frontend-capability-matrix.md`. FK37 本身不增加 parser 或生产依赖。

**Scope:** Angular、Svelte/SvelteKit、Astro；D3/Three.js/Canvas/WebGL；PWA/Service Worker/Web Worker；微前端/Module Federation；Web Components。React Native/Expo、Electron/Tauri、小程序继续为暂不支持，分别立项。

**Acceptance:** 先为每个框架生成独立设计与实施计划，冻结 `evaluation/frontend/versions.json` 中的版本范围和精确文件清单，并再次取得用户批准；随后每个能力独立通过官方 parser 依赖审批、fixture、IR、Graph、知识页、检索、影响、引用和 held-out 门槛，才可从“基础识别/暂不支持”改为“深度支持”。

**Commit:** `docs: plan approved tier two frontend adapters`.

## 公开合同汇总

- `FrontendIR schemaVersion: 2`：typed entity/edge union、stable ID、complete/partial、fact/candidate、analyzer provenance 和确定合并。
- 十阶段中 `knowledge-ir-v1`/`frontend-ir-v2` 与 Graph v1/v2 artifact family 并存。
- 项目级 frontend rollout override；环境变量只是允许上限。
- 持久分页 upload session、octet-stream file PUT、幂等 commit 和授权复用报告。
- workspace source blobs、同卷 snapshot hardlinks 与 `normalized-source-refs` convert artifact。
- REST 团队搜索固定拆分 `currentProjectFacts` 和 `priorProjectReferences`。
- project MCP 只返回当前项目事实并保持项目隔离；独立 user-bound workspace MCP 只提供授权历史项目参考，由 Codex 双 Server 流程组合，二者不伪装为同一响应。
- release 以不可变 `release_artifact_family=knowledge-v1|frontend-v2` 选择读取合同；历史 v1 不升级，frontend-v2 provenance 全有或全无，并保存当前 build 的 package stage run、其输出 `frontend-pipeline-package@2`、IR/Graph schema 和 analyzer manifest digest；run/artifact/release 的 workspace/repository/project/snapshot 必须一致，复用归属不依赖 artifact 的首次生产 build。

## 最终完成定义

当前端工程师在新项目中向 Codex 询问“实现一个 ECharts 下钻页面”时，系统必须同时返回：

1. 当前项目的 route/page/component/state/API/style/chart/test/tooling 约束。
2. 授权已发布历史项目的相似实现，每条有 project/release/citation。
3. 当前改动可能影响的页面、组件、API 和测试。
4. 明确分区“当前项目事实”、“历史项目参考”和“无法静态确定”，不得混合或伪装确定性。

达到这个状态时，产品仍是知识库，但已成为前端工程团队的可追溯知识基础设施，而不是一个文件全文搜索器。
