# Active 前端图谱正式发布设计

## 目标

将“知识图谱”从旧的 `knowledge-v1` 结构图切换为已发布 `frontend-v2` 包中的前端实体关系图。图谱只能读取通过引用校验并经人工发布的 active 包；候选或旧版本不能被伪装为正式前端关系图。

## 已确认事实

- 正式环境当前运行 `DEVKH_FRONTEND_KNOWLEDGE_MODE=shadow` 与 `DEVKH_SOURCE_STORAGE_MODE=shadow`。
- 当前项目的正式版本均为 `knowledge-v1`。最近图谱仅有 `main.ts → defaultCall` 的一条 `contains` 边。
- `frontend-v2` 已有图谱构建、包完整性校验和前端预览能力，但没有把已验证包创建为草稿并在知识图谱页读取的产品路径。

## 方案

### 1. 发布边界

新增前端发布草稿入口。服务端只从所选构建中查找已成功的 `frontend-pipeline-package`，使用既有 `createVerifiedFrontendReleaseDraft` 完成完整性、快照范围、阶段产物与引用校验。客户端只传递构建与版本意图，不能传入或伪造产物 ID。

发布操作复用现有版本发布机制。发布后的 release 必须标记为 `releaseArtifactFamily: "frontend-v2"`，并保留 `packageArtifactId`、`packageStageRunId`、图谱 schema 版本与分析器摘要。发布前失败不会改变当前正式版本。

部署时把前端知识内核与资料存储模式切换为 `active`。切换前后的版本并存：旧 `knowledge-v1` 版本仍可被历史链接读取，但不作为 active 前端图谱的数据源。

### 2. 正式图谱读取 API

扩展项目图谱读取，使其按 release 的 artifact family 分支：

- `frontend-v2`：从 release 的已验证 package 中读取 `frontend-graph-v2`，并复核 package、构建、项目、快照和图谱 schema 的一致性。
- `knowledge-v1`：保留现有读取和导出能力，返回明确的 legacy family 标记。

JSON 响应使用带 family 的联合类型，不混淆两种节点和关系模型。Mermaid、Markmap、树导出继续支持 legacy；frontend-v2 仅导出由事实边组成的关系图，候选边保持为屏幕上的虚线，不进入正式导出关系。

### 3. 图谱体验与布局

“知识图谱”页对 active release 显示前端实体：路由、页面、组件、状态、请求、可视化、测试、样式、入口和工作区包；显示事实边与候选边，均保留来源引用。

布局改为确定性的分层关系布局：

- 事实边决定层级，入度为零的实体为起点；循环和孤立实体有稳定的附加层。
- 同层按实体类型、名称和 ID 排序并纵向排布；边跨层连接，候选边为虚线。
- 画布保留“适合阅读”和“查看全图”、缩放、滚动、键盘选择和来源抽屉。

若当前正式 release 是 legacy，页面显示“尚未发布 active 前端图谱”的状态及前往知识生产/版本审核的下一步，不将模块归属关系称作前端图谱。

### 4. 失败与权限

- 只有管理员可创建 active 前端草稿或发布；成员与只读用户仅可阅读已发布图谱。
- 缺失、无效、跨项目、跨快照或未完成的 package 返回明确的不可发布状态，不自动回退到 shadow。
- active 构建失败时显示失败阶段和重试入口，旧的已发布 active 图谱继续可用。

## 测试与验收

- 服务端测试：只接受有效 frontend-v2 package 创建草稿；项目、快照、引用或阶段不匹配时拒绝；读取 API 按 release family 返回正确图谱。
- 客户端测试：legacy release 显示迁移状态；frontend release 显示关系节点、边、来源和候选样式；管理员能看到创建草稿操作。
- 布局测试：多分支前端关系图至少产生多个层和同层节点，不退化成按模块单行排列；排序稳定。
- 端到端：active 构建 → 创建 frontend-v2 草稿 → 发布 → 知识图谱查看真实关系。
- 发布验证：正式环境运行 active 模式；历史 legacy 发布版本及其链接保持可读。

## 不做的事

- 不自动发布候选包。
- 不将 shadow 预览作为正式图谱数据源。
- 不改动已有旧版本的底层知识数据。
