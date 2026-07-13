# Project Workbench Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有管理台改造成融合型项目工作台，拆出资料上传、知识版本、团队协作、Codex 接入和系统设置，并提供真实可恢复的六阶段上传进度。

**Architecture:** 使用 `/projects/:projectId/*` 嵌套路由承载项目上下文，客户端继续通过 `x-devkh-project` 作用域访问现有领域接口。上传扫描、打包和传输状态由纯领域函数统一计算，页面只负责展示。团队动态通过新的只读项目活动 API 从审计事件和真实成员数据中读取，不使用静态业务数据。

**Tech Stack:** React 19、React Router 7、TanStack Query、Ant Design 5、Lucide、Fastify 5、TypeScript、Vitest、Testing Library、Playwright、PostgreSQL。

## Global Constraints

- 保留 Ant Design 5，不引入第二套 UI 组件库。
- 全局设置只保留模型服务、安全、存储与备份；项目业务不得回到设置页。
- 上传阶段固定为：读取文件、安全过滤、本地压缩、分块上传、服务端校验、创建内容版本。
- 客户端过滤用于隐私和体验，服务端过滤仍是最终安全边界。
- 仅显示 API 或持久化层中的真实项目、版本、成员和活动数据。
- 1200 像素以下使用抽屉导航，760 像素以下使用单列和纵向上传步骤。
- 保留现有角色边界：管理员、成员、只读；服务端权限校验不可只依赖界面隐藏。
- 原参考仓库保持只读，所有修改只发生在独立仓库 `wzfdhr/Dev-Knowledge-Hub`。

---

## File Map

### New client files

- `src/client/components/project-layout.tsx`: 项目标题、项目级导航和路由上下文。
- `src/client/components/import-progress.tsx`: 六阶段进度、速度、剩余时间和恢复状态。
- `src/client/components/import-report.tsx`: 过滤结果和忽略原因。
- `src/client/components/project-activity.tsx`: 真实团队活动列表。
- `src/client/pages/project-imports-page.tsx`: 仓库连接、文件夹/ZIP 导入及导入状态。
- `src/client/pages/project-versions-page.tsx`: 构建、审核和发布。
- `src/client/pages/project-collaboration-page.tsx`: 项目成员与活动。
- `src/client/pages/project-codex-page.tsx`: 项目级 MCP 接入和 Token。
- `src/client/pages/system-settings-page.tsx`: 模型、安全和存储设置外壳。
- `src/client/workbench.css`: 融合型工作台和响应式样式。

### Modified client files

- `src/client/app.tsx`: 嵌套路由和旧 URL 兼容跳转。
- `src/client/components/app-shell.tsx`: 全局导航与可折叠侧栏。
- `src/client/pages/projects-page.tsx`: 团队摘要和项目状态表。
- `src/client/pages/overview-page.tsx`: 精简为项目概览。
- `src/client/pages/settings-page.tsx`: 拆分后删除，导出兼容跳转不保留业务代码。
- `src/client/api/client.ts`: 项目活动、Codex 接入和项目 Token API。
- `src/client/api/types.ts`: 项目活动、项目摘要和上传进度类型。
- `src/client/api/folder-import.ts`: 扫描与打包阶段回调。
- `src/client/api/resumable-upload.ts`: 传输速度、ETA、暂停和取消控制。
- `src/client/hooks/use-domain.ts`: 项目作用域 query keys。
- `src/client/main.tsx`: 导入 `workbench.css`。

### Server files

- `src/server/persistence/store.ts`: `AuditEventRecord.createdAt` 与项目活动查询接口。
- `src/server/persistence/memory-store.ts`: 内存活动查询。
- `src/server/persistence/postgres-store.ts`: PostgreSQL 项目活动查询。
- `src/server/app.ts`: `GET /api/projects/:projectId/activity`。
- `src/server/team-routes.test.ts`: 项目活动权限和隔离测试。
- `src/server/persistence/postgres-store.test.ts`: 活动映射测试。

### Test files

- `src/client/app.test.tsx`: 项目路由、页面拆分和角色可见性。
- `src/client/api/folder-import.test.ts`: 扫描和压缩阶段事件。
- `src/client/api/resumable-upload.test.ts`: 速度、ETA、暂停、恢复和取消。
- `tests/e2e/console.spec.ts`: 完整项目工作台流程。

---

### Task 1: Project-scoped routing and navigation

**Files:**
- Create: `src/client/components/project-layout.tsx`
- Modify: `src/client/app.tsx`
- Modify: `src/client/components/app-shell.tsx`
- Modify: `src/client/pages/projects-page.tsx`
- Test: `src/client/app.test.tsx`

**Interfaces:**
- Produces: project routes `/projects/:projectId/overview|imports|versions|collaboration|codex`.
- Produces: `ProjectLayout({ api }: { api: ApiClient })` and `useProjectContext()`.
- Preserves: legacy `/overview` redirects to the active project or `/projects`.

- [ ] **Step 1: Write failing routing tests**

Add tests that open a project and assert URL-scoped navigation:

```tsx
expect(await screen.findByRole("link", { name: "资料上传" })).toHaveAttribute(
  "href",
  "/projects/project-1/imports"
);
await user.click(screen.getByRole("link", { name: "团队协作" }));
expect(screen.getByRole("heading", { name: "团队协作" })).toBeVisible();
```

- [ ] **Step 2: Run the routing tests and verify failure**

Run: `npm test -- src/client/app.test.tsx`

Expected: FAIL because `ProjectLayout` and project child routes do not exist.

- [ ] **Step 3: Implement the project layout**

Use a single project context boundary:

```tsx
interface ProjectContextValue {
  project: Project;
  projectId: string;
}

export function ProjectLayout({ api }: { api: ApiClient }) {
  const { projectId = "" } = useParams();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.listProjects });
  const project = projects.data?.projects.find((item) => item.id === projectId);
  useEffect(() => {
    if (project) localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, project.id);
  }, [project]);
  if (projects.isLoading) return <Loading label="正在加载项目" />;
  if (!project) return <Navigate to="/projects" replace />;
  return <ProjectContext.Provider value={{ project, projectId }}>
    <header className="project-bar">{/* project identity and release context */}</header>
    <nav className="project-tabs" aria-label="项目导航">{/* five NavLinks */}</nav>
    <Outlet />
  </ProjectContext.Provider>;
}
```

Route children under `projects/:projectId` and change `openProject()` to navigate to `/projects/${project.id}/overview`.

- [ ] **Step 4: Preserve legacy links**

Add a small redirect component that reads `ACTIVE_PROJECT_STORAGE_KEY`; `/overview` and `/settings?connect=1` must resolve to the active project overview/imports page without dropping query intent.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- src/client/app.test.tsx && npm run typecheck`

Expected: PASS.

Commit: `git commit -m "feat: add project-scoped workbench routes"`

---

### Task 2: Upload phase and transfer metrics domain

**Files:**
- Modify: `src/client/api/folder-import.ts`
- Modify: `src/client/api/resumable-upload.ts`
- Modify: `src/client/api/types.ts`
- Test: `src/client/api/folder-import.test.ts`
- Test: `src/client/api/resumable-upload.test.ts`

**Interfaces:**
- Produces: `ImportPhase`, `ImportProgress`, `TransferSample`, `UploadController`.
- Produces: `scanDirectory(handle, options)` and `packageFolderImport(report, options)` callbacks.
- Preserves: existing `uploadProjectZipResumably()` call sites.

- [ ] **Step 1: Write failing progress math tests**

Define the sample used by the test:

```ts
export interface TransferSample {
  receivedBytes: number;
  at: number;
}
```

```ts
expect(calculateTransferProgress(
  { receivedBytes: 8, at: 1_000 },
  { receivedBytes: 12, totalBytes: 20, at: 3_000 }
)).toEqual({ bytesPerSecond: 2, estimatedSeconds: 4, percent: 60 });
```

Add tests proving pause blocks the next chunk, resume continues it, and cancel rejects with `UploadCancelledError` while preserving the resumable session key.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- src/client/api/folder-import.test.ts src/client/api/resumable-upload.test.ts`

Expected: FAIL because the progress types and controller do not exist.

- [ ] **Step 3: Add shared import progress types**

```ts
export type ImportPhase = "reading" | "filtering" | "packaging" | "uploading" | "validating" | "snapshot";
export type ImportRunStatus = "idle" | "running" | "paused" | "failed" | "completed" | "cancelled";
export interface ImportProgress {
  phase: ImportPhase;
  status: ImportRunStatus;
  percent: number;
  processedFiles?: number;
  totalFiles?: number;
  processedBytes?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  estimatedSeconds?: number;
  detail?: string;
}
```

- [ ] **Step 4: Emit scan and packaging progress**

Add options with exact signatures:

```ts
export interface FolderImportOptions {
  onProgress?(progress: ImportProgress): void;
}

export async function scanDirectory(
  handle: DirectoryDirectoryHandle,
  options: FolderImportOptions = {}
): Promise<FolderImportReport>;

export async function packageFolderImport(
  report: FolderImportReport,
  options: FolderImportOptions = {}
): Promise<File>;
```

Emit monotonically increasing file/byte counts. Packaging must use zip.js `onprogress` and never report 100% before `archive.close()` resolves.

- [ ] **Step 5: Add resumable transfer metrics and controller**

```ts
export interface UploadController {
  pause(): void;
  resume(): void;
  cancel(): void;
  readonly paused: boolean;
  readonly cancelled: boolean;
  waitUntilRunnable(): Promise<void>;
}
```

Check the controller between chunks. Cancellation stops local work but leaves the server session and storage key available for a later resume. Remove the key only after snapshot import succeeds.

- [ ] **Step 6: Run tests and commit**

Run: `npm test -- src/client/api/folder-import.test.ts src/client/api/resumable-upload.test.ts && npm run typecheck`

Expected: PASS.

Commit: `git commit -m "feat: model resumable import progress"`

---

### Task 3: Dedicated project imports page

**Files:**
- Create: `src/client/components/import-progress.tsx`
- Create: `src/client/components/import-report.tsx`
- Create: `src/client/pages/project-imports-page.tsx`
- Modify: `src/client/pages/settings-page.tsx`
- Modify: `src/client/app.tsx`
- Test: `src/client/app.test.tsx`

**Interfaces:**
- Consumes: `ImportProgress`, `FolderImportReport`, `UploadController` from Task 2.
- Produces: `ProjectImportsPage({ api }: { api: ApiClient })`.
- Produces: `ImportProgressView` with accessible status updates.

- [ ] **Step 1: Write failing imports-page tests**

Assert that the project imports page contains “选择项目文件夹”, “或上传 ZIP”, six ordered stages, and a filtering confirmation dialog. Assert that system settings no longer contains repository, ZIP, MCP, or Token controls.

```tsx
expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
  "读取文件", "安全过滤", "本地压缩", "分块上传", "服务端校验", "创建内容版本"
]);
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- src/client/app.test.tsx`

Expected: FAIL because project imports route is not implemented.

- [ ] **Step 3: Move repository and folder import code**

Move `ConnectionForm`, `FolderPicker`, `UploadForm`, ignored-reason labels and upload summary out of `settings-page.tsx`. Keep their API behavior unchanged while connecting progress callbacks to `ImportProgress` state.

- [ ] **Step 4: Implement the progress component**

```tsx
interface ImportProgressViewProps {
  progress: ImportProgress;
  compact: boolean;
  onPause(): void;
  onResume(): void;
  onCancel(): void;
}

const phaseItems = ["读取文件", "安全过滤", "本地压缩", "分块上传", "服务端校验", "创建内容版本"]
  .map((title) => ({ title }));
const phaseOrder: ImportPhase[] = ["reading", "filtering", "packaging", "uploading", "validating", "snapshot"];

export function ImportProgressView({ progress, compact, onPause, onResume, onCancel }: ImportProgressViewProps) {
  return <section aria-labelledby="import-progress-title">
    <Steps current={phaseOrder.indexOf(progress.phase)} direction={compact ? "vertical" : "horizontal"} items={phaseItems} />
    <Progress percent={Math.round(progress.percent)} status={progress.status === "failed" ? "exception" : "active"} />
    <p aria-live="polite">{progress.detail}</p>
    {/* render uploaded bytes, speed, ETA, and valid controls */}
  </section>;
}
```

- [ ] **Step 5: Implement the report and history states**

Render actual scan totals and ignored reasons before upload. Until a server import-history endpoint exists, display the current repository’s latest snapshot as “最近导入”; do not create fabricated historical rows.

- [ ] **Step 6: Run tests and commit**

Run: `npm test -- src/client/app.test.tsx src/client/api/folder-import.test.ts src/client/api/resumable-upload.test.ts && npm run typecheck`

Expected: PASS.

Commit: `git commit -m "feat: add project imports workspace"`

---

### Task 4: Knowledge versions and project overview split

**Files:**
- Create: `src/client/pages/project-versions-page.tsx`
- Modify: `src/client/pages/overview-page.tsx`
- Modify: `src/client/api/client.ts`
- Modify: `src/client/api/types.ts`
- Modify: `src/client/app.tsx`
- Modify: `src/client/hooks/use-domain.ts`
- Modify: `src/server/app.ts`
- Test: `src/server/repository-routes.test.ts`
- Test: `src/client/app.test.tsx`

**Interfaces:**
- Produces: `ProjectVersionsPage({ api })` owning build, draft, review and publish mutations.
- Produces: `ProjectOverviewPage` showing only current release, knowledge status, collaboration count, active task and recent changes.
- Produces: `GET /api/projects/:projectId/summary` for real project-center and overview data.

- [ ] **Step 1: Write failing ownership tests**

Assert build history and publish controls exist only on `/versions`, while overview contains links to upload, versions and feedback.

- [ ] **Step 2: Run test and verify failure**

Run: `npm test -- src/client/app.test.tsx`

Expected: FAIL because `OverviewPage` still owns the entire build workflow.

Rename its exported component to `ProjectOverviewPage` when splitting the workflow; update all imports in `app.tsx` and tests in the same task.

- [ ] **Step 3: Move build and release workflow**

Move `derivePrimaryAction`, SSE build tracking, draft creation, publishing, cancellation and build history to `ProjectVersionsPage`. Use project-qualified query keys:

```ts
export const keys = {
  builds: (projectId: string) => ["projects", projectId, "builds"] as const,
  releases: (projectId: string) => ["projects", projectId, "releases"] as const,
  repository: (projectId: string) => ["projects", projectId, "repository"] as const
};
```

- [ ] **Step 4: Add the project summary endpoint**

Return only persisted data:

```ts
export interface ProjectSummary {
  project: Project;
  repository: Repository | null;
  latestSnapshot: RepositoryStatus["latestSnapshot"];
  currentRelease: Release | null;
  latestBuild: Build | null;
  memberCount: number;
}
```

Implement `GET /api/projects/:projectId/summary` by resolving the project, its current repository, latest snapshot, current release, latest build and real workspace member count. A missing repository or release is represented by `null`, not a fabricated default.

- [ ] **Step 5: Build the compact overview**

Overview derives only real values from current release, latest build, latest snapshot and feedback queries. If symbol/page coverage is unavailable, label the metric “知识状态” instead of inventing a percentage.

- [ ] **Step 6: Run tests and commit**

Run: `npm test -- src/client/app.test.tsx && npm run typecheck`

Expected: PASS.

Commit: `git commit -m "feat: split project overview and versions"`

---

### Task 5: Project Codex page and clean system settings

**Files:**
- Create: `src/client/pages/project-codex-page.tsx`
- Create: `src/client/pages/system-settings-page.tsx`
- Modify: `src/client/api/client.ts`
- Modify: `src/client/api/types.ts`
- Modify: `src/client/app.tsx`
- Delete after migration: `src/client/pages/settings-page.tsx`
- Test: `src/client/app.test.tsx`
- Test: `src/client/api/client.test.ts`

**Interfaces:**
- Produces: `getProjectCodexConnection(projectId)`.
- Changes: `createMcpToken(name, projectId)` requires explicit project scope.
- Produces: project connection pack type with `configToml`, `agentsMd`, `environmentVariable` and endpoint.

- [ ] **Step 1: Write failing API and page tests**

```ts
await api.createMcpToken("Local Codex", "project-1");
expect(fetch).toHaveBeenCalledWith("/api/mcp/tokens", expect.objectContaining({
  body: JSON.stringify({ name: "Local Codex", projectId: "project-1" })
}));
```

Assert the Codex page shows connection state, config, `AGENTS.md`, token list and one-time secret dialog. Assert `/settings` contains only model, security and storage navigation.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- src/client/api/client.test.ts src/client/app.test.tsx`

Expected: FAIL on missing project Codex methods and routes.

- [ ] **Step 3: Implement explicit project API calls**

Use `/api/projects/${projectId}/codex-connection`; stop relying on “first active project” token defaults from the UI.

- [ ] **Step 4: Move MCP and model sections**

Move MCP connection and Token UI to `ProjectCodexPage`. Move `ModelForm` to `SystemSettingsPage`. Render security and storage sections as honest status surfaces derived from available runtime data; when no API exists, label them “尚未接入监控” and do not show invented values.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- src/client/api/client.test.ts src/client/app.test.tsx && npm run typecheck`

Expected: PASS.

Commit: `git commit -m "feat: separate codex and system settings"`

---

### Task 6: Real project activity and collaboration surface

**Files:**
- Modify: `src/server/persistence/store.ts`
- Modify: `src/server/persistence/memory-store.ts`
- Modify: `src/server/persistence/postgres-store.ts`
- Modify: `src/server/app.ts`
- Modify: `src/client/api/client.ts`
- Modify: `src/client/api/types.ts`
- Create: `src/client/components/project-activity.tsx`
- Create: `src/client/pages/project-collaboration-page.tsx`
- Test: `src/server/team-routes.test.ts`
- Test: `src/server/persistence/postgres-store.test.ts`
- Test: `src/client/app.test.tsx`

**Interfaces:**
- Produces: `listProjectActivity(workspaceId, projectId, pagination)`.
- Produces: `countProjectActivity(workspaceId, projectId)`.
- Produces: `GET /api/projects/:projectId/activity?limit=20&offset=0`.
- Produces: `{ activity: ProjectActivity[]; members: TeamMember[]; total: number; nextOffset: number | null }`.

- [ ] **Step 1: Write failing isolation tests**

Create two projects and repositories, record audit events against each repository, then assert project A’s endpoint never returns project B activity. Reader can read activity; only administrator can create members.

```ts
expect(response.json().activity).toEqual([
  expect.objectContaining({ action: "repository.sync_succeeded", projectId: projectA.id })
]);
```

- [ ] **Step 2: Run server tests and verify failure**

Run: `npm test -- src/server/team-routes.test.ts src/server/persistence/postgres-store.test.ts`

Expected: FAIL because audit events cannot be listed.

- [ ] **Step 3: Add audit timestamps and store query**

```ts
export interface AuditEventRecord extends AuditEventInput {
  id: string;
  createdAt: Date;
}

listProjectActivity(
  workspaceId: string,
  projectId: string,
  pagination?: Pagination
): Promise<AuditEventRecord[]>;

countProjectActivity(workspaceId: string, projectId: string): Promise<number>;
```

PostgreSQL query must match either `resource_type = 'project' AND resource_id = projectId`, or repository resources joined through `repositories.project_id`. Token events may join through `mcp_tokens.project_id`. Order by `created_at DESC, id DESC`.

When build, release or feedback routes already know the current project, include `metadata.projectId` in their audit event so those actions appear without cross-project ambiguity.

- [ ] **Step 4: Implement route DTOs**

Resolve actor email from `admin_users` or in-memory members. Return action keys and metadata, not preformatted HTML. Unknown actions use a neutral Chinese fallback in the client.

- [ ] **Step 5: Build collaboration UI**

Show actual workspace members with their current global role and explicitly label it “团队角色”. Do not imply project-specific permission assignment until a `project_members` persistence model is implemented. Activity rows display actor, translated action, target and relative time.

- [ ] **Step 6: Run tests and commit**

Run: `npm test -- src/server/team-routes.test.ts src/server/persistence/postgres-store.test.ts src/client/app.test.tsx && npm run typecheck`

Expected: PASS.

Commit: `git commit -m "feat: expose project collaboration activity"`

---

### Task 7: Project center and fusion visual system

**Files:**
- Create: `src/client/workbench.css`
- Modify: `src/client/main.tsx`
- Modify: `src/client/components/app-shell.tsx`
- Modify: `src/client/pages/projects-page.tsx`
- Modify: `src/client/responsive.css`
- Test: `src/client/app.test.tsx`

**Interfaces:**
- Produces: reusable classes `project-bar`, `project-tabs`, `workbench-grid`, `summary-strip`, `activity-list`, `import-stage-list`.
- Preserves: Ant Design tokens and existing status semantics.

- [ ] **Step 1: Write structural responsive tests**

Assert project table exposes project name, release/status, members, latest import and open action. Assert mobile navigation and project tab controls have accessible names.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- src/client/app.test.tsx`

Expected: FAIL on missing columns and labels.

- [ ] **Step 3: Implement fusion styles**

Use a 244 px expanded sider above 1200 px, drawer below 1200 px, 48-56 px project bar, 6 px radii, 14 px body text and restrained shadows. Do not add nested cards; use full-width sections with dividers and tables for repeated items.

- [ ] **Step 4: Improve project center with real data**

Call the explicit project summary endpoint from Task 4 for each visible project. Show `-` or “暂无发布” for missing release/storage/member values; do not calculate invented coverage. Keep one primary action per row.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- src/client/app.test.tsx && npm run typecheck && npm run lint && npm run build`

Expected: PASS; Vite may retain the existing bundle-size warning but must exit 0.

Commit: `git commit -m "style: apply fusion project workbench"`

---

### Task 8: End-to-end acceptance and documentation

**Files:**
- Modify: `tests/e2e/console.spec.ts`
- Modify: `README.md`
- Modify: `docs/operations.md` if present; otherwise create `docs/project-workbench.md`

**Interfaces:**
- Verifies: project creation, folder/ZIP import, progress, build, release, collaboration and Codex configuration.

- [ ] **Step 1: Add the end-to-end workbench scenario**

The scenario must:

1. Create or select a project.
2. Open “资料上传”.
3. Upload a ZIP fixture and observe “分块上传” then completion.
4. Start a build from “知识版本”.
5. Publish and confirm current release.
6. Open “团队协作” and see the real upload/build activity.
7. Open “Codex 接入” and create a project-scoped Token.

- [ ] **Step 2: Run E2E at desktop and mobile widths**

Run: `npm run test:e2e`

Expected: PASS with no horizontal overflow at 1440x1024 and 390x844.

- [ ] **Step 3: Update usage documentation**

Document the new flow: 项目中心 → 项目概览 → 资料上传 → 知识版本 → Codex 接入. State that folder scanning filters locally and server validation runs again.

- [ ] **Step 4: Run the release gate**

Run:

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm run test:e2e
git diff --check
```

Expected: all commands exit 0. Record any intentionally skipped PostgreSQL integration tests separately.

- [ ] **Step 5: Secret scan and final commit**

Run:

```bash
rg -n --hidden --glob '!.git/**' --glob '!node_modules/**' --glob '!dist/**' '(AKIA[0-9A-Z]{16}|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,})' .
```

Expected: no matches.

Commit: `git commit -m "test: cover project workbench flow"`

---

## Implementation Checkpoints

- Checkpoint 1 after Tasks 1-3: project navigation and real upload progress are usable.
- Checkpoint 2 after Tasks 4-6: versions, Codex and collaboration are fully separated.
- Checkpoint 3 after Tasks 7-8: visual polish, responsive behavior and end-to-end acceptance are complete.
