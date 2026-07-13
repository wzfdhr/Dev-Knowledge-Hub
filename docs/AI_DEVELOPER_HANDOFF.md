# Dev Knowledge Hub 开发 AI 接力文档

> 更新时间：2026-07-13  
> 代码基线：`01f261649b3ddd0202f5e0c86aaed1e15de3f80b`  
> 目标读者：接手继续开发、部署或评审本项目的 AI / 工程师

## 1. 先读这里

这是一个面向开发团队的在线知识库：把项目源码安全导入服务器，生成带文件路径、行号和版本引用的知识，再通过 MCP 提供给 Codex 等编码 Agent。

当前代码已经不是演示落地页，而是一套可运行的 MVP 工作台，主流程是：

1. 创建团队项目。
2. 选择未经人工清理的本地项目文件夹。
3. 浏览器先过滤依赖、构建产物、敏感文件和无关文件。
4. 将过滤后的内容压缩并分块续传到服务器。
5. 服务端再次执行 ZIP 安全校验和文件过滤，创建不可变源码快照。
6. 人工发起知识构建、审核草稿并发布。
7. 为项目创建 MCP Token，将生成的 `.codex/config.toml` 和 `AGENTS.md` 接入 Codex。
8. Codex 在开发任务开始前查询该项目的已发布知识，并返回可验证引用。

## 2. 仓库身份与绝对约束

- 本地仓库：`/Users/start/Desktop/知识库系统/dev-knowledge-hub`
- GitHub：`git@github.com:wzfdhr/Dev-Knowledge-Hub.git`
- 当前分支：`main`
- 项目当前为 Private、`UNLICENSED`，以后是否公开另行决定。
- 这是全新独立 Git 历史，不是参考项目的 fork。
- `WangHNoob/knowledge-hub` 只能作为概念参考，禁止修改、推送、复用其 `origin`、源码、提交历史和品牌素材。
- 任何 Git 操作前都应执行：

```bash
git rev-parse --show-toplevel
git remote -v
git status --short
```

若远程地址指向参考项目，立即停止。

## 3. 当前产品定位

### 当前用户

- 主要面向 2 至 10 人的 TypeScript / JavaScript 团队。
- 当前是单 workspace、多项目、单组织形态。
- 角色为 `admin / member / reader`。

### 当前价值

- 把散落在源码里的架构、模块、符号、依赖、命令和约定整理成可查询知识。
- 所有重要结论都尽量保留 `path + startLine + endLine + commitSha + blobHash`。
- 旧发布不可变；新构建失败不会影响 Codex 当前读取的版本。
- Codex Token 绑定项目，不能跨项目查询。
- MCP 只读取已发布知识；只有 `dkh_report_gap` 可以写入反馈。

## 4. 已经实现的能力

### 4.1 团队与项目

- 首次启动创建管理员、默认 workspace 和默认项目。
- 多项目项目中心，每个项目拥有独立的当前资料来源、快照、构建、发布和 MCP Token。
- 工作区成员管理，支持管理员、成员、只读三种角色。
- 服务端权限边界：
  - 管理员：项目、成员、发布、Token、模型设置。
  - 成员：上传、构建、反馈处理。
  - 只读：查看项目、已发布知识、来源和项目活动。
- 项目协作页展示真实 workspace 成员和项目隔离的审计活动。

注意：成员角色目前是 **workspace 级角色**，还没有 `project_members` 或项目级角色分配表。协作页因此使用“团队角色”文案，不能误称已实现项目级成员权限。

### 4.2 资料来源

当前支持：

- 浏览器选择完整项目文件夹，推荐方式。
- 直接上传 ZIP。
- HTTPS Git URL，可选 PAT。
- 服务器自身可访问的本地 Git 绝对路径。
- 安全更换资料来源，旧来源及其快照/发布保留为只读归档。

上传限制：

- 过滤后压缩包最大 500 MiB。
- 最多 50,000 个条目。
- 解压后最大 2 GiB。
- 单个可采集文本文件最大 1 MiB。
- 分块最大 16 MiB，客户端默认使用固定分块续传。

浏览器过滤和服务端过滤使用相同规则思想，但服务端始终是最终安全边界。当前接受的重点文件包括 TS、TSX、JS、JSX、Markdown、JSON、YAML、`package.json`、锁文件、tsconfig 和常见测试配置。

自动忽略：

- `.git`、`node_modules`、`dist`、`build`、`coverage`、`.next`
- `.env` 等敏感文件
- 二进制或无效 UTF-8
- 生成文件
- 不支持的扩展名
- 超过 1 MiB 的源码文本

上传流程有六个固定阶段：读取文件、安全过滤、本地压缩、分块上传、服务端校验、创建内容版本。界面展示进度、速度、预计剩余时间、暂停、继续和取消。

### 4.3 不可变快照与知识构建

- Git 来源固定到 commit SHA，并拒绝脏的服务器本地工作区。
- 上传来源根据规范化文件清单和内容生成 40 位内容版本哈希。
- 为兼容 citation 和 MCP envelope，数据库 `commitSha` 字段在上传来源中承载该 40 位内容版本哈希；UI 应显示“内容版本”，不要显示“Git Commit”。
- 相同 commit / 内容哈希同步为无操作。
- 快照文件只读并保存内容哈希。
- 构建状态：`queued -> syncing -> parsing -> synthesizing -> validating -> ready -> published`，异常进入 `failed`。
- 发布指针原子切换；草稿和失败构建不会改变 current release。
- 反馈重建不会自动发布。

### 4.4 知识解析与检索

已实现：

- TypeScript Compiler API 解析 TS、TSX、JS、JSX。
- 提取模块、函数、类、接口、类型、变量、imports、exports、calls、测试关系和 package scripts。
- 解析 Markdown、JSON、YAML、package、tsconfig 和常见测试配置。
- 生成架构、模块、符号、命令、约定、测试和引用知识页。
- PostgreSQL 英文 FTS、中文 `ILIKE`、`pg_trgm`、精确符号/路径匹配和依赖图邻居混合排序。
- 可选 OpenAI-compatible / Anthropic BYOK 增强器；增强结果不满足中文和事实保留约束时回退确定性内容。

尚未实现：`pgvector`、`bge-m3`、向量语义检索、正式检索评估仪表盘。当前代码中没有向量扩展或 embedding 数据表。

### 4.5 MCP 与 Codex

固定提供八个工具：

- `dkh_search`
- `dkh_get_architecture`
- `dkh_get_module`
- `dkh_get_symbol`
- `dkh_get_change_context`
- `dkh_get_source`
- `dkh_get_release`
- `dkh_report_gap`

统一返回 envelope：

```ts
{
  releaseId: string;
  commitSha: string;
  result: unknown;
  citations: Array<{
    path: string;
    startLine: number;
    endLine: number;
    commitSha: string;
    blobHash: string;
  }>;
}
```

项目 Codex 页会生成：

- 项目专用 MCP endpoint 信息。
- `.codex/config.toml` 模板。
- `AGENTS.md` 模板。
- 环境变量名称与检查命令。
- 仅展示一次明文的项目 Token。

Codex 行为约束是“代码修改、排错、评审、规划和测试设计前优先查 devkh”，不是对所有聊天消息强制拦截。

### 4.6 当前界面

技术：React 19、Ant Design 5、React Router 7、TanStack Query、Lucide。

全局入口：

- 项目中心
- 知识库
- 反馈
- 成员
- 设置

项目工作台入口：

- 项目概览
- 资料上传
- 知识版本
- 团队协作
- Codex 接入

视觉方向是紧凑研发工作台：深色侧栏、浅灰内容区、白色信息面、蓝色操作色、细边框和低圆角。已修复 Ant Menu 与旧 `a.active` 样式叠加导致的双重选中态。已验证 1440、390 和 320 宽度无横向溢出。

## 5. 技术架构

### 栈

- Node.js 22.13+
- TypeScript 6
- Fastify 5
- React 19 + Vite 8
- Ant Design 5
- PostgreSQL 16
- Drizzle migrations
- pg-boss
- MCP SDK
- AI SDK
- Vitest + Testing Library + Playwright
- Docker Compose + Caddy

### 主要边界

- `src/client/pages/`：页面。
- `src/client/components/`：工作台、上传进度、报告、活动等组件。
- `src/client/api/`：HTTP 客户端、文件夹过滤/打包、续传控制。
- `src/server/app.ts`：认证、REST、SSE 和 MCP HTTP 路由。
- `src/server/persistence/store.ts`：领域持久化接口。
- `src/server/persistence/memory-store.ts`：单元测试/E2E 内存实现。
- `src/server/persistence/postgres-store.ts`：生产 PostgreSQL 实现。
- `src/server/uploads/`：续传会话和 ZIP 安全导入。
- `src/server/git/`：Git mirror、脏工作区检查、不可变快照。
- `src/server/knowledge/`：解析、生成、构建生命周期、检索。
- `src/server/mcp/`：Token 认证和八个工具。
- `src/server/codex/`：Codex 接入包。
- `src/server/security/`：Argon2、JWT/session、AES-256-GCM、HTTP 安全。
- `drizzle/`：0001 至 0011 迁移。

### 核心数据实体

- `workspaces`
- `admin_users`
- `workspace_members`
- `projects`
- `repositories`
- `encrypted_credentials`
- `source_snapshots`
- `source_files`
- `code_symbols`
- `code_edges`
- `build_jobs`
- `knowledge_pages`
- `knowledge_chunks`
- `releases`
- `release_channels`
- `mcp_tokens`
- `agent_feedback`
- `audit_events`

每张关键表都保留 `workspace_id`；仓库和 Token 已关联 `project_id`。

## 6. 安全不变量

- 密码使用 Argon2，不保存明文。
- Web 使用 HttpOnly、安全会话 Cookie。
- Git PAT 和模型 API Key 使用 `DEVKH_MASTER_KEY` 做 AES-256-GCM 加密。
- MCP Token 明文只显示一次，数据库只存哈希，可撤销。
- API 不回传 PAT、模型 Key、密码或 Token 明文。
- HTTPS Git URL 禁止内嵌用户名/密码。
- ZIP 拒绝绝对路径、路径穿越、反斜杠路径、符号链接、密码包、重复/冲突条目和压缩炸弹。
- 原始 ZIP 导入后删除，只长期保留过滤后的不可变源码和文档。
- PostgreSQL 不应暴露公网；生产只开放 Caddy 80/443。
- 不要把 `.env`、数据库转储、SSH 私钥、服务器地址、Token 或生成密钥写入仓库、聊天或此文档。

## 7. 本地运行

生产式本地启动需要 PostgreSQL 和环境变量：

```bash
cp .env.example .env
npm ci
npm run db:migrate
npm run dev
```

必需变量：

- `DATABASE_URL`
- `DEVKH_MASTER_KEY`
- `DEVKH_SESSION_SECRET`

只做临时界面/E2E 预览时：

```bash
npm run dev:e2e-server
npm run dev:web -- --port 5173
```

- Web：`http://127.0.0.1:5173`
- API：`http://127.0.0.1:3000`
- E2E server 使用内存数据，进程停止后数据消失，不代表线上持久化。

## 8. 生产部署

仓库已有：

- `Dockerfile`
- `docker-compose.yml`
- `deployment/Caddyfile`
- PostgreSQL 16
- Caddy 自动 HTTPS
- PostgreSQL、快照、Git mirrors、上传暂存独立命名卷
- 只读应用根文件系统和受限 `/tmp`

生产部署前必须重新确认：

1. 域名 DNS 已指向服务器。
2. 80/443 已放行，3000/5432 未暴露。
3. `.env` 权限为 600，所有 secret 在服务器生成。
4. 先备份数据库和不可变快照，再运行 0011 迁移和新镜像。
5. 验证登录、文件夹上传、构建、发布、项目 Token、MCP 和容器重启后数据保留。

不要假设服务器当前运行的镜像已经包含本文档对应 commit；部署前比较线上 commit / image 与 `01f2616`。

## 9. 测试与最近验证

常用命令：

```bash
npm run typecheck
npm run lint -- --quiet
npm test
npm run build
npm run acceptance
npm run test:e2e
npm run secrets:scan
npm run licenses:check
npm run delivery:verify
```

2026-07-13 最近一次结果：

- Typecheck：通过。
- ESLint：通过。
- Vitest：290 通过，3 跳过，1 个 PostgreSQL 集成文件因本机没有 Docker/测试数据库而跳过。
- Production build：通过；当前单个前端主 chunk 较大，Vite 有大于 500 kB 警告。
- Playwright：1 条完整主流程通过。
- Acceptance：通过。
- Secret scan：通过。
- License policy：通过。
- Delivery static verification：通过。
- PostgreSQL Compose integration：本机未执行，需在 CI 或 Docker 可用环境运行。

E2E 已覆盖：

- 首次设置与登录。
- 进入默认项目。
- 选择包含源码、测试、README、`node_modules`、`.env` 的原始文件夹。
- 确认本地过滤报告只上传 3 个文件并忽略依赖和敏感文件。
- 分块上传、创建内容版本、知识构建、草稿审核、引用源码、手动发布。
- 创建项目 Codex Token。
- 项目活动流出现真实 Token/上传事件。
- 反馈确认和重新构建不改变当前发布。
- 桌面/移动布局、侧栏单层选中态、React 控制台 key 警告和横向溢出。

## 10. 已知未完成项

以下内容曾出现在商业化路线中，但目前没有完整实现：

1. 项目级成员关系、邀请邮件、成员移除和项目角色管理。
2. 真正跨项目的全局知识检索；当前全局知识页面仍依赖客户端选中的活动项目。
3. 持久化导入历史、导入人、耗时、存储占用和项目知识覆盖率。
4. pgvector、bge-m3、本地 embedding 服务和语义向量召回。
5. 系统化检索评估集、NDCG/Recall 等指标和质量看板。
6. 更完整的增量重建；目前已有不可变版本和去重边界，但不要假设所有构建都做到文件级最小重算。
7. GitHub App、Webhook 和自动同步。
8. 阿里云 OSS、大于 500 MiB 的上传通道和 5 GiB 支持。
9. 病毒扫描、配额、存储生命周期、失败上传定时清理和磁盘告警 UI。
10. 多租户 SaaS、组织隔离、计费、订阅和商业后台。
11. 模型连通性测试、成本统计、调用配额和供应商故障策略。
12. 前端路由级代码分割；当前 production bundle 有大 chunk 警告。

## 11. 建议的下一阶段优先级

### P0：先确保线上可持续运行

- 将最新 `main` 部署到测试环境，验证 0011 数据迁移。
- 增加每日加密异机备份和恢复演练。
- 增加磁盘容量、上传暂存、失败构建和容器健康告警。
- 增加过期续传会话与孤立暂存文件清理任务。
- 在真实 PostgreSQL / Docker 环境跑完整 integration 和 E2E。

### P1：补齐团队产品闭环

- 新建 `project_members`，实现项目级角色与 Token 用户归属。
- 建立持久化 `imports` / `import_reports`，展示导入历史、耗时和过滤详情。
- 实现真正跨项目的团队知识搜索，并强制项目权限过滤。
- 在项目中心补存储占用、反馈数、覆盖率和失败状态。

### P2：提升知识算法

- 先建立固定检索评估集，再引入 pgvector 和 bge-m3。
- 使用精确符号/路径、依赖图、中文词法、向量相似度做加权融合。
- 记录每次命中的召回通道和排序原因。
- 做文件/符号/知识块级增量重建和变更影响传播。
- 对 AI 摘要持续执行标识符、命令、引用和中文约束验证。

### P3：商业化基础设施

- GitHub App + Webhook。
- OSS 分片直传和大文件通道。
- 配额、审计保留、组织、多租户、计费和订阅。
- 开源前再做许可证、来源、密钥、隐私和品牌审计。

## 12. 下一个 AI 的工作规则

1. 先读：`README.md`、`docs/architecture.md`、`docs/api.md`、`docs/security.md`、本文档。
2. 再读与任务相关的 `docs/superpowers/specs/` 和 `docs/superpowers/plans/`，注意其中可能包含尚未完成的目标，不可当作现状。
3. 修改前检查 Git 根目录、远程和 dirty worktree。
4. 不读取或修改参考项目源码，不复制其实现。
5. 不撤销用户或其他 AI 已存在的无关改动。
6. 新功能和 bugfix 先写失败测试，再实现最小修复。
7. 数据必须按 `workspace_id` 和 `project_id` 隔离，不能只在 UI 层过滤。
8. 所有知识输出继续保留版本、文件路径、行号和 blob hash。
9. 客户端过滤只负责隐私和体验；服务端验证不能删除。
10. 不自动发布知识，不让失败构建改变 current release。
11. 不在日志、错误、API 或提交中暴露凭据。
12. 完成前至少运行 typecheck、lint、相关单测、全量测试、build 和 E2E；涉及数据库必须跑 PostgreSQL integration。
13. 推送前确认 remote 仍为 `wzfdhr/Dev-Knowledge-Hub`。

## 13. 快速接手检查清单

```bash
cd "/Users/start/Desktop/知识库系统/dev-knowledge-hub"
git status --short
git remote -v
git log --oneline -10
npm ci
npm run typecheck
npm test
```

然后根据任务选择入口：

- 上传：`src/client/pages/project-imports-page.tsx`、`src/client/api/folder-import.ts`、`src/client/api/resumable-upload.ts`、`src/server/uploads/`
- 项目/权限：`drizzle/0011_team_projects_and_roles.sql`、`src/server/team-routes.test.ts`、`src/server/persistence/`
- 知识算法：`src/server/knowledge/intelligence.ts`、`generator.ts`、`postgres-store.ts`
- MCP/Codex：`src/server/mcp/`、`src/server/codex/`、`src/client/pages/project-codex-page.tsx`
- UI：`src/client/pages/`、`src/client/components/`、`src/client/workbench.css`、`src/client/styles.css`
- 部署：`Dockerfile`、`docker-compose.yml`、`deployment/Caddyfile`、`src/server/bootstrap.ts`

这份文档描述的是当前实现边界。任何接手者都应以代码、迁移和测试结果为最终事实来源。
