# 知识库内核、安全与 Vue 现代化 Implementation Plan

> **For agentic workers:** 每个任务只能在上一任务的“阶段门禁”全部通过后开始。每次提交前执行该任务列出的命令，并将“产品经理视角自审”“开发经理视角自审”、命令输出摘要、commit SHA、PR URL 写入 PR 描述的 `Evidence` 小节。前者验证用户价值、流程完整性、权限可见性、空状态和发布风险；后者验证类型、事务、安全、测试、回滚和可观测性。两项均由执行代理基于实际 diff 自审并留存，不代表或伪造外部人员审批。

**Goal:** 在不改变私有单工作区产品边界的前提下，建立可验证的知识流水线、安全会话、Graph、检索质量、Vue 3.5 管理端与可回退生产发布机制。

**Architecture:** Fastify、PostgreSQL 和 pg-boss 保持模块化单体；以 content-addressed `knowledge_artifacts` 和 `build_stage_runs` 驱动十阶段流水线。Vue 3.5.13 与 React 并行，通过共享 Zod DTO、REST、SSE、Cookie 和 feature flag 切换。没有外部 UI 库。

**Tech Stack:** Node.js 22、TypeScript、Fastify 5、PostgreSQL 16、pg-boss、Drizzle SQL、React 19、Vue 3.5.13、Vite、Vitest、Playwright。

## 全局门禁

1. 执行任务前运行 `git status --short`，不得覆盖非本任务改动。
2. 每个任务先新增失败测试并运行，确认失败原因符合预期；再做最小实现，重复运行通过；不得先写实现再补测试。
3. 每个任务提交只能包含其 Files 列表、必要的 lockfile 与测试夹具；格式化产生的无关改动需拆分。
4. 每阶段结束必须运行：

```bash
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:e2e
npm run secrets:scan
npm run licenses:check
```

预期：全部退出码 `0`，通过测试数不少于 320。`test:integration` 在 Docker PostgreSQL profile 运行，`test:e2e` 覆盖 1440px 和 390px。Task 1 创建缺失的 `secrets:scan` script 前，阶段 0 使用 `node scripts/secrets-scan.mjs`。

5. 阶段门禁失败时，执行该任务的 Rollback，不得进入下一阶段。数据库任务的 rollback 只允许停用 feature flag、恢复数据库/文件备份或新增 forward migration；禁止对生产执行 `down` SQL。

## 阶段 0：基线、凭证与评测

### Task 1: 建立 MCP Token 原子轮换与代码基线

**依赖：** 无。
**Files：** Modify `src/server/app.ts`, `src/server/app.test.ts`, `src/server/persistence/store.ts`, `src/server/persistence/memory-store.ts`, `src/server/persistence/memory-store.test.ts`, `src/server/persistence/postgres-store.ts`, `src/server/persistence/postgres-store.test.ts`, `src/client/api/client.ts`, `src/client/api/client.test.ts`, `src/client/pages/project-codex-page.tsx`, `src/client/app.test.tsx`, `docs/operations/token-rotation.md`.
**输入：** 已有项目级 `McpTokenRecord`、`mcp_tokens` 审计和项目 admin 授权。
**输出：** `POST /api/mcp/tokens/:id/rotate`，原子返回旧 Token 的已撤销记录与新 Token 的一次性明文。

**TDD：**
1. 写失败测试：项目 admin 轮换后旧 MCP Token 认证失败、新 Token 可认证；project member/reader 与跨项目 token 返回 `403 PROJECT_ACCESS_DENIED`；创建失败时旧 Token 仍有效；审计 action 为 `mcp_token.rotated` 且没有明文。
2. 运行 `npm test -- src/server/app.test.ts src/server/persistence/memory-store.test.ts src/client/app.test.tsx`，预期缺少 route/控件而失败。
3. 最小实现：生成 replacement plaintext，在单事务中插入同项目同名称的新 Token、撤销旧 Token、写 `mcp_token.rotated` 审计；UI 在当前项目 Token 行展示轮换按钮，并用已有一次性密文弹窗显示 replacement。
4. 再次运行同一命令，预期通过。

**命令：** red 阶段执行 `npm test -- src/server/app.test.ts src/server/persistence/memory-store.test.ts src/client/app.test.tsx`，预期路由/控件断言失败；green 阶段重复并执行 `npm run typecheck`，预期退出码 `0`。

```ts
const result = await api.rotateMcpToken("old-token-id");
expect(result.previous.revokedAt).toEqual(expect.any(String));
expect(result.token).toMatch(/^dkh_/);
```

**验收：** 轮换只允许当前项目 admin；旧 Token 只在 replacement 已写入后撤销；日志、审计 metadata 和列表不输出明文；`scripts/secrets-scan.mjs` 继续通过。
**Rollback：** 隐藏轮换 UI 并禁用 route；已撤销 Token 不恢复，管理员用创建 Token 流程生成新的替代 Token。
**提交：** `feat: add atomic mcp token rotation`。

### Task 2: 收口工作区/项目基线与活动审计查询

**依赖：** Task 1。
**Files：** Modify `src/server/team-routes.test.ts`, `src/server/app.ts`.
**输入：** `project_members`、`audit_events`。
**输出：** 项目范围活动审计查询 `GET /api/projects/:projectId/activity?limit=&offset=`，并在 API 出口按 allowlist 返回 metadata。

**TDD：** 写两个项目、三个角色的失败矩阵：reader 只读授权项目；member 不能管理成员；project admin 能读活动；workspace admin 能读所有本工作区项目；跨项目 `403 PROJECT_ACCESS_DENIED`；手工写入的 `token`、`password` 等非 allowlist metadata 不能从 API 返回。运行 `npm test -- src/server/team-routes.test.ts`，在现有 `requireProjectRole` 与 offset 分页合同上补 API 出口过滤后重跑。

**命令：** red 阶段执行 `npm test -- src/server/team-routes.test.ts`，预期项目活动 route 或 metadata allowlist 断言失败；green 阶段重复并执行 `npm run typecheck`，预期退出码 `0`。

```ts
server.get("/api/projects/:projectId/activity", { preHandler: requireAdmin }, listProjectActivity);
```

**验收：** 审计行带 actor、action、resource、metadata allowlist、时间，不含 Token/PAT；活动页面同样不泄露。
**Rollback：** 移除 UI route，保留审计写入；不删除现有审计。
**提交：** `feat: expose project-scoped audit baseline`。

### Task 3: 固定 Vue 3.5 发布基线与共享设计令牌

**依赖：** Task 1。
**Files：** Modify `package.json`, `package-lock.json`, `vite.config.ts`, `src/server/app.ts`, `src/server/app.test.ts`, `vite.config.test.ts`, `Dockerfile`; Create `console-vue/index.html`, `src/client-vue/main.ts`, `src/client-vue/styles/tokens.css`, `src/client-vue/app.test.ts`, `docs/operations/vue-baseline.md`.
**输入：** Vite build、现有 CSP nonce。
**输出：** `vue@3.5.13`、`@vitejs/plugin-vue@6.0.8`、Vue 空 shell 与 CSS token。

**TDD：** 先写 `vite.config.test.ts` 断言 Vue entry 不替换 React entry、CSP nonce 可传入 style injection；运行失败。最小加入依赖和 `/console-vue/health` 页面，锁定 lockfile，重跑 `npm run build` 与 `npm test -- src/client-vue/app.test.ts vite.config.test.ts`。

**命令：** red 阶段执行 `npm test -- src/client-vue/app.test.ts vite.config.test.ts`，预期 Vue entry 或 nonce 断言失败；green 阶段执行 `npm run build && npm test -- src/client-vue/app.test.ts vite.config.test.ts`，预期退出码 `0`。

```ts
export const tokens = { colorAccent: "#1677ff", radius: "6px", focusRing: "0 0 0 3px #91caff" } as const;
```

**验收：** Vue 迁移不出现 `aheart-ui`、Ant Design Vue、Element Plus 或其他 UI component package；Vue/React 可同时构建；页面响应 CSP nonce。现有 React 依赖不在此任务修改范围内。
**Rollback：** 删除 `/console-vue/*` 路由与 Vue bundle，React 不受影响。
**提交：** `chore: establish vue 3.5 console baseline`。

### Task 4: 扩充版本化检索评测集

**依赖：** Task 2。
**Files：** Create `evaluation/knowledge-v2/cases.jsonl`, `src/server/knowledge/retrieval-evaluation-v2.ts`, `src/server/knowledge/retrieval-evaluation-v2.test.ts`, `scripts/evaluate-knowledge.mjs`; Modify `package.json`.
**输入：** 已发布 fixture release、当前检索 API。
**输出：** 至少 100 条 case 与 `npm run evaluate:knowledge`。

**TDD：** 先写统计测试，空集、重复 id、引用不合法、跨项目答案均失败。填入 40 条中文、40 条英文、20 条无结果/权限案例，运行脚本得到当前基线但不把阈值作为旧实现门禁。

**命令：** red 阶段执行 `npm test -- src/server/knowledge/retrieval-evaluation-v2.test.ts`，预期 dataset/schema 断言失败；green 阶段执行 `npm test -- src/server/knowledge/retrieval-evaluation-v2.test.ts && npm run evaluate:knowledge`，预期至少 100 条 case 和四项指标输出。

```json
{"id":"zh-symbol-001","query":"哪里定义 projectAccess？","project":"fixture-a","expectedPaths":["src/server/persistence/store.ts"],"expectEmpty":false}
```

**验收：** 数据集 schema 可验证、无重复、没有真实客户内容；报告输出 Recall@5、MRR、citation validity、false-positive-empty。
**Rollback：** 删除新评测脚本与 fixture，不影响运行时。
**提交：** `test: add versioned knowledge retrieval evaluation set`。

**阶段 0 门禁：** Task 1-4 的测试均通过；PR 描述包含两份审查记录和当前代码 SHA；基线报告归档至 PR artifact。未通过不得处理会话或 pipeline。

## 阶段 1：身份与出站安全

### Task 5: 持久化 session 与 CSRF 合同

**依赖：** 阶段 0 门禁。
**Files：** Create `drizzle/0015_auth_sessions.sql`, `src/server/security/session-store.ts`, `src/server/security/session-store.test.ts`, `src/server/test-support/csrf.ts`, `docs/operations/session-rollout.md`; Modify `src/server/app.ts`, `src/server/security/session.ts`, `src/server/bootstrap.ts`, `src/server/env.ts`, `src/server/env.test.ts`, `src/server/bootstrap.test.ts`, `src/server/auth-routes.test.ts`, `src/server/persistence/postgres-knowledge.integration.test.ts`, `src/client/api/client.ts`, `src/client/api/client.test.ts` and authenticated route tests.
**输入：** 登录 session cookie。
**输出：** `auth_sessions`、opaque session cookie 与 cookie-authenticated write 的 CSRF guard。

**TDD：** 先测 POST 无 token、错误 token、过期 session、撤销 session 为 403/401；GET 不需要 CSRF；Bearer MCP 不接受 cookie。运行失败后实现 session ID hash、双提交 HMAC CSRF、`sessionVersion` 检查。

**命令：** red 阶段执行 `npm test -- src/server/security/session-store.test.ts src/server/auth-routes.test.ts src/server/persistence/postgres-knowledge.integration.test.ts`，预期因缺少 `auth_sessions`/CSRF guard 失败；green 阶段重复该命令并执行 `npm run typecheck`，预期均以退出码 `0` 结束。

```sql
CREATE TABLE auth_sessions (id_hash char(64) PRIMARY KEY, user_id uuid NOT NULL REFERENCES admin_users(id), workspace_id uuid NOT NULL REFERENCES workspaces(id), csrf_secret_hash char(64) NOT NULL, session_version integer NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz);
```

**验收：** session 绝不以明文持久化；所有 cookie 写路由覆盖；旧 cookie 被禁用/密码变更撤销。
**Rollback：** 仅在部署时设置一次性的 `DEVKH_LEGACY_SESSION_READ_UNTIL=<UTC ISO 8601>`，最多 24 小时。旧 JWT 在窗口内只允许读，写入返回 `SESSION_REFRESH_REQUIRED`；窗口结束后移除该变量。不得切回旧 cookie 写入，不删除新表。
**提交：** `feat: persist sessions and enforce csrf`。

### Task 6: 管理员 MFA 与恢复码

**依赖：** Task 5。
**Files：** Create `drizzle/0016_admin_mfa.sql`, `src/server/security/mfa.ts`, `src/server/security/mfa.test.ts`, `docs/operations/mfa.md`; Modify `src/server/app.ts`, `src/server/auth-routes.test.ts`, `src/server/persistence/store.ts`, `src/server/persistence/memory-store.ts`, `src/server/persistence/postgres-store.ts`, `src/server/persistence/postgres-knowledge.integration.test.ts`, `src/client/app.tsx`, `src/client/api/client.ts`, `src/client/api/types.ts`, `src/client/pages/system-settings-page.tsx`.
**输入：** admin session、TOTP challenge。
**输出：** enrol/verify/disable MFA API 与恢复码一次性展示。

**TDD：** 写 secret 加密、六位码、时间窗口、恢复码一次性消费、5 次失败锁定、非 admin 拒绝等失败测试；实现后重跑。

**命令：** red 阶段执行 `npm test -- src/server/security/mfa.test.ts src/server/auth-routes.test.ts`，预期 MFA route 或验证器断言失败；green 阶段重复并执行 `npm run typecheck`，预期退出码 `0`。

```ts
const parsed = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(request.body);
```

**验收：** MFA setup 未验证前不启用；禁用要求当前 password+TOTP；恢复码只有 scrypt hash。
**Rollback：** 在 break-glass 运维命令中撤销 MFA 并写审计，不能通过普通 API 绕过。
**提交：** `feat: require mfa for workspace administrators`。

### Task 7: MCP Token scope、过期与轮换

**依赖：** Task 5。
**Files：** Create `drizzle/0017_mcp_token_expiry.sql`; Modify `src/server/mcp/token-auth.ts`, `src/server/mcp/tools.ts`, `src/server/mcp-access.test.ts`, `src/server/app.ts`, `src/client/pages/project-codex-page.tsx`.
**输入：** project Token。
**输出：** 固定 90 天 `expires_at`、scope allowlist、轮换 API。

**TDD：** 未过期读 scope、过期 401 `MCP_TOKEN_EXPIRED`、撤销、跨项目、轮换后旧 Token 均失败；新 Token 仅显示一次。最小实现使用 constant-time hash 比较。

**命令：** red 阶段执行 `npm test -- src/server/mcp-access.test.ts src/server/app.test.ts`，预期过期/scoped Token 断言失败；green 阶段重复并执行 `npm run typecheck`，预期退出码 `0`。

```json
{"name":"ci-agent","scopes":["search","source.read"],"expiresInDays":90}
```

**验收：** Token 不能获写权限；scope 不允许 `*`；轮换审计含 prefix 不含 plaintext。
**Rollback：** 拒绝创建新 scoped Token，现有未到期 Token 保持只读直到人工撤销。
**提交：** `feat: add scoped expiring mcp tokens`。

### Task 8: Git SSRF 与受控出站

**依赖：** Task 5。
**Files：** Create `src/server/security/egress-policy.ts`, `src/server/security/egress-policy.test.ts`; Modify `src/server/git/snapshot.ts`, `src/server/repository-routes.test.ts`, `src/server/bootstrap.ts`.
**输入：** Git HTTPS URL。
**输出：** DNS-after-parse policy 与拒绝审计。

**TDD：** 对 `127.0.0.1`、`::1`、`169.254.169.254`、`10.0.0.0/8`、私网 DNS、非 443、用户名密码、`file://` 写失败测试。实现 `resolve4/resolve6`、CIDR 比较、禁止 redirect；clone 前和每个解析地址检查。

**命令：** red 阶段执行 `npm test -- src/server/security/egress-policy.test.ts src/server/repository-routes.test.ts`，预期 URL/DNS policy 缺失；green 阶段重复并执行 `npm run typecheck`，预期退出码 `0`。

```ts
await expect(assertAllowedGitUrl(new URL("https://127.0.0.1/repo.git"))).rejects.toThrow("GIT_EGRESS_DENIED");
```

**验收：** 仅公网 HTTPS:443；DNS rebinding 在连接前二次检查；错误不返回解析 IP。
**Rollback：** 禁止新增 Git 导入，已存在 snapshot 仍可读。
**提交：** `security: restrict git egress and ssrf targets`。

### Task 9: 供应链与恢复演练门禁

**依赖：** Task 5-8。
**Files：** Modify `package.json`, `scripts/backup/*`, `scripts/verify-delivery.mjs`, `.github/workflows/ci.yml`; Create `scripts/security/verify-runtime.mjs`, `docs/operations/recovery-evidence.md`.
**输入：** lockfile、加密备份、Compose volumes。
**输出：** audit/license/secret/runtime/recovery CI evidence。

**TDD：** 写脚本测试：lockfile 外依赖、high severity audit、secret、恢复写入生产卷均失败。运行 `node --test scripts/backup/backup.test.mjs` 失败后实现。

**命令：** red 阶段执行 `node --test scripts/backup/backup.test.mjs` 与 `node --test scripts/security/verify-runtime.node-test.mjs`，预期新增供应链/恢复断言失败；green 阶段执行 `npm run test:backup && npm run runtime:verify && npm run secrets:scan && npm run licenses:check`，预期退出码 `0`。

```ts
expect(report).toMatchObject({ productionVolumeTouched: false, restoredSnapshotCount: 1 });
```

**验收：** 一次隔离 Docker 恢复演练还原 DB、snapshot、artifact；报告记录哈希与日期。
**Rollback：** CI 仅报告不阻塞分支 24 小时后改为 required；恢复脚本不接触生产 volume。
**提交：** `chore: gate supply chain and recovery verification`。

**阶段 1 门禁：** CSRF、撤销、MFA、Token 过期、SSRF、限流、敏感日志与恢复测试通过；安全审查记录没有高风险未缓解项。

## 阶段 2：流水线合同与存储

### Task 10: 定义 pipeline 公共类型和旧状态映射

**依赖：** 阶段 1 门禁。
**Files：** Create `src/server/knowledge/pipeline/contracts.ts`, `src/server/knowledge/pipeline/contracts.test.ts`; Modify `src/shared/api-contracts.ts`, `src/server/knowledge/build-service.ts`.
**输入：** 现有 `BuildRecord`。
**输出：** `BuildStage`, `StageRun`, `ArtifactManifest`, `legacyBuildStatus()`。

**TDD：** 对未知 stage、重复 stage、非法状态转换、旧 build `ready/published/failed` 映射写失败测试。最小实现只导出纯函数和 Zod schema。

**命令：** red 阶段执行 `npm test -- src/server/knowledge/pipeline/contracts.test.ts`，预期 contracts 或映射不存在；green 阶段重复并执行 `npm run typecheck`，预期退出码 `0`。

```ts
export function legacyBuildStatus(runs: StageRun[]): "queued" | "running" | "ready" | "failed" | "published" { /* exhaustive switch */ }
```

**验收：** schema 是唯一 DTO 来源；React 现有类型兼容；无运行时行为变化。
**Rollback：** 删除未使用合同文件。
**提交：** `feat: define knowledge pipeline contracts`。

### Task 11: 增加 stage run 与 artifact SQL 模型

**依赖：** Task 10。
**Files：** Create `drizzle/0018_knowledge_pipeline.sql`; Modify `src/server/persistence/store.ts`, `src/server/persistence/postgres-store.ts`, `src/server/persistence/postgres-store.test.ts`, `src/server/persistence/postgres-knowledge.integration.test.ts`.
**输入：** contracts。
**输出：** stage/artifact CRUD、cache lookup、transaction claim。

**TDD：** PostgreSQL 集成测试先断言 unique cache key、跨项目拒绝、`FOR UPDATE SKIP LOCKED` 单领取、published artifact 不可删除；迁移不存在时失败。实现 SQL 后重跑 integration。

**命令：** red 阶段执行 `npm run test:integration`，预期迁移/Store 方法缺失或断言失败；green 阶段执行 `npm run db:migrate && npm run test:integration`，预期退出码 `0` 且 PostgreSQL 断言全部通过。

```sql
CREATE UNIQUE INDEX knowledge_artifact_cache_idx ON knowledge_artifacts(project_id, snapshot_id, stage, kind, input_digest);
```

**验收：** 所有查询带 workspace/project；manifest 的 source refs 为 JSONB schema；原子写审计。
**Rollback：** 停止 worker、不读取新表；表保留。
**提交：** `feat: persist stage runs and knowledge artifacts`。

### Task 12: 内容寻址 artifact store 与缓存

**依赖：** Task 11。
**Files：** Create `src/server/knowledge/pipeline/artifact-store.ts`, `artifact-store.test.ts`; Modify `src/server/bootstrap.ts`, `scripts/backup/devkh-backup.sh`.
**输入：** manifest、artifact bytes。
**输出：** `putJson`, `getJson`, `findReusable`。

**TDD：** 写 canonical key、相同 input 复用、不同 project 不复用、写入失败不创建 manifest、取消前不提交的失败测试。实现先写临时文件 `fsync` 再原子 rename。

**命令：** red 阶段执行 `npm test -- src/server/knowledge/pipeline/artifact-store.test.ts`，预期 artifact store 不存在；green 阶段重复并执行 `npm run test:backup`，预期退出码 `0`。

```ts
const storageKey = `${projectId}/${snapshotId}/${stage}/${contentDigest}.json`;
```

**验收：** 路径不可穿越；备份包含 artifact volume；哈希不一致拒绝读取。
**Rollback：** feature flag 关闭 cache；已生成 artifact 只读保留。
**提交：** `feat: add content addressed artifact storage`。

### Task 13: 增量失效与 pg-boss stage worker

**依赖：** Task 11-12。
**Files：** Create `src/server/knowledge/pipeline/invalidation.ts`, `worker.ts`, tests; Modify `src/server/knowledge/job-queue.ts`, `src/server/knowledge/change-impact.ts`.
**输入：** snapshot diff、manifest dependency。
**输出：** `InvalidationPlan` 与队列调度。

**TDD：** 单文件更改仅失效该文件 convert/extract、依赖 graph、引用知识页；无变更全 reuse；取消不排下游。跑 `npm test -- src/server/knowledge/pipeline/*.test.ts` 失败后实现。

**命令：** red 阶段执行 `npm test -- src/server/knowledge/pipeline/invalidation.test.ts src/server/knowledge/pipeline/worker.test.ts`，预期失效计划或 worker 调度断言失败；green 阶段重复并执行 `npm run test:integration`，预期退出码 `0`。

```ts
expect(plan.rebuildStages.get("src/a.ts")).toEqual(["convert", "extract", "graph", "synthesize", "index", "lint", "viz", "validate", "package"]);
```

**验收：** worker 幂等、崩溃后可恢复、cache hit 统计；没有后台自动发布。
**Rollback：** `KNOWLEDGE_PIPELINE_V2=false` 时保留旧 queue。
**提交：** `feat: schedule incremental knowledge stages`。

### Task 14: 阶段 REST/SSE 与兼容投影

**依赖：** Task 13。
**Files：** Modify `src/server/app.ts`, `src/server/app.test.ts`, `src/client/api/client.ts`, `src/client/api/types.ts`; Create `src/server/knowledge/pipeline/events.ts`, `events.test.ts`.
**输入：** StageRun 持久化状态。
**输出：** stages/events endpoint，旧 build 状态不变。

**TDD：** 先测 `Last-Event-ID` 重连、跨项目 403、未知 build 404、旧客户端只收到五种状态。实现数据库 event cursor 后重跑。

**命令：** red 阶段执行 `npm test -- src/server/knowledge/pipeline/events.test.ts src/server/app.test.ts`，预期 event cursor/SSE route 失败；green 阶段重复并执行 `npm run typecheck`，预期退出码 `0`。

```ts
expect(event).toEqual({ id: "42", event: "stage.updated", data: expect.stringContaining('"stage":"extract"') });
```

**验收：** SSE 不含 artifact content/secret；断线可恢复；每用户连接限流。
**Rollback：** 停止 SSE endpoint，旧 polling 仍可用。
**提交：** `feat: expose pipeline stages and events`。

**阶段 2 门禁：** artifact cache、单文件失效、取消、恢复、SSE 兼容和 PostgreSQL integration 通过；旧构建/发布流程回归通过。

## 阶段 3：统一 IR 与解析器

### Task 15: convert 与 Web 源码 IR 适配器

**依赖：** 阶段 2 门禁。
**Files：** Create `src/server/knowledge/pipeline/convert.ts`, `extract-web.ts`, tests, fixtures; Modify `src/server/knowledge/intelligence.ts`.
**输入：** `SourceFileRecord`、快照文件。
**输出：** `KnowledgeIR` 的 files/symbols/imports。

**TDD：** 新夹具含 `.ts/.tsx/.js/.jsx`、动态 import、破损语法、1 MiB 边界；先断言 parser 不执行代码且引用行正确。实现 TypeScript AST visitor。

**命令：** red 阶段执行 `npm test -- src/server/knowledge/pipeline/convert.test.ts src/server/knowledge/pipeline/extract-web.test.ts`，预期 IR adapter 不存在或断言失败；green 阶段重复并执行 `npm run typecheck`，预期退出码 `0`。

```ts
type IRImport = { fromPath: string; specifier: string; kind: "static" | "dynamic"; sourceRef: SourceRef };
```

**验收：** AST 解析确定性；破损文件只生成 lint；动态 import 不进行 module resolution。
**Rollback：** 关闭 V2 pipeline，保留现有 index。
**提交：** `feat: extract web source into knowledge ir`。

### Task 16: Vue SFC 与 Markdown/JSON/YAML 适配器

**依赖：** Task 15、Task 3。
**Files：** Create `extract-vue.ts`, `extract-documents.ts`, tests, fixtures; Modify `pipeline/worker.ts`, `package.json`, `package-lock.json`.
**输入：** convert artifact。
**输出：** SFC symbol、文档段落、配置路径。

**TDD：** `.vue` 的 script setup、template 静态标签、custom block、remote src；YAML alias/tag、32 层嵌套、Markdown HTML 均先失败。实现 `@vue/compiler-sfc@3.5.13`、CommonMark、FAILSAFE YAML。

**命令：** red 阶段执行 `npm test -- src/server/knowledge/pipeline/extract-vue.test.ts src/server/knowledge/pipeline/extract-documents.test.ts`，预期 adapter 或安全拒绝断言失败；green 阶段重复并执行 `npm run typecheck`，预期退出码 `0`。

```ts
expect(extractVueSfc("<script setup>const count = 0</script>", ref).symbols[0]?.name).toBe("count");
```

**验收：** 不执行 template expression/自定义 block；每个抽取对象有 SourceRef。
**Rollback：** 将 Vue/文档文件标记 unsupported，其他文件继续。
**提交：** `feat: parse vue and document sources into ir`。

### Task 17: CSV/XLSX 安全表格解析

**依赖：** Task 12、Task 15。
**Files：** Create `tables.ts`, `tables.test.ts`, table fixtures; Modify `src/shared/import-filter.ts`, `pipeline/worker.ts`.
**输入：** convert artifact 或原始安全文件流。
**输出：** `TableSchema`、sample、table lint。

**TDD：** 公式、VBA、externalLink、ZIP bomb、100001 行、257 列、50 MiB、30 秒 watchdog 先失败。实现流式 CSV 与 XML-only XLSX reader。

**命令：** red 阶段执行 `npm test -- src/server/knowledge/pipeline/tables.test.ts src/shared/import-filter.test.ts`，预期表格解析或资源边界断言失败；green 阶段重复并执行 `npm run typecheck`，预期退出码 `0`。

```ts
expect(schema.columns[0]).toMatchObject({ name: "email", type: "string", sensitive: true });
```

**验收：** 不执行公式/宏/链接；样本已脱敏；finally 删除 temp。
**Rollback：** 表格文件不进入 tables stage，保留源码快照。
**提交：** `feat: add resource bounded table extraction`。

### Task 18: 可选 LLM 增强与降级

**依赖：** Task 15-17。
**Files：** Modify `src/server/knowledge/enhancer.ts`, `generator.ts`; Create `pipeline/llm-enhancement.ts`, tests.
**输入：** 已验证 IR 片段。
**输出：** schema-validated summary/aliases 或 deterministic fallback。

**TDD：** provider timeout、无效 JSON、越界引用、幻觉文件、缓存命中先失败。最小实现 Zod schema 与 citation verifier；禁止在 parse/graph/tables 调用模型。

**命令：** red 阶段执行 `npm test -- src/server/knowledge/pipeline/llm-enhancement.test.ts`，预期 enhancer contract 缺失；green 阶段重复并执行 `npm run typecheck`，预期退出码 `0`。

```ts
await expect(enhance(invalidCitationPayload, context)).resolves.toMatchObject({ mode: "fallback", warning: "CITATION_INVALID" });
```

**验收：** LLM 输入/输出不含 secret；失败结果是 warning 不是自动重试风暴；引用 100% 有效。
**Rollback：** `KNOWLEDGE_LLM_ENHANCEMENT=false`，只生成 deterministic 内容。
**提交：** `feat: add validated optional knowledge enhancement`。

**阶段 3 门禁：** 所有格式夹具、资源限制、来源引用、LLM fallback 通过；没有新增自动发布路径。

## 阶段 4：Graph

### Task 19: Graph 模型与关系构建

**依赖：** 阶段 3 门禁。
**Files：** Create `drizzle/0019_knowledge_graph.sql`, `graph.ts`, `graph.test.ts`; Modify persistence contract/store/integration tests.
**输入：** KnowledgeIR、TableSchema。
**输出：** facts/candidates graph artifacts。

**TDD：** 先测 imports/contains/reads/writes、candidate reason、dangling fact edge、跨项目节点、循环；实现 transactional node/edge writer。

**命令：** red 阶段执行 `npm test -- src/server/knowledge/pipeline/graph.test.ts src/server/persistence/postgres-knowledge.integration.test.ts`，预期 Graph schema/事务断言失败；green 阶段执行 `npm run test:integration && npm test -- src/server/knowledge/pipeline/graph.test.ts`，预期退出码 `0`。

```sql
CHECK ((candidate = true AND candidate_reason IS NOT NULL) OR (candidate = false AND jsonb_array_length(source_refs) > 0))
```

**验收：** 事实边两端存在且有来源；candidate 不升级为事实；循环可保存。
**Rollback：** 停止 graph stage，旧知识仍可发布。
**提交：** `feat: persist sourced knowledge graph`。

### Task 20: Graph REST、MCP 与可视化导出

**依赖：** Task 19、Task 14。
**Files：** Modify `src/server/app.ts`, `src/server/mcp/tools.ts`, MCP/API tests; Create `viz.ts`, `viz.test.ts`, `src/client/pages/project-graph-page.tsx`.
**输入：** published graph artifact。
**输出：** Graph API/MCP、Mermaid、Markmap、JSON tree。

**TDD：** depth >2、100 节点以上、其他项目/未发布 release、Mermaid 注入、循环 tree 各失败。实现 release scoped query 与 escaping。

**命令：** red 阶段执行 `npm test -- src/server/knowledge/pipeline/viz.test.ts src/server/mcp-access.test.ts src/server/app.test.ts`，预期 Graph API/MCP 或转义断言失败；green 阶段重复并执行 `npm run typecheck`，预期退出码 `0`。

```ts
expect(await graphQuery(projectId, releaseId, rootNodeId, 3)).toEqual({ error: { code: "GRAPH_DEPTH_INVALID" } });
```

**验收：** 页面区分事实/候选；所有图响应带 release/source refs；MCP 256 KiB 上限。
**Rollback：** 隐藏 Graph route/tools，artifact 可留存。
**提交：** `feat: expose sourced graph queries and exports`。

### Task 21: 脑图树与变更影响联动

**依赖：** Task 19。
**Files：** Modify `src/server/knowledge/change-impact.ts`, `pipeline/invalidation.ts`; Create `mindmap.ts`, tests; Modify project overview UI/tests.
**输入：** snapshot diff、Graph。
**输出：** impact tree、suggested tests、crossLinks。

**TDD：** 重命名、删除、循环、candidate edge、无变更先失败；实现从事实 `contains` 根树与一跳依赖影响。

**命令：** red 阶段执行 `npm test -- src/server/knowledge/change-impact.test.ts src/server/knowledge/pipeline/invalidation.test.ts`，预期树化或候选边隔离断言失败；green 阶段重复并执行 `npm run typecheck`，预期退出码 `0`。

```ts
expect(result.crossLinks).toEqual(expect.not.arrayContaining([expect.objectContaining({ candidate: true })]));
```

**验收：** 仅提示、不自动构建；candidate 不扩大影响范围；删除节点不留事实悬空边。
**Rollback：** 回退为当前 path/symbol impact report。
**提交：** `feat: derive graph-aware change impact`。

**阶段 4 门禁：** Graph/REST/MCP/导出/影响测试通过；发布版本以外的数据无法读取。

## 阶段 5：检索、质量与 remediation

### Task 22: 中文字段化索引与 Graph 重排

**依赖：** 阶段 4 门禁、Task 4。
**Files：** Create `drizzle/0020_search_documents_v2.sql`, `search-v2.ts`, tests; Modify postgres store/search routes/evaluation script.
**输入：** released pages、symbols、tables、facts graph。
**输出：** bigram/trigram search document 与解释性 score。

**TDD：** 符号、路径、命令、中文、表字段、邻居、无结果、跨项目先失败；实现 NFKC tokenization 与固定权重。

**命令：** red 阶段执行 `npm test -- src/server/knowledge/search-v2.test.ts src/server/knowledge/retrieval-evaluation-v2.test.ts`，预期索引/重排断言失败；green 阶段重复并执行 `npm run evaluate:knowledge`，预期报告存在全部指标且退出码 `0`。

```ts
expect(result.matchReasons).toContain("exact_symbol");
expect(result.releaseId).toBe(release.id);
```

**验收：** 仅已发布项目；TrustScore <0.60 不占前五；无结果不伪造命中。
**Rollback：** `SEARCH_V2=false` 切回旧 SQL，保留 v2 索引。
**提交：** `feat: add chinese fielded knowledge search`。

### Task 23: Lint、Trust 与局部 remediation

**依赖：** Task 22、Task 18。
**Files：** Create `lint.ts`, `trust.ts`, `remediation.ts` and tests; Modify SQL/persistence/app/client quality page.
**输入：** artifacts、search docs、Graph。
**输出：** `LintIssue`、`TrustScore`、remediation state machine。

**TDD：** 逐条写 missing citation、out of range、graph dangling、table sensitive、low coverage、错误状态迁移的失败测试。实现 lint rules 后运行全量。

**命令：** red 阶段执行 `npm test -- src/server/knowledge/lint.test.ts src/server/knowledge/trust.test.ts src/server/knowledge/remediation.test.ts`，预期规则/状态机断言失败；green 阶段执行 `npm test && npm run typecheck`，预期退出码 `0`。

```ts
await expect(store.acceptRemediation(projectId, issueId, actorId)).resolves.toMatchObject({ state: "rebuilding" });
```

**验收：** error 阻断 package；warning 降分；局部 build 不改变 current release。
**Rollback：** Lint 只报告不阻断，remediation API 关闭。
**提交：** `feat: add knowledge lint trust and remediation`。

### Task 24: 检索质量 CI 与阈值门禁

**依赖：** Task 22-23。
**Files：** Modify evaluation cases/script, `.github/workflows/ci.yml`, `docs/operations/search-quality.md`; Create `scripts/compare-knowledge-kernels.mjs`.
**输入：** 100+ case dataset、V1/V2 release。
**输出：** 可比较 JSON report 与 required CI thresholds。

**TDD：** 对低 Recall/MRR、无效 citation、空结果误命中写失败 fixture；实现报告计算和阈值断言。

**命令：** red 阶段执行 `npm test -- src/server/knowledge/retrieval-evaluation-v2.test.ts`，预期阈值守卫失败；green 阶段执行 `npm run evaluate:knowledge`，预期 `Recall@5 >= 0.90`、`MRR >= 0.75`、`citationValidity = 1`、`falsePositiveEmptyRate <= 0.05`。

```json
{"recallAt5":0.90,"mrr":0.75,"citationValidity":1,"falsePositiveEmpty":0.05}
```

**验收：** CI 失败信息列出 case id；报告是 artifact；从相同 fixture 重复执行相同。
**Rollback：** 保留报告但把 new kernel gate 切为 informational，旧发布不回退。
**提交：** `test: gate knowledge retrieval quality`。

**阶段 5 门禁：** 100+ case 达到 Recall@5 >= 0.90、MRR >= 0.75、citation 100%、empty false positive <=5%，Lint error 为零。

## 阶段 6：Vue 管理端

### Task 25: Vue 基础、功能对等、入口切换与回退

**依赖：** 阶段 5 门禁、Task 3。
**Files：** Create `src/client-vue/router.ts`, `api.ts`, `stores/*`, `components/ui/*`, `pages/*`, Playwright specs; Modify `vite.config.ts`, `src/server/app.ts`, Nginx config, `docs/operations/vue-rollout.md`.
**输入：** `src/shared/api-contracts.ts`、REST/SSE、React route map。
**输出：** `/console-vue/*` 全路由、`CONSOLE_IMPLEMENTATION` 切换、`/console-react/*` 回退。

**TDD：** 按路由顺序写失败 Playwright：登录、projects、imports、versions、knowledge、graph、quality、collaboration、codex、feedback、members、settings；每个覆盖 admin/member/reader 与 1440/390。先确认 Vue shell 失败，再逐页最小对等实现。

**命令：** red 阶段执行 `npm run test:e2e -- --project=chromium`，预期 `/console-vue/*` 路由或功能对等断言失败；green 阶段执行 `npm run build && npm run test:e2e -- --project=chromium`，预期 1440px/390px 和三角色场景全部通过。

```ts
test("reader cannot see member management in Vue", async ({ page }) => {
  await loginAs(page, "reader@example.com");
  await page.goto("/console-vue/projects/p1/collaboration");
  await expect(page.getByRole("button", { name: "添加成员" })).toHaveCount(0);
});
```

**验收：** 共享 DTO 无 duplicate API type；CSP nonce、SSE reconnect、错误/空状态、键盘导航和移动布局通过；切换前 React 回退 smoke 通过。
**Rollback：** 设置 `CONSOLE_IMPLEMENTATION=react` 并 Nginx reload；不回滚数据库或 artifacts。
**提交：** 按 `feat(vue): add console shell`、`feat(vue): migrate core project pages`、`feat(vue): add graph and quality pages`、`feat(vue): enable console implementation switch` 拆为四个独立提交，最后一个 PR 聚合证据。

**阶段 6 门禁：** React/Vue 双入口均通过完整 E2E；三角色、桌面/移动、上传、构建、发布、Graph、质量页功能对等；React 回退 5 分钟内经生产预发布验证。

## 阶段 7：影子构建、压测与生产发布

### Task 26: 新旧内核影子构建与差异报告

**依赖：** 阶段 6 门禁。
**Files：** Create `src/server/knowledge/pipeline/shadow.ts`, tests, `scripts/run-shadow-build.mjs`; Modify build queue/admin diagnostics.
**输入：** 同一 snapshot 的 V1/V2 build。
**输出：** path/citation/graph/search/lint diff report。

**TDD：** 相同 snapshot、取消、V2 失败、差异超过阈值先失败；shadow 不得创建 release。实现只读 artifacts 和审计。

**命令：** red 阶段执行 `npm test -- src/server/knowledge/pipeline/shadow.test.ts`，预期 shadow runner 或 release 不变量断言失败；green 阶段重复并执行 `node --import tsx scripts/run-shadow-build.mjs --fixture fixture-a`，预期 `releaseCreated=false` 且输出 comparison artifact ID。

```ts
expect(await runShadowBuild(snapshotId)).toMatchObject({ releaseCreated: false, comparisonArtifactId: expect.any(String) });
```

**验收：** diff 报告含 manifest hashes；V1 current release 不改变；至少 10 个真实测试项目或等效 fixture 执行。
**Rollback：** 关闭 `KNOWLEDGE_PIPELINE_SHADOW`，不删报告。
**提交：** `test: add knowledge kernel shadow comparison`。

### Task 27: 压力、恢复、灰度与生产切换

**依赖：** Task 26。
**Files：** Create `scripts/load/pipeline-load.mjs`, `scripts/release/verify-production.mjs`; Modify Compose/Nginx/monitoring/docs and Playwright production smoke.
**输入：** 影子报告、恢复备份、production feature flags。
**输出：** 10%/50%/100% rollout evidence、回退演练、生产验收报告。

**TDD：** 用本地 Compose 压测 10 并发 build、取消、worker restart、SSE reconnect；测试脚本在错误率/队列延迟超过阈值时失败。先失败后实现指标读取和报告。

**命令：** red 阶段执行 `node scripts/load/pipeline-load.mjs --concurrency 10 --expect-failure`，预期缺少指标/阈值检查而失败；green 阶段执行 `docker compose --profile integration up -d && node scripts/load/pipeline-load.mjs --concurrency 10 && node scripts/release/verify-production.mjs --base-url https://hub.starking.icu`，预期三条命令退出码 `0` 并产出 rollout report。

```ts
expect(summary).toMatchObject({ concurrentBuilds: 10, errorRate: 0, p95QueueDelayMs: expect.any(Number) });
```

**验收：** 数据库+snapshot+artifact 恢复演练成功；一次 Vue->React 回退成功；同 Snapshot V1/V2 对比通过；公网 smoke 覆盖登录、导入、构建、Graph、检索、发布。
**Rollback：** 立即设 `KNOWLEDGE_PIPELINE_V2=false`、`CONSOLE_IMPLEMENTATION=react`，停止 V2 worker；保留数据库与 artifacts，按恢复手册恢复一致性集合。
**提交：** `chore: prepare knowledge kernel production rollout`。

**阶段 7 门禁：** 影子差异、压测、备份恢复、前端回退、生产 smoke、全部质量/安全门禁通过后才允许 100% 发布。任何阶段失败不得创建或发布新的 V2 release。

## 执行证据模板

每个任务 PR 描述使用以下固定内容：

```md
## Evidence
- Task: 12
- Failed test observed: `npm test -- src/server/knowledge/pipeline/artifact-store.test.ts` -> expected missing module error
- Passing verification: `npm test -- src/server/knowledge/pipeline/artifact-store.test.ts`, `npm run typecheck`, `npm run lint`
- 产品经理视角自审：用户流程、空状态、权限与手动发布边界已按实际截图/测试确认；结论：approve / request changes。
- 开发经理视角自审：类型、SQL 事务、安全边界、回滚、测试覆盖已按实际 diff 确认；结论：approve / request changes。
- Rollback: `KNOWLEDGE_PIPELINE_V2=false`
- Commit: `<sha>`
```

`request changes` 时不得合并或开始下一任务；修复后必须新增审查记录和测试输出。没有外部审批人时，上述两项是同一执行代理以两个职责视角进行的可追溯审查，不得声称为独立人工批准。
