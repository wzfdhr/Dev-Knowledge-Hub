# 上传可靠性与实时状态 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除大文件夹上传的同会话 429 边界竞争，并让上传过程实时呈现自动协调状态。

**Architecture:** 服务端维持全局和客户端并发上限，将同一会话缓冲请求上限提升至与客户端上限一致的 2。客户端扩展 `ImportProgress` 的可选协调信息；上传请求遇到 429 重试时通过同一进度回调通知页面，组件以非失败状态展示。

**Tech Stack:** TypeScript、React、Vitest、Fastify。

## Global Constraints

- 保留全局 4、单客户端 2 个上传请求上限。
- 429 自动重试仍最多 5 次，并保留 `Retry-After`。
- 不修改上传数据、发布知识或生产存储模式。
- 仅真实不可恢复错误进入上传失败状态。

---

### Task 1: 服务端同会话并发边界

**Files:**
- Modify: `src/server/security/http.ts:108-129`
- Test: `src/server/security/http.test.ts:63-75`

**Interfaces:**
- Produces: `UploadBodyConcurrencyState` 默认限制为 `{ global: 4, client: 2, session: 2 }`。

- [x] **Step 1: Write the failing test**

```ts
const state = new UploadBodyConcurrencyState();
expect(state.acquire("client", "session")).toEqual(expect.any(Function));
expect(state.acquire("client", "session")).toEqual(expect.any(Function));
expect(state.acquire("client", "session")).toBeNull();
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/server/security/http.test.ts`

Expected: failure because the default same-session limit remains 1.

- [x] **Step 3: Write minimal implementation**

```ts
constructor(private readonly limits = { global: 4, client: 2, session: 2 }) {}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/server/security/http.test.ts`

Expected: all HTTP security tests pass.

- [x] **Step 5: Commit**

```bash
git add src/server/security/http.ts src/server/security/http.test.ts
git commit -m "fix: avoid upload session concurrency races"
```

### Task 2: 客户端实时自动协调状态

**Files:**
- Modify: `src/client/api/types.ts:129-141`
- Modify: `src/client/api/client.ts:64-91, 242-356`
- Modify: `src/client/components/import-progress.tsx:41-86`
- Test: `src/client/api/client.test.ts:395-423`
- Test: `src/client/components/import-progress.test.tsx:24-31`

**Interfaces:**
- Produces: `ImportProgress.coordination?: { retryAfterSeconds: number; attempt: number }`.
- Consumes: `UploadFolderOptions.onProgress(progress)`.

- [x] **Step 1: Write failing tests**

```ts
expect(progress).toContainEqual(expect.objectContaining({
  detail: "正在自动协调上传，资料不会丢失",
  coordination: { retryAfterSeconds: 1, attempt: 1 }
}));
```

```tsx
render(<ImportProgress progress={{ phase: "uploading", status: "running", percent: 42,
  coordination: { retryAfterSeconds: 1, attempt: 1 } }} />);
expect(screen.getByText("正在自动协调上传，资料不会丢失")).toBeInTheDocument();
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/client/api/client.test.ts src/client/components/import-progress.test.tsx`

Expected: failure because neither progress type nor coordination UI exists.

- [x] **Step 3: Write minimal implementation**

```ts
coordination?: { retryAfterSeconds: number; attempt: number };
```

```ts
type RequestOptions = RequestInit & {
  onRateLimit?(input: { retryAfterSeconds: number; attempt: number }): void;
};

options.onRateLimit?.({ retryAfterSeconds: Math.ceil(delay / 1_000), attempt: rateLimitRetries + 1 });
```

`uploadFolderSession` passes `onRateLimit` for manifest, file and commit requests. Its callback emits the current counters plus `detail: "正在自动协调上传，资料不会丢失"`. `ImportProgress` renders that detail and `第 {attempt} 次协调，约 {retryAfterSeconds} 秒后继续` in its existing polite live region.

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run src/client/api/client.test.ts src/client/components/import-progress.test.tsx`

Expected: API and UI progress tests pass.

- [x] **Step 5: Commit**

```bash
git add src/client/api/types.ts src/client/api/client.ts src/client/components/import-progress.tsx src/client/api/client.test.ts src/client/components/import-progress.test.tsx
git commit -m "feat: show upload coordination progress"
```

### Task 3: 综合验证与部署

**Files:**
- Verify only: changed files above

- [x] **Step 1: Run focused quality checks**

Run: `npx eslint src/server/security/http.ts src/server/security/http.test.ts src/client/api/types.ts src/client/api/client.ts src/client/api/client.test.ts src/client/components/import-progress.tsx src/client/components/import-progress.test.tsx && npm run build && npm test && npm run test:runtime && npm run delivery:verify && git diff --check`

Expected: lint, build, tests, runtime validation, delivery validation and diff check pass.

- [ ] **Step 2: Deploy only after all checks pass**

Build the exact committed candidate, preserve `.env` and the Compose override, atomically update `/opt/dev-knowledge-hub`, recreate only `app` and `parser`, then verify local/public health and `shadow` modes.

- [ ] **Step 3: Confirm live behavior**

Verify two same-session `UploadBodyConcurrencyState` acquires are accepted by test; confirm production health and retain the seven-day observation state without resetting it because source-storage application semantics do not change.
