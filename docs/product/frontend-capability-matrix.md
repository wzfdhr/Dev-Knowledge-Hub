# 前端专业能力矩阵

> 本矩阵定义“支持”的可验收含义。“能上传”不等于“已支持”。

## 支持等级

- **深度支持**：有官方/成熟 parser、版本化实体和事实关系、知识页、Graph、检索、变更影响、精确引用、真实 fixture 和量化门禁。
- **基础识别**：可识别项目采用、主要配置/入口/符号和文件级引用，但不承诺完整运行时链路或影响分析。
- **仅资产索引**：只保存 path/hash/size/MIME 等不执行内容，支持被源码引用和资产影响。
- **暂不支持**：不宣称能力；仅在后续立项通过与上述相同门槛后改变。

## 正式矩阵

| 领域 | 当前基线 | 目标等级 | 核心实体/关系 | 知识产品面 | 上线版本 |
|---|---|---|---|---|---|
| TypeScript/JavaScript | 逐文件 AST；legacy 有部分 TypeChecker | 深度支持 | package、module、symbol、type、import/export/call | 架构、符号、调用链、影响 | V1 Core |
| JSX/TSX | 只将导出大写变量猜为 component | 深度支持 | component、props、render tree、children | 组件库、页面组成、使用热点 | V1 Core |
| HTML | 上传过滤 | 深度支持 | document、landmark、form、asset ref | 页面结构、资产、a11y 事实 | V1 Core |
| CSS/CSS Modules | 上传过滤 | 深度支持 | style scope、selector、custom property、media/container query | 样式来源、token、组件影响 | V1 Core |
| Sass/Less | 上传过滤 | 深度支持 | variable、mixin、selector、import/use | token、全局样式、影响 | V1 Core |
| SVG | 上传过滤 | 基础识别 | symbol/id/viewBox/asset ref；永不直接渲染 | 资产查询和引用影响 | V1 Core |
| 图片/字体/媒体 | 不采集 | 仅资产索引 | path、hash、size、MIME、referenced_by | 资产清单和影响 | V1 Trial |
| npm/pnpm/yarn/bun workspace | 部分 package/lock 文档事实 | 深度支持 | workspace package、exports、scripts、dependency | monorepo 地图、命令、包影响 | V1 Core |
| tsconfig/project references | legacy 只读根 tsconfig | 深度支持 | project、reference、paths alias、compiler boundary | 模块解析、包依赖、影响 | V1 Core |
| React 18/19 + Vite | 通用 JS/TS 识别 | 深度支持 | component、props、Hook、Context、render/effect | 页面、组件、状态、变更影响 | V1 Core |
| React Router | 无专用语义 | 深度支持 | route、layout、loader/action、guard、lazy | 路由树、页面链、路由影响 | V1 Core |
| Next.js App Router | 无专用语义 | 深度支持 | segment、layout/page、server/client boundary、action、cache | SSR/CSR 边界、路由、数据链 | V2 |
| Next.js Pages Router | 无专用语义 | 基础识别 | page、API route、data hook | 兼容路由和入口清单 | V2 |
| Vue 3 + Vite | pipeline 有 SFC 解析，但 `.vue` 默认上传被过滤 | 深度支持 | component、props/emits/slots、composable、template render | 页面、组件、响应式状态、影响 | V3 |
| Vue Router | 无专用语义 | 深度支持 | route、guard、meta、lazy、nested view | 路由树、权限与页面链 | V3 |
| Nuxt 3/4 | 无专用语义 | 深度支持 | pages/layouts/middleware/plugins/composables/server route | SSR/CSR、路由、数据链 | V3 |
| Angular | 无 | 深度支持 | component、template、input/output、DI、signal、route | 页面、组件、状态、影响 | V4 |
| Svelte/SvelteKit | `.svelte` 上传过滤 | 深度支持 | component、prop、reactive state、route、load/action | 页面、组件、数据链、影响 | V4 |
| Astro | `.astro` 上传过滤 | 深度支持 | page、component、island、content collection、route | island boundary、页面、内容链 | V4 |
| Redux Toolkit | 只有通用调用符号 | 深度支持 | store、slice、action、selector、read/write | 状态流、页面消费者、影响 | V1 Trial |
| Zustand/Context | 只有通用调用符号 | 深度支持 | store/provider、field、selector、consumer | 状态流、使用热点、影响 | V1 Core |
| Pinia/Vue provide-inject | 无专用语义 | 深度支持 | store、state/getter/action、provider/consumer | 状态流、页面消费者 | V3 |
| TanStack Query | 只有通用调用符号 | 深度支持 | query/mutation、key、fetcher、consumer、invalidate | 数据链、缓存与变更影响 | V1 Trial |
| fetch/axios | 只有通用 call edge | 深度支持 | operation、method、URL template、schema、consumer | 页面到 API 追踪、错误处理 | V1 Core |
| OpenAPI/GraphQL | 文件级文档事实 | 深度支持 | operation、schema、query/mutation/fragment、generated client link | API 目录、类型影响、消费者 | V1 Trial |
| WebSocket/SSE | 只有通用 call edge | 基础识别 | channel/event、subscriber、cleanup | 实时链路和资源清理提示 | V1 Core |
| 表单与校验 | 无专用语义 | 深度支持 | form、field、schema、validator、submit operation | 表单地图、字段/API/校验链 | V1 Trial |
| 权限守卫 | 无专用语义 | 深度支持 | guard、role/permission key、protected route/component | 权限地图、受影响页面 | V1 Trial |
| Feature Flag | 无专用语义 | 基础识别 | flag key、definition、consumer、fallback | flag 使用清单与变更影响 | V1 Core |
| ECharts | 无专用语义 | 深度支持 | chart、dataset、series、axis、event、option builder | 图表地图、过往实现、数据源 | V1 Core |
| D3 | 无专用语义 | 基础识别 | selection、scale、axis、layout、data binding | 可视化清单和数据链 | V4 |
| Three.js/Canvas/WebGL | 无专用语义 | 基础识别 | scene、camera、renderer、control、animation loop | 3D/画布资源与生命周期 | V4 |
| Storybook | 无专用语义 | 深度支持 | story、meta、args、decorator、component | 组件示例、状态和覆盖缺口 | V1 Trial |
| 设计令牌/组件库封装 | 无专用语义 | 深度支持 | token、theme、primitive、wrapper、consumer | 设计系统地图和样式影响 | V1 Trial |
| Tailwind/UnoCSS | 文本与 config 可上传 | 基础识别 | utility usage、theme token、preset/plugin | 工具采用、token 和使用热点 | V1 Core |
| CSS-in-JS | 只有通用 call edge | 基础识别 | styled component、theme token、style consumer | 组件样式来源与影响 | V1 Core |
| Vitest/Jest/Testing Library | 部分 test-of/import 关系 | 深度支持 | suite、case、fixture、render target、mock | 测试地图、影响建议、覆盖缺口 | V1 Core |
| Playwright/Cypress | 配置键和通用符号 | 深度支持 | scenario、route/page、locator、fixture、network mock | 黄金流程、变更相关 E2E | V1 Core |
| Vite | 配置文件通用 AST | 深度支持 | entry、alias、plugin、chunk、env、dev proxy | 构建地图、别名解析、配置影响 | V1 Core |
| Webpack/Rspack/Rollup | 配置文件通用 AST | 深度支持 | entry、alias、plugin、chunk、env、dev server | 构建地图、代码分割与影响 | V1.1 |
| Babel/SWC/esbuild | 无专用语义 | 基础识别 | transform target、plugin/preset、loader | 编译链和配置清单 | V1 Core |
| Nx/Turborepo | 只有 config 文档事实 | 深度支持 | task、target、dependency、cache input/output | 任务图、包影响、运行建议 | V1.1 |
| i18n | 无专用语义 | 深度支持 | locale key、definition、consumer、missing key | 文案来源、遗漏与影响 | V1.1 |
| 可访问性 | 无专项 | 深度支持（静态） | landmark、name/role/state、label/alt、keyboard candidate | 静态诊断、引用、修复入口 | V1.1 |
| Web Vitals/性能监测 | 无专项 | 基础识别 | metric、reporter、boundary、lazy/chunk config | 采集点、性能模式和静态风险 | V1.1 |
| 错误监控 | 无专项 | 基础识别 | error boundary、capture/report call、source-map config | 错误处理地图和遗漏候选 | V1.1 |
| Browser Storage | 只有通用 call edge | 深度支持 | local/session storage、IndexedDB、cookie key、reader/writer | 本地状态、隐私/变更影响 | V1.1 |
| Web Worker/Service Worker/PWA | 只有通用 import/call | 基础识别 | worker entry、message、cache strategy、manifest | 离线/后台链、资源和更新风险 | V4 |
| 微前端/Module Federation | 无 | 基础识别 | host/remote、expose/shared、mount contract | 应用边界、运行时依赖、影响 | V4 |
| Web Components | 无专项 | 基础识别 | custom element、attribute/property、event、slot | 组件合同和消费者 | V4 |
| React Native/Expo | 无 | 暂不支持 | - | 需独立移动端语义立项 | 后续 |
| Electron/Tauri | 无 | 暂不支持 | - | 需独立桌面进程/权限语义立项 | 后续 |
| 微信/多端小程序 | 无 | 暂不支持 | - | 需独立平台语义与 fixture 立项 | 后续 |

上表的“目标等级”是交付目标，不是当前已上线状态。管理端和 MCP 只能根据当前 release 持久化的 analyzer manifest 与已通过评测门禁显示“深度支持”；不得根据本目标矩阵提前宣称能力。

2026-07-19 产品决策：V1 Demo 的 FK06 只接入经客户端和服务端共同验证的前端文本与 SVG。图片、字体和媒体继续在读取内容前过滤；其 `client_unverified` 资产清单随 FK14 的分页 manifest 上传合同在 V1 Trial 交付，避免在缺少持久化信任字段时伪造 source file。

## 版本范围治理

- `evaluation/frontend/versions.json` 是机器可执行的版本事实源，记录每项能力的框架 semver、工具链 semver、parser 精确版本、代表 fixture 和已知不支持项。
- V1 首先冻结当前仓库锁定的 React/Vite/TypeScript 组合，并加入一个经批准的 React 18 兼容 fixture；这不是对所有历史版本的笼统承诺。
- Next、Vue、Nuxt 和 Tier 2 在各自任务启动前分别冻结范围。版本合同、fixture 与 parser 依赖必须在 analyzer 代码之前通过技术经理复审。
- release 的 analyzer manifest 固化实际范围。范围外语法显示 `partial/unknown(unsupported_version)`；只有新增 fixture、held-out 评测和回滚证据通过后才能扩大范围。

## 横向完成规则

每个标记为“深度支持”的项目必须同时通过：

1. 实体抽取 F1 >= 0.92。
2. 事实关系 precision >= 0.95。
3. 引用有效率 = 100%。
4. 至少一个最小 fixture 和一个真实代表项目。
5. 实体可在知识页、Graph、检索与变更影响中定位。
6. 未发布和未授权项目零泄漏。

“基础识别”必须有 parser/config 证据和精确引用，不能依赖文本共现猜测。任何运行时无法确定的值都必须显示为 partial/unknown。

## V1 Core 评测合同

机器可执行的版本事实源为 `evaluation/frontend/versions.json`，用例分为不可混用的 `train` 与 `held-out` JSONL。FK01 只建立协议基线，不宣称 analyzer 已达到质量门槛；报告必须显示 `protocol-baseline-no-analyzer`，FK22 才启用生产质量阈值。

V1 Core 的 15 个稳定 capability id 为：

`typescript-javascript`、`jsx-tsx`、`html`、`css-modules`、`sass-less`、`workspace`、`tsconfig`、`react`、`react-router`、`zustand-context`、`fetch-axios`、`echarts`、`unit-component-testing`、`e2e-testing`、`vite`。

每项至少包含 12 条 train 和 8 条 held-out；整体中文不少于 40%，无权限、未发布或无结果负例不少于 15%。评测输出实体 micro/macro F1、事实边 precision/recall、Recall@5、MRR、citation validity、空结果误命中、影响 precision/recall 和未授权/未发布泄漏数。版本范围、fixture 或 parser 版本变化必须单独复审。
