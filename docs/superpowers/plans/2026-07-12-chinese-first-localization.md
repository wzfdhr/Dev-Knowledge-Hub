# Chinese-First Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Dev Knowledge Hub console and newly generated knowledge default to Simplified Chinese while preserving code and protocol identifiers.

**Architecture:** Keep API payloads, database values, URLs, MCP tool names, code symbols, paths, Commit SHA values, and Blob Hash values unchanged. Add a small client copy module for shared display mappings; translate page-local UX copy in place. Change deterministic knowledge templates and the optional AI enhancer instruction to Chinese so every new release has a Chinese baseline without modifying source citations.

**Tech Stack:** React 19, TypeScript, TanStack Query, Fastify, Vitest, Playwright.

## Global Constraints

- Product name remains `Dev Knowledge Hub`; supporting product copy is Simplified Chinese.
- Preserve `MCP`, `API`, `Token`, `Commit`, `Blob`, `Git`, `HTTPS`, `OpenAI`, and `Anthropic` as written.
- Preserve all source-derived identifiers: paths, symbols, commands, configuration keys, versions, SHA values, and citations.
- Keep service-side error codes, API values, MCP envelope fields, and database enums in English.
- Do not add an i18n runtime or language switcher in this MVP.
- New builds generate Chinese knowledge; existing immutable releases are not migrated.

---

### Task 1: Shared Client Copy and Entry Screens

**Files:**
- Create: `src/client/copy.ts`
- Modify: `src/client/components/ui.tsx`
- Modify: `src/client/components/app-shell.tsx`
- Modify: `src/client/app.tsx`
- Test: `src/client/app.test.tsx`

**Interfaces:**
- Produces `statusLabel(value: string): string` for UI-only display of build and feedback enum values.
- Produces `repositoryKindLabel(value: string): string` for UI-only display of `local` and `git`.
- Consumes no backend changes; later page tasks import these helpers instead of altering payload values.

- [ ] **Step 1: Write the failing UI tests**

Add a focused test that renders `AppShell` through `App` and expects the four Chinese navigation labels and Chinese loading/retry names:

```tsx
expect(await screen.findByRole("link", { name: "总览" })).toBeVisible();
expect(screen.getByRole("link", { name: "知识库" })).toBeVisible();
expect(screen.getByRole("link", { name: "反馈" })).toBeVisible();
expect(screen.getByRole("link", { name: "设置" })).toBeVisible();
expect(screen.getByRole("button", { name: "重试" })).toBeVisible();
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx vitest run src/client/app.test.tsx -t "renders Chinese console navigation"`

Expected: FAIL because the links currently render `Overview`, `Knowledge`, `Feedback`, and `Settings`.

- [ ] **Step 3: Add the shared display mapping and translate shared screens**

Create `src/client/copy.ts` with stable display-only mappings:

```ts
const labels: Record<string, string> = {
  queued: "排队中", syncing: "同步中", parsing: "解析中", synthesizing: "生成中",
  validating: "校验中", ready: "待审核", published: "已发布", failed: "失败",
  open: "待处理", acknowledged: "已确认", fixed: "已修复", dismissed: "已忽略",
  active: "有效", revoked: "已撤销", local: "本地路径", git: "Git HTTPS"
};
export const statusLabel = (value: string) => labels[value] ?? value;
export const repositoryKindLabel = (value: string) => labels[value] ?? value;
```

Use `statusLabel` in `Status`. Translate `Loading` to `加载中`, retry to `重试`, shell navigation to `总览`/`知识库`/`反馈`/`设置`, mobile labels to `打开导航`/`关闭导航`, and administrator/logout to `管理员`/`退出登录`. Translate `AuthScreen` setup/login headings, labels, password hint, buttons, and the left-hand onboarding copy to Chinese while retaining `Dev Knowledge Hub`.

- [ ] **Step 4: Run the focused UI tests to verify they pass**

Run: `npx vitest run src/client/app.test.tsx -t "renders Chinese console navigation"`

Expected: PASS with the Chinese labels and no API fixture changes.

- [ ] **Step 5: Commit the shared copy task**

```bash
git add src/client/copy.ts src/client/components/ui.tsx src/client/components/app-shell.tsx src/client/app.tsx src/client/app.test.tsx
git commit -m "feat: localize shared console copy"
```

### Task 2: Translate Operations Pages Without Changing Domain Values

**Files:**
- Modify: `src/client/pages/overview-page.tsx`
- Modify: `src/client/pages/knowledge-page.tsx`
- Modify: `src/client/pages/feedback-page.tsx`
- Modify: `src/client/pages/settings-page.tsx`
- Modify: `src/client/app.test.tsx`

**Interfaces:**
- Consumes `statusLabel` and `repositoryKindLabel` from `src/client/copy.ts`.
- Keeps `ApiClient` calls, query keys, status filter values, URL search parameters, and action payloads unchanged.
- Produces Chinese visible strings and Chinese accessible names for all page controls.

- [ ] **Step 1: Write failing page-level assertions**

Extend the existing app tests for a ready release, feedback, and settings data to assert translated labels and unchanged raw identifiers:

```tsx
expect(await screen.findByRole("heading", { name: "总览" })).toBeVisible();
expect(screen.getByRole("button", { name: "同步仓库" })).toBeVisible();
expect(screen.getByText(`Commit ${"a".repeat(12)}`)).toBeVisible();
expect(screen.getByRole("heading", { name: "知识库" })).toBeVisible();
expect(screen.getByRole("button", { name: "确认处理" })).toBeVisible();
expect(screen.getByRole("heading", { name: "设置" })).toBeVisible();
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npx vitest run src/client/app.test.tsx -t "renders Chinese operations copy"`

Expected: FAIL because headings and operations currently use English strings.

- [ ] **Step 3: Translate all static page copy and map display enums**

Apply these stable terms while leaving values passed to mutations unchanged:

```ts
// Overview: "总览", "同步仓库", "开始构建知识", "审核就绪构建", "发布版本"
// Knowledge: "知识库", "版本", "搜索符号、模块、路径...", "符号", "依赖关系", "页面", "来源代码"
// Feedback: "反馈", "确认处理", "忽略", "标记为已修复", "请求重新构建"
// Settings: "设置", "仓库", "模型服务商", "MCP 连接", "访问 Token"
```

Render `statusLabel(build.status)` and `statusLabel(feedback.status)` wherever a status is visible. Render `repositoryKindLabel(repository.kind)` in repository details. Keep `kind`, `status`, release IDs, source paths, source code, Commit, Blob, provider values, MCP endpoint, and token prefixes untouched. Translate all `aria-label`, empty/loading/error action copy, pagination copy, modal labels, and mobile navigation controls in these pages.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `npx vitest run src/client/app.test.tsx -t "renders Chinese operations copy"`

Expected: PASS; fixtures still supply English enum values and tests still locate the unchanged Commit prefix.

- [ ] **Step 5: Commit the page translation task**

```bash
git add src/client/pages/overview-page.tsx src/client/pages/knowledge-page.tsx src/client/pages/feedback-page.tsx src/client/pages/settings-page.tsx src/client/app.test.tsx
git commit -m "feat: translate knowledge operations pages"
```

### Task 3: Generate New Knowledge in Chinese

**Files:**
- Modify: `src/server/knowledge/generator.ts`
- Modify: `src/server/knowledge/enhancer.ts`
- Test: `src/server/knowledge/generator.test.ts`
- Test: `src/server/knowledge/build-service.test.ts`

**Interfaces:**
- Keeps `KnowledgePageDraft`, `KnowledgeChunk`, slugs, citation objects, and `KnowledgeEnhancer.enhance()` signatures unchanged.
- Produces Chinese titles/body labels for required, module, symbol, and feedback pages while interpolating raw code metadata as-is.

- [ ] **Step 1: Write failing generator and enhancer tests**

Add assertions that a deterministic output uses Chinese templates and preserves source metadata:

```ts
const output = await generateKnowledge(index);
const architecture = output.pages.find((page) => page.slug === "architecture-overview");
expect(architecture?.title).toBe("架构概览");
expect(architecture?.body).toContain("本快照包含");
expect(architecture?.body).toContain("src/math.ts");
```

Mock `generateText` and assert the enhancer system instruction includes `使用简体中文` and `不得翻译代码标识、文件路径、命令、Commit SHA、Blob Hash 或引用字段`.

- [ ] **Step 2: Run the focused generator tests to verify they fail**

Run: `npx vitest run src/server/knowledge/generator.test.ts src/server/knowledge/build-service.test.ts`

Expected: FAIL because titles such as `Architecture Overview` and the enhancer instruction are still English.

- [ ] **Step 3: Translate deterministic templates and constrain AI output**

Replace presentation labels only, for example:

```ts
"架构概览"
`# 架构概览\n\n本快照包含 ${modules.length} 个模块和 ${index.symbols.length} 个已索引符号。`
`# 模块：${module.path}\n\n## 符号`
`# ${symbol.name}\n\n- 类型：${symbol.kind}\n- 源码：${symbol.path}:${symbol.startLine}-${symbol.endLine}`
```

Use Chinese headings for conventions, run/test guide, dependency summary, missing-data fallbacks, and feedback rebuild context. Preserve `module.path`, `symbol.name`, `symbol.kind`, script names, edge endpoints, feedback IDs, feedback text, and citation strings exactly. Change the AI system prompt to require concise Simplified Chinese, preserve markdown headings/cited facts, and explicitly preserve technical identifiers.

- [ ] **Step 4: Run focused generator tests to verify they pass**

Run: `npx vitest run src/server/knowledge/generator.test.ts src/server/knowledge/build-service.test.ts`

Expected: PASS with valid immutable citations and unchanged slugs.

- [ ] **Step 5: Commit the knowledge language task**

```bash
git add src/server/knowledge/generator.ts src/server/knowledge/enhancer.ts src/server/knowledge/generator.test.ts src/server/knowledge/build-service.test.ts
git commit -m "feat: generate Chinese-first knowledge"
```

### Task 4: Verify the Chinese First-Run and Knowledge Workflow

**Files:**
- Modify: `tests/e2e/console.spec.ts`
- Modify: `src/client/app.test.tsx`

**Interfaces:**
- Consumes existing deterministic e2e server endpoints and the existing `ApiClient` contract.
- Produces browser-level evidence that Chinese labels work at desktop and mobile widths without changing the build/publish/feedback workflow.

- [ ] **Step 1: Write the failing E2E assertions**

Replace user-facing English locators with Chinese names and assert a generated required page is Chinese while source provenance remains raw:

```ts
await expect(page.getByRole("heading", { name: "创建管理员" })).toBeVisible();
await page.getByRole("button", { name: "创建工作区" }).click();
await expect(page.getByRole("heading", { name: "总览" })).toBeVisible();
await page.getByRole("link", { name: "知识库" }).click();
await expect(page.getByText("架构概览")).toBeVisible();
await expect(page.getByRole("complementary", { name: "来源代码" })).toContainText("Commit");
```

- [ ] **Step 2: Run Playwright to verify it fails**

Run: `npm run test:e2e`

Expected: FAIL because existing visible labels are English before Tasks 1-3 are implemented.

- [ ] **Step 3: Align remaining test fixtures and assertions with Chinese visible copy**

Keep source fixture names, version `1.0.0`, endpoint values, `dkh_` token prefix, English feedback query content, and API payloads unchanged. Update only browser-facing selectors, expected success/notice copy, and the Chinese page-title assertions.

- [ ] **Step 4: Run final verification**

Run these commands separately:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

Expected: all commands exit `0`; the existing PostgreSQL-gated integration tests remain explicitly skipped when `TEST_DATABASE_URL` is unset.

- [ ] **Step 5: Inspect the running console at desktop and mobile widths**

Open `http://127.0.0.1:5173`, complete the deterministic first-run flow, and inspect 1440px and 390px screenshots. Confirm Chinese labels fit their controls, navigation is readable, no horizontal overflow appears, and source file paths/Commit references remain unchanged.

- [ ] **Step 6: Commit the E2E translation coverage**

```bash
git add tests/e2e/console.spec.ts src/client/app.test.tsx
git commit -m "test: cover Chinese console workflow"
```
