# 项目级成员权限 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 让工作区成员只能访问被显式授予的项目，并在项目协作页完成项目成员管理。

**Architecture:** project_members 是项目授权唯一来源。持久化层保证同工作区边界、管理员存活和审计原子性；Fastify 用一个项目授权 pre-handler 保护项目范围路由；客户端只展示服务端返回的项目成员和允许的操作。

**Tech Stack:** TypeScript 6、Fastify 5、PostgreSQL 16、Drizzle SQL migrations、React 19、Ant Design 5、TanStack Query、Vitest。

## Global Constraints

- 工作区 admin 可管理工作区内所有项目。
- 工作区 member 与 reader 必须拥有 project_members 记录才能访问目标项目。
- 工作区 member 可被授予项目 admin、member 或 reader；工作区 reader 只能被授予项目 reader。
- 未授权项目访问统一返回 403 PROJECT_ACCESS_DENIED，且不返回项目资源详情。
- 项目成员必须是同一工作区已有成员；项目创建者自动成为项目 admin。
- 不可移除或降级最后一名项目 admin。
- MCP Token 仍严格绑定一个项目，成员变更不能扩大 Token 范围。

---

### Task 1: 新增项目成员迁移和存储合同

**Files:**
- Create: drizzle/0012_project_members.sql
- Modify: src/server/persistence/store.ts
- Test: src/server/persistence/postgres-knowledge.integration.test.ts

**Interfaces:**
- Produces: ProjectRole、ProjectMemberRecord、ProjectAccess。
- Produces: AppStore.listProjectMembers、addProjectMember、updateProjectMemberRole、removeProjectMember、projectAccess。

- [ ] **Step 1: 写迁移失败断言**

在迁移集成测试中断言 project_members 表、project_id/user_id 主键、删除级联和管理员回填均存在。

~~~ts
const result = await pool.query(
  "SELECT pm.role FROM project_members pm JOIN workspace_members wm ON wm.user_id = pm.user_id WHERE pm.project_id = $1 AND wm.role = 'admin'",
  [projectId]
);
expect(result.rows).toEqual([{ role: "admin" }]);
~~~

- [ ] **Step 2: 运行测试确认失败**

Run: docker compose -f /absolute/path/to/dev-knowledge-hub/docker-compose.yml -p dev-knowledge-hub --profile test run --rm --build integration

Expected: FAIL，project_members 尚不存在。

- [ ] **Step 3: 创建迁移和类型**

迁移使用现有 team_role 枚举，并绑定项目与同工作区用户：

~~~sql
CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  role team_role NOT NULL DEFAULT 'reader',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_idx ON project_members (user_id, project_id);
INSERT INTO project_members (project_id, user_id, role)
SELECT p.id, wm.user_id, 'admin'::team_role
FROM projects p JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
WHERE wm.role = 'admin'
ON CONFLICT (project_id, user_id) DO NOTHING;
~~~

在 store.ts 定义：

~~~ts
export type ProjectRole = TeamRole;
export interface ProjectMemberRecord {
  id: string; projectId: string; workspaceId: string;
  email: string; role: ProjectRole; createdAt: Date;
}
export interface ProjectAccess {
  project: ProjectRecord; role: ProjectRole | null;
}
~~~

- [ ] **Step 4: 运行测试确认通过**

Run: docker compose -f /absolute/path/to/dev-knowledge-hub/docker-compose.yml -p dev-knowledge-hub --profile test run --rm --build integration

Expected: migration test PASS。

- [ ] **Step 5: 提交**

~~~bash
git add drizzle/0012_project_members.sql src/server/persistence/store.ts src/server/persistence/postgres-knowledge.integration.test.ts
git commit -m "feat: add project member persistence contract"
~~~

### Task 2: 以测试先行实现内存与 PostgreSQL 存储

**Files:**
- Modify: src/server/persistence/memory-store.ts
- Modify: src/server/persistence/postgres-store.ts
- Test: src/server/persistence/memory-store.test.ts
- Test: src/server/persistence/postgres-store.test.ts
- Test: src/server/persistence/postgres-knowledge.integration.test.ts

**Interfaces:**
- Consumes: Task 1 的 AppStore 新合同。
- Produces: 项目成员 CRUD、访问查询、原子审计和 LAST_PROJECT_ADMIN 错误。

- [ ] **Step 1: 写内存存储失败测试**

覆盖创建项目自动加入创建者、非工作区成员不能加入、重复加入返回 null、最后管理员不能移除/降级、工作区管理员不需要项目成员行也可访问。

~~~ts
const record = await store.addProjectMember(workspace.id, project.id, member.id, "reader", admin.id);
expect(record).toMatchObject({ email: "reader@example.com", role: "reader" });
await expect(store.removeProjectMember(workspace.id, project.id, admin.id, admin.id))
  .rejects.toThrow("LAST_PROJECT_ADMIN");
~~~

- [ ] **Step 2: 运行内存测试确认失败**

Run: npm test -- src/server/persistence/memory-store.test.ts

Expected: FAIL，项目成员方法尚未实现。

- [ ] **Step 3: 实现内存关系和审计**

MemoryAppStore 添加 projectMembers 集合。createInitialSetup 与 createProject 插入创建者 admin。变更前验证项目、工作区成员和角色；变更后记录 project_member.added、project_member.role_changed 或 project_member.removed。

~~~ts
private assertProjectAdminSurvives(projectId: string, userId: string, nextRole?: ProjectRole) {
  const otherAdmins = this.projectMembers.filter((item) =>
    item.projectId === projectId && item.role === "admin" && item.userId !== userId
  );
  if (nextRole !== "admin" && otherAdmins.length === 0) throw new Error("LAST_PROJECT_ADMIN");
}
~~~

- [ ] **Step 4: 写 PostgreSQL 查询失败测试**

断言 addProjectMember 的 INSERT SELECT 同时匹配 projects.workspace_id 与 workspace_members.workspace_id；断言角色变更和删除以事务锁住成员行并写审计。

~~~ts
expect(query.mock.calls.some(([sql]) => String(sql).includes("FOR UPDATE"))).toBe(true);
expect(query.mock.calls.some(([sql]) => String(sql).includes("project_member.role_changed"))).toBe(true);
~~~

- [ ] **Step 5: 实现 PostgreSQL 存储**

postgres-store.ts 添加 ProjectMemberRow、行映射和事务方法。添加成员采用下列 SQL 模式：

~~~sql
INSERT INTO project_members (project_id, user_id, role)
SELECT p.id, wm.user_id, $4::team_role
FROM projects p
JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = $3
WHERE p.id = $2 AND p.workspace_id = $1
ON CONFLICT (project_id, user_id) DO NOTHING
RETURNING project_id, user_id, role, created_at;
~~~

更新和删除先执行 SELECT ... FOR UPDATE，最后项目 admin 的降级或删除抛出 LAST_PROJECT_ADMIN。projectAccess 在同一个查询中返回项目与用户的项目角色；若工作区 admin 访问，角色固定为 admin。

- [ ] **Step 6: 运行存储和真实数据库验证**

Run:
~~~bash
npm test -- src/server/persistence/memory-store.test.ts src/server/persistence/postgres-store.test.ts
docker compose -f /absolute/path/to/dev-knowledge-hub/docker-compose.yml -p dev-knowledge-hub --profile test run --rm --build integration
~~~

Expected: 所有测试 PASS，集成测试验证跨项目访问记录隔离。

- [ ] **Step 7: 提交**

~~~bash
git add src/server/persistence/memory-store.ts src/server/persistence/memory-store.test.ts src/server/persistence/postgres-store.ts src/server/persistence/postgres-store.test.ts src/server/persistence/postgres-knowledge.integration.test.ts
git commit -m "feat: persist project member access"
~~~

### Task 3: 统一项目授权并暴露成员 API

**Files:**
- Modify: src/server/app.ts
- Test: src/server/team-routes.test.ts
- Test: src/server/knowledge-routes.test.ts
- Test: src/server/mcp.test.ts

**Interfaces:**
- Consumes: AppStore.projectAccess 和成员 CRUD。
- Produces: requireProjectRole(role, projectId, request, reply)。
- Produces: GET/POST/PATCH/DELETE /api/projects/:projectId/members。

- [ ] **Step 1: 写权限矩阵失败测试**

未加入项目的工作区 reader 读取项目活动、带 x-devkh-project 的 repository 与知识搜索时返回 PROJECT_ACCESS_DENIED。被加为 reader 后可读但不能上传或构建；被加为 member 后可上传/构建；工作区 admin 对未显式加入的项目仍可访问。

~~~ts
expect(response.statusCode).toBe(403);
expect(response.json()).toEqual({
  error: { code: "PROJECT_ACCESS_DENIED", message: "Project access is not permitted" }
});
~~~

- [ ] **Step 2: 运行路由测试确认失败**

Run: npm test -- src/server/team-routes.test.ts src/server/knowledge-routes.test.ts

Expected: FAIL，现有工作区成员仍可越过项目边界。

- [ ] **Step 3: 添加授权帮助函数**

在现有 requireRole 后添加：

~~~ts
async function requireProjectRole(
  role: TeamRole, projectId: string, request: FastifyRequest, reply: FastifyReply
): Promise<void> {
  await requireRole("reader", request, reply);
  if (reply.sent) return;
  const user = (request as AuthenticatedRequest).sessionAdmin;
  if (user.role === "admin") return;
  const access = await options.store.projectAccess(user.workspaceId, projectId, user.id);
  if (!access?.role || !roleAllows(access.role, role)) {
    sendError(reply, 403, "PROJECT_ACCESS_DENIED", "Project access is not permitted");
  }
}
~~~

使用该函数保护项目摘要、活动、项目资料来源，以及所有借助 requestedProjectId 解析当前项目的上传、同步、构建、知识、发布、反馈和 Token 路由。GET /api/projects 对普通成员只返回 projectAccess 存在的项目。

- [ ] **Step 4: 实现项目成员路由**

项目 admin 才能调用成员管理路由。候选 userId 必须是同工作区成员。LAST_PROJECT_ADMIN 映射为 409 PROJECT_ADMIN_REQUIRED。GET 成员路由允许 project reader。

~~~text
GET    /api/projects/:projectId/members
POST   /api/projects/:projectId/members
PATCH  /api/projects/:projectId/members/:userId
DELETE /api/projects/:projectId/members/:userId
~~~

- [ ] **Step 5: 验证 MCP 项目边界**

在 mcp.test.ts 以两个项目、两个 release、两个 Token 验证 token A 永远不能读取 token B 的发布、页面与源码。

Run: npm test -- src/server/team-routes.test.ts src/server/knowledge-routes.test.ts src/server/mcp.test.ts

Expected: PASS。

- [ ] **Step 6: 提交**

~~~bash
git add src/server/app.ts src/server/team-routes.test.ts src/server/knowledge-routes.test.ts src/server/mcp.test.ts
git commit -m "feat: enforce project access in routes"
~~~

### Task 4: 改造项目协作页并完成交付验证

**Files:**
- Modify: src/client/api/types.ts
- Modify: src/client/api/client.ts
- Modify: src/client/hooks/use-domain.ts
- Modify: src/client/pages/project-collaboration-page.tsx
- Modify: src/client/app.test.tsx
- Modify: docs/AI_DEVELOPER_HANDOFF.md

**Interfaces:**
- Consumes: Task 3 的成员 API。
- Produces: ProjectMember、项目成员查询缓存、项目协作成员管理操作。

- [ ] **Step 1: 写协作页失败测试**

把当前团队角色断言替换成项目角色，验证项目 admin 看见添加成员、角色选择与移除操作，非项目 admin 不看见管理控件。

~~~tsx
expect(screen.getByText("项目角色")).toBeVisible();
expect(screen.getByRole("button", { name: "添加成员" })).toBeVisible();
await user.click(screen.getByRole("button", { name: "移除成员" }));
expect(api.removeProjectMember).toHaveBeenCalledWith("project-1", "member-1");
~~~

- [ ] **Step 2: 运行前端测试确认失败**

Run: npm test -- src/client/app.test.tsx

Expected: FAIL，当前页面只展示工作区成员。

- [ ] **Step 3: 扩展客户端合同和缓存键**

types.ts 新增：

~~~ts
export interface ProjectMember extends TeamMember {
  projectId: string;
  workspaceId: string;
}
~~~

ApiClient 新增 listProjectMembers、addProjectMember、updateProjectMemberRole、removeProjectMember。use-domain.ts 新增 projectKeys.members(projectId)，变更成功后失效成员、活动和摘要查询。

- [ ] **Step 4: 实现项目成员管理 UI**

ProjectCollaborationPage 用 listProjectMembers 读取名单，标题改为项目成员和项目角色。添加成员表单从 listMembers 选择且排除已加入成员；角色变更使用 Select；移除使用 Popconfirm。只有当前项目角色为 admin 或当前工作区角色为 admin 时显示管理列。失败就地使用 ErrorState。

- [ ] **Step 5: 运行前端和全量回归**

Run:
~~~bash
npm test
npm run lint
npm run typecheck
npm run test:backup
node --test scripts/monitoring/monitor.test.mjs
npm run delivery:verify
git diff --check
~~~

Expected: 全部退出码为 0。

- [ ] **Step 6: 同步服务器、运行集成测试并部署**

同步迁移、服务端源文件、测试和 Docker 交付文件到 /opt/dev-knowledge-hub，再执行：

~~~bash
docker compose -f /absolute/path/to/dev-knowledge-hub/docker-compose.yml -p dev-knowledge-hub --profile test run --rm --build integration
docker compose -f /absolute/path/to/dev-knowledge-hub/docker-compose.yml -p dev-knowledge-hub up -d --build app
docker compose -f /absolute/path/to/dev-knowledge-hub/docker-compose.yml -p dev-knowledge-hub ps
curl -fsS http://127.0.0.1:3000/api/health
~~~

Expected: integration 通过，app 与 postgres healthy，健康接口返回 status ok。

- [ ] **Step 7: 更新交接文档并提交**

将 AI_DEVELOPER_HANDOFF.md 中“项目级成员关系未实现”改为已实现，保留邀请邮件未实现的说明。

~~~bash
git add src/client/api/types.ts src/client/api/client.ts src/client/hooks/use-domain.ts src/client/pages/project-collaboration-page.tsx src/client/app.test.tsx docs/AI_DEVELOPER_HANDOFF.md
git commit -m "feat: manage project members"
~~~
