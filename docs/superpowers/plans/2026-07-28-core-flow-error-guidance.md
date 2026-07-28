# 核心流程错误指引 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为资料接入、构建、发布和图谱提供可读、可展开并可安全重试的中文错误详情与自动弹窗。

**Architecture:** 以 `ApiError` 的 HTTP 状态和错误码为输入，先在无 React 依赖的错误字典中生成安全的 `CoreFlowErrorDescriptor`。一个共享组件同时渲染自动弹窗与页内错误详情卡；页面只负责将 mutation/query 错误、操作类别和可选重试回调接入该组件。

**Tech Stack:** React 19、TypeScript、Ant Design Modal/Button、TanStack Query、Vitest、Testing Library、Lucide。

## Global Constraints

- 界面、错误说明和操作文案均为中文。
- 绝不向用户显示数据库字段、堆栈、令牌、服务端绝对路径或原始 `5xx` message。
- 只覆盖资料接入、构建/草稿/发布、知识图谱和 React 前端地图；普通查询页面保持 `ErrorState`。
- `retryable` 必须由错误字典和页面实际可重试回调共同决定。
- 不新增数据库表、迁移或 API；不修改已发布知识、候选构建或上传资料。
- 所有新增行为先写测试并观察失败，再写最小实现。

---

### Task 1: 建立核心流程错误字典

**Files:**
- Create: `src/client/errors/core-flow-error.ts`
- Create: `src/client/errors/core-flow-error.test.ts`

**Interfaces:**
- Consumes: `ApiError` from `src/client/api/client.ts`。
- Produces: `CoreFlowOperation`, `CoreFlowErrorDescriptor` and `describeCoreFlowError(operation, error)` for pages and UI components.

- [ ] **Step 1: Write the failing test**

```ts
test("maps an upload 500 to safe Chinese guidance without leaking the server message", () => {
  const result = describeCoreFlowError(
    "upload",
    new ApiError(500, "REQUEST_FAILED", "null value in column source_kind")
  );
  expect(result).toMatchObject({
    title: "上传提交暂未完成",
    retryable: true,
    operationLabel: "资料接入"
  });
  expect(`${result.summary}${result.safety}${result.nextStep}`).not.toContain("source_kind");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/client/errors/core-flow-error.test.ts`

Expected: FAIL because `core-flow-error.ts` and `describeCoreFlowError` do not exist.

- [ ] **Step 3: Add the descriptor type and first upload mapping**

```ts
export type CoreFlowOperation = "upload" | "build" | "publish" | "graph";

export interface CoreFlowErrorDescriptor {
  operation: CoreFlowOperation;
  operationLabel: string;
  title: string;
  summary: string;
  safety: string;
  nextStep: string;
  retryable: boolean;
  diagnosticId: string;
}

export function describeCoreFlowError(operation: CoreFlowOperation, error: unknown): CoreFlowErrorDescriptor {
  // Map known ApiError codes first; for unknown server failures return safe generic copy.
}
```

- [ ] **Step 4: Add cases for rate limits, terminal upload sessions, build/publish permissions, invalid frontend candidates, network failures and unknown 5xx**

```ts
if (error instanceof ApiError && error.status === 429) {
  return { operation, operationLabel, title: "操作被暂时限流", summary: "服务正在保护当前任务。", safety, nextStep: "请等待片刻后再重试。", retryable: true, diagnosticId: error.code };
}
```

- [ ] **Step 5: Run the dictionary tests**

Run: `npx vitest run src/client/errors/core-flow-error.test.ts`

Expected: PASS; each operation has Chinese, non-empty safety and next-step copy, and raw server text is absent.

- [ ] **Step 6: Commit**

```bash
git add src/client/errors/core-flow-error.ts src/client/errors/core-flow-error.test.ts
git commit -m "feat(errors): describe core flow failures"
```

### Task 2: 实现共享错误详情卡与自动弹窗

**Files:**
- Create: `src/client/components/core-flow-error-dialog.tsx`
- Create: `src/client/components/core-flow-error-dialog.test.tsx`
- Modify: `src/client/styles.css`
- Modify: `src/client/responsive.css`

**Interfaces:**
- Consumes: `CoreFlowErrorDescriptor` from `src/client/errors/core-flow-error.ts` and an optional `onRetry(): void`.
- Produces: `CoreFlowErrorDialog` (automatic Modal) and `CoreFlowErrorCard` (persistent, expandable page card).

- [ ] **Step 1: Write the failing component test**

```tsx
render(<CoreFlowErrorDialog descriptor={descriptor} open onClose={close} onRetry={retry} />);
expect(screen.getByRole("dialog", { name: "上传提交暂未完成" })).toBeVisible();
expect(screen.getByText("数据安全")).toBeVisible();
await user.click(screen.getByRole("button", { name: "安全重试" }));
expect(retry).toHaveBeenCalledOnce();
```

- [ ] **Step 2: Run component test to verify it fails**

Run: `npx vitest run src/client/components/core-flow-error-dialog.test.tsx`

Expected: FAIL because the shared component does not exist.

- [ ] **Step 3: Implement the Modal with accessible actions**

```tsx
export function CoreFlowErrorDialog({ descriptor, open, onClose, onRetry }: Props) {
  return <Modal open={open} title={descriptor.title} onCancel={onClose} footer={/* retry only when descriptor.retryable && onRetry */}>
    <ErrorDetails descriptor={descriptor} />
  </Modal>;
}
```

- [ ] **Step 4: Implement `CoreFlowErrorCard` with details disclosure and diagnostic copy**

```tsx
<section className="core-flow-error-card" role="alert">
  <header><TriangleAlert aria-hidden="true" /><div><p>{descriptor.operationLabel} · 需要处理</p><h2>{descriptor.title}</h2></div></header>
  <details><summary>查看错误详情</summary><ErrorDetails descriptor={descriptor} /></details>
</section>
```

- [ ] **Step 5: Add responsive styles and test close/copy persistence**

Run: `npx vitest run src/client/components/core-flow-error-dialog.test.tsx`

Expected: PASS; close hides only the Modal, the card remains renderable, and a narrow viewport has no horizontal overflow.

- [ ] **Step 6: Commit**

```bash
git add src/client/components/core-flow-error-dialog.tsx src/client/components/core-flow-error-dialog.test.tsx src/client/styles.css src/client/responsive.css
git commit -m "feat(errors): add actionable error dialog and card"
```

### Task 3: 接入资料上传与版本工作台

**Files:**
- Modify: `src/client/pages/project-imports-page.tsx`
- Modify: `src/client/pages/project-imports-page.test.tsx`
- Modify: `src/client/pages/project-versions-page.tsx`
- Modify: `src/client/pages/project-versions-page.test.tsx`

**Interfaces:**
- Consumes: `describeCoreFlowError`, `CoreFlowErrorDialog`, `CoreFlowErrorCard`.
- Produces: upload, build, release-draft and publish mutation failures with automatic dialogs and retained card details.

- [ ] **Step 1: Write an upload failure test**

```tsx
api.uploadFolder = vi.fn(async () => {
  throw new ApiError(500, "REQUEST_FAILED", "internal database detail");
});
// After selecting the fixture directory and submitting:
expect(await screen.findByRole("dialog", { name: "上传提交暂未完成" })).toBeVisible();
expect(screen.getByText("诊断编号")).toBeVisible();
```

- [ ] **Step 2: Run upload test to verify it fails**

Run: `npx vitest run src/client/pages/project-imports-page.test.tsx`

Expected: FAIL because the page only renders `ErrorState`.

- [ ] **Step 3: Store the latest upload descriptor and expose a safe retry callback**

```tsx
const [uploadIssue, setUploadIssue] = useState<CoreFlowErrorDescriptor | null>(null);
const upload = useMutation({
  mutationFn: uploadFolder,
  onError: (error) => setUploadIssue(describeCoreFlowError("upload", error)),
  onSuccess: () => setUploadIssue(null)
});
```

- [ ] **Step 4: Add failing version-workbench tests for build and publish mutations**

```tsx
expect(await screen.findByRole("dialog", { name: "构建未完成" })).toBeVisible();
expect(screen.getByText("当前已发布知识不会变化")).toBeVisible();
```

- [ ] **Step 5: Wire build, draft and publish errors to the shared component**

```tsx
const descriptor = operationError ? describeCoreFlowError(operation, operationError) : null;
{descriptor && <CoreFlowErrorCard descriptor={descriptor} onRetry={retryOperation} />}
<CoreFlowErrorDialog descriptor={descriptor} open={Boolean(descriptor)} onClose={() => setOperationError(null)} onRetry={retryOperation} />
```

- [ ] **Step 6: Run page tests**

Run: `npx vitest run src/client/pages/project-imports-page.test.tsx src/client/pages/project-versions-page.test.tsx`

Expected: PASS; retry invokes only the originating mutation, terminal session errors omit retry, and successful mutation clears the visible card.

- [ ] **Step 7: Commit**

```bash
git add src/client/pages/project-imports-page.tsx src/client/pages/project-imports-page.test.tsx src/client/pages/project-versions-page.tsx src/client/pages/project-versions-page.test.tsx
git commit -m "feat(errors): guide upload and version failures"
```

### Task 4: 接入知识图谱与 React 前端地图

**Files:**
- Modify: `src/client/pages/project-graph-page.tsx`
- Modify: `src/client/pages/project-graph-page.test.tsx`
- Modify: `src/client/pages/project-frontend-map-page.tsx`
- Modify: `src/client/pages/project-frontend-map-page.test.tsx`

**Interfaces:**
- Consumes: `describeCoreFlowError("graph", error)` and shared error UI.
- Produces: graph and frontend map failures with safe explanatory dialogs, retained cards and existing refetch action where valid.

- [ ] **Step 1: Write failing graph query-error tests**

```tsx
expect(await screen.findByRole("dialog", { name: "图谱暂时不可用" })).toBeVisible();
expect(screen.getByText("当前已发布知识不会变化")).toBeVisible();
```

- [ ] **Step 2: Run graph tests to verify they fail**

Run: `npx vitest run src/client/pages/project-graph-page.test.tsx src/client/pages/project-frontend-map-page.test.tsx`

Expected: FAIL because graph pages only show `ErrorState` or a bespoke preview state.

- [ ] **Step 3: Preserve specialized frontend preview context while adding the shared error card/dialog**

```tsx
{preview.error && <>
  <PreviewState value={frontendPreviewErrorState(preview.error)} />
  <CoreFlowErrorCard descriptor={describeCoreFlowError("graph", preview.error)} onRetry={() => void preview.refetch()} />
  <CoreFlowErrorDialog /* same descriptor and callback */ />
</>}
```

- [ ] **Step 4: Wire normal graph query and export failures to descriptors**

```tsx
const graphIssue = graph.error ? describeCoreFlowError("graph", graph.error) : exportError ? describeCoreFlowError("graph", exportError) : null;
```

- [ ] **Step 5: Run graph tests**

Run: `npx vitest run src/client/pages/project-graph-page.test.tsx src/client/pages/project-frontend-map-page.test.tsx`

Expected: PASS; invalid frontend candidate remains explicitly identified, retry refetches only graph data, and error details do not expose raw backend text.

- [ ] **Step 6: Commit**

```bash
git add src/client/pages/project-graph-page.tsx src/client/pages/project-graph-page.test.tsx src/client/pages/project-frontend-map-page.tsx src/client/pages/project-frontend-map-page.test.tsx
git commit -m "feat(errors): guide graph failures"
```

### Task 5: 完整验证与交付

**Files:**
- Modify only if preceding verification exposes a scoped defect.

**Interfaces:**
- Consumes: completed error dictionary and page integration.
- Produces: verified, deployable core-flow error guidance.

- [ ] **Step 1: Run focused client tests**

Run: `npx vitest run src/client/errors/core-flow-error.test.ts src/client/components/core-flow-error-dialog.test.tsx src/client/pages/project-imports-page.test.tsx src/client/pages/project-versions-page.test.tsx src/client/pages/project-graph-page.test.tsx src/client/pages/project-frontend-map-page.test.tsx`

Expected: PASS with no test failures.

- [ ] **Step 2: Run static checks and production build**

Run: `npm run typecheck && npx eslint src/client/errors/core-flow-error.ts src/client/components/core-flow-error-dialog.tsx src/client/pages/project-imports-page.tsx src/client/pages/project-versions-page.tsx src/client/pages/project-graph-page.tsx src/client/pages/project-frontend-map-page.tsx && npm run build`

Expected: all commands exit 0; Vite may retain its existing chunk-size advisory but no build error.

- [ ] **Step 3: Manually verify keyboard and narrow layout in the browser**

Check: upload mutation failure opens dialog; Escape/close returns focus to trigger; page card persists; 390px viewport has no page-level horizontal scroll; retry does not claim an automatic publication.

- [ ] **Step 4: Commit any final scoped verification fixes**

```bash
git add <only-files-changed-by-verification>
git commit -m "test: verify core flow error guidance"
```

## Plan Self-Review

- Spec coverage: Tasks 1–4 cover the four agreed core flows, error dictionary, automatic prompt, retained details, safe retry, privacy and responsive accessibility. Task 5 verifies all acceptance requirements.
- Placeholder scan: all behavior, commands, types and expected outcomes are explicit; Task 5 permits edits only when a verification finding identifies a scoped defect.
- Type consistency: pages consume `CoreFlowErrorDescriptor`, `describeCoreFlowError`, `CoreFlowErrorDialog`, and `CoreFlowErrorCard` consistently across all tasks.
