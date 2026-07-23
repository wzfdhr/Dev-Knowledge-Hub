# Project Imports Compact Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the project imports page as a compact administration workspace with inline source switching, contextual progress, and a first-screen import history table while preserving every existing upload and publication safety contract.

**Architecture:** Keep `ProjectImportsPage` as the state and API orchestration boundary, and extract focused presentational components for source selection and import history. Reuse the existing upload scanner, mutations, query invalidation, reports, and progress value contract; change only client composition, styling, and tests.

**Tech Stack:** React 19, TypeScript 6, Ant Design 5, Lucide React, TanStack Query 5, Vitest 4, Testing Library, Playwright 1.61, CSS.

## Global Constraints

- Do not modify server routes, database schema, upload session semantics, source replacement semantics, or publication behavior.
- Source mode changes are local UI state; no API request occurs until the user submits a source form or chooses and confirms a folder.
- Upload still requires local filtering followed by explicit confirmation; it never builds or publishes automatically.
- Preserve the existing safe retry messages for temporary interruption and invalid/expired upload sessions.
- Use existing Ant Design and Lucide dependencies; add no new runtime dependency.
- Keep cards at `7px` radius or less and use no decorative gradient/grid background in the upload workspace.
- At widths `320px`, `390px`, `768px`, and `1280px`, text and controls must not overlap and the page must not have document-level horizontal overflow.
- The history table may scroll horizontally inside its own bounded container on mobile.
- Do not stage or commit unrelated local files (`vite.config.ts`, `vite.config.test.ts`, `data/`) as part of these tasks.

---

## File Structure

- Create `src/client/components/import-source-switcher.tsx`: controlled source tabs and the three inline source configuration views.
- Create `src/client/components/import-source-switcher.test.tsx`: source switching, submit boundaries, current source summary, and credential behavior.
- Create `src/client/components/import-history.tsx`: loading, error, empty, and tabular import history states.
- Create `src/client/components/import-history.test.tsx`: semantic table and isolated retry behavior.
- Create `src/client/components/import-progress.test.tsx`: compact idle/running/failed/completed progress contracts.
- Modify `src/client/components/import-progress.tsx`: contextual compact progress rendering.
- Modify `src/client/pages/project-imports-page.tsx`: orchestrate the extracted components, remove the modal, preserve mutations and upload flow.
- Modify `src/client/app.test.tsx`: page-level source switching, replacement, upload confirmation, retry, and integration regression coverage.
- Modify `src/client/responsive.css`: compact workspace, inline source forms, safety strip, contextual progress, history table, and mobile rules.
- Modify `tests/e2e/console.spec.ts`: desktop/mobile imports-page overflow and visibility assertions plus screenshots.

---

### Task 1: Inline Source Switcher

**Files:**
- Create: `src/client/components/import-source-switcher.tsx`
- Create: `src/client/components/import-source-switcher.test.tsx`

**Interfaces:**
- Consumes: `Repository` from `src/client/api/types.ts`, Ant Design `Button` and `Segmented`, Lucide `FolderOpen`, `GitBranch`, `HardDriveUpload`, and `Server`.
- Produces: `ImportSourceKind = Repository["kind"]` and `ImportSourceSwitcher(props: ImportSourceSwitcherProps)`.

Use this public contract:

```tsx
export type ImportSourceKind = Repository["kind"];

export interface ImportSourceSwitcherProps {
  value: ImportSourceKind;
  currentRepository: Repository | null;
  location: string;
  token: string;
  pending: boolean;
  errorMessage?: string;
  onChange(value: ImportSourceKind): void;
  onLocationChange(value: string): void;
  onTokenChange(value: string): void;
  onChooseFolder(): void;
  onSubmitAlternative(): void;
}
```

- [x] **Step 1: Write the failing source-switching tests**

Create `src/client/components/import-source-switcher.test.tsx` with real interactions:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

import { ImportSourceSwitcher, type ImportSourceKind } from "./import-source-switcher";

function renderSwitcher(value: ImportSourceKind = "upload") {
  const props = {
    value,
    currentRepository: null,
    location: "",
    token: "",
    pending: false,
    onChange: vi.fn(),
    onLocationChange: vi.fn(),
    onTokenChange: vi.fn(),
    onChooseFolder: vi.fn(),
    onSubmitAlternative: vi.fn()
  };
  return { ...render(<ImportSourceSwitcher {...props} />), props };
}

describe("ImportSourceSwitcher", () => {
  test("switches source views without submitting a source", async () => {
    const user = userEvent.setup();
    const { props } = renderSwitcher();
    await user.click(screen.getByText("Git HTTPS", { selector: ".ant-segmented-item-label" }));
    expect(props.onChange).toHaveBeenCalledWith("git");
    expect(props.onSubmitAlternative).not.toHaveBeenCalled();
  });

  test("renders the folder action and safety contract", async () => {
    const user = userEvent.setup();
    const { props } = renderSwitcher("upload");
    expect(screen.getByText("本机预过滤")).toBeVisible();
    expect(screen.getByText("上传不会自动改变正式知识")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "选择项目文件夹" }));
    expect(props.onChooseFolder).toHaveBeenCalledTimes(1);
  });

  test("renders Git credentials and submits only from the explicit button", async () => {
    const user = userEvent.setup();
    const { props } = renderSwitcher("git");
    expect(screen.getByLabelText("个人访问 Token（可选）")).toHaveAttribute("type", "password");
    fireEvent.change(screen.getByLabelText("HTTPS URL"), { target: { value: "https://github.com/acme/web.git" } });
    expect(props.onLocationChange).toHaveBeenLastCalledWith("https://github.com/acme/web.git");
    expect(props.onSubmitAlternative).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "连接 Git 仓库" }));
    expect(props.onSubmitAlternative).toHaveBeenCalledTimes(1);
  });

  test("shows the connected source with text, not color alone", () => {
    render(<ImportSourceSwitcher
      value="local"
      currentRepository={{ id: "r1", projectId: "p1", kind: "local", name: "Production source", path: "/srv/app", defaultBranch: "local" }}
      location="/srv/app"
      token=""
      pending={false}
      onChange={vi.fn()}
      onLocationChange={vi.fn()}
      onTokenChange={vi.fn()}
      onChooseFolder={vi.fn()}
      onSubmitAlternative={vi.fn()}
    />);
    expect(screen.getByText("当前来源：Production source")).toBeVisible();
    expect(screen.getByLabelText("服务器绝对路径")).toBeVisible();
  });
});
```

- [x] **Step 2: Run the component test and verify RED**

Run:

```bash
npx vitest run src/client/components/import-source-switcher.test.tsx
```

Expected: FAIL because `./import-source-switcher` does not exist.

- [x] **Step 3: Implement the controlled source switcher**

Create `src/client/components/import-source-switcher.tsx`. The component must:

```tsx
const options = [
  { value: "upload", label: "项目文件夹", icon: <HardDriveUpload aria-hidden="true" /> },
  { value: "git", label: "Git HTTPS", icon: <GitBranch aria-hidden="true" /> },
  { value: "local", label: "服务器路径", icon: <Server aria-hidden="true" /> }
];

const submitLabel = value === "git" ? "连接 Git 仓库" : "连接服务器目录";
```

Render a `.import-source-toolbar` containing `Segmented`, followed by `.import-source-panel`.

The toolbar must render `当前来源：${currentRepository?.name ?? "尚未连接"}` so the source state is understandable without color.

For `upload`, render `.import-folder-action` with the folder icon, one concise paragraph, the primary folder button, and this exact `.import-safety-strip` copy:

```tsx
<div className="import-safety-strip" aria-label="上传安全边界">
  <span><strong>本机预过滤</strong>敏感内容不离开电脑</span>
  <span><strong>50,000 个文件</strong>单次源码上限</span>
  <span><strong>2 GiB</strong>可采集源码上限</span>
  <span><strong>手动发布</strong>上传不会自动改变正式知识</span>
</div>
```

For `git` and `local`, render a semantic `<form>` that calls `event.preventDefault()` and `onSubmitAlternative()`. Preserve the exact labels and placeholders already used by `ProjectImportsPage`. Render `errorMessage` inside an Ant Design `Alert` or the existing `ErrorState` directly below the fields. Keep the submitted values fully controlled by props.

- [x] **Step 4: Run the component tests and verify GREEN**

Run:

```bash
npx vitest run src/client/components/import-source-switcher.test.tsx
```

Expected: 4 tests PASS with no React warnings.

- [x] **Step 5: Typecheck the new component contract**

Run:

```bash
npm run typecheck
```

Expected: exit code `0`.

- [x] **Step 6: Commit Task 1**

```bash
git add src/client/components/import-source-switcher.tsx src/client/components/import-source-switcher.test.tsx
git commit -m "feat(imports): add inline source switcher"
```

---

### Task 2: Contextual Progress and Import History

**Files:**
- Modify: `src/client/components/import-progress.tsx:33-70`
- Create: `src/client/components/import-progress.test.tsx`
- Create: `src/client/components/import-history.tsx`
- Create: `src/client/components/import-history.test.tsx`

**Interfaces:**
- Consumes: `ImportProgress` and `ImportReport` from `src/client/api/types.ts`.
- Produces: unchanged `ImportProgress({ progress }: { progress: ImportProgressValue | null })` and `ImportHistory(props: ImportHistoryProps)`.

Use this history contract:

```tsx
export interface ImportHistoryProps {
  reports: ImportReport[];
  loading: boolean;
  error?: unknown;
  onRetry(): void;
}
```

- [x] **Step 1: Write failing progress-state tests**

Create `src/client/components/import-progress.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { ImportProgress } from "./import-progress";

describe("ImportProgress", () => {
  test("uses a compact idle hint instead of the full stage panel", () => {
    const { container } = render(<ImportProgress progress={{ phase: "reading", status: "idle", percent: 0 }} />);
    expect(screen.getByText("选择资料来源后开始导入")).toBeVisible();
    expect(container.querySelector(".import-stage-list")).not.toBeInTheDocument();
  });

  test("shows running phase, percentage, transfer, rate, and ETA", () => {
    render(<ImportProgress progress={{ phase: "uploading", status: "running", percent: 42, processedFiles: 42, totalFiles: 100, processedBytes: 1024, totalBytes: 4096, bytesPerSecond: 2048, estimatedSeconds: 18, detail: "正在上传" }} />);
    expect(screen.getByText("文件夹直传")).toBeVisible();
    expect(screen.getByText("42%")).toBeVisible();
    expect(screen.getByText(/42\/100 个文件/)).toBeVisible();
    expect(screen.getByText(/2 KB\/s/)).toBeVisible();
    expect(screen.getByText(/约 18 秒/)).toBeVisible();
  });

  test("marks a failed run as an alert", () => {
    render(<ImportProgress progress={{ phase: "validating", status: "failed", percent: 80, detail: "服务端校验失败" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("服务端校验失败");
  });
});
```

- [x] **Step 2: Write failing history tests**

Create `src/client/components/import-history.test.tsx` with these cases:

```tsx
test("renders a semantic recent import table", () => {
  render(<ImportHistory loading={false} onRetry={vi.fn()} reports={[{
    id: "i1", projectId: "p1", repositoryId: "r1", sourceKind: "upload", status: "succeeded",
    startedAt: "2026-07-22T05:48:00.000Z", finishedAt: "2026-07-22T05:49:00.000Z",
    collectedFileCount: 1284, collectedTextBytes: 18 * 1024 * 1024,
    ignored: { total: 326, reasons: {} }, snapshotId: "s1", failureCode: null
  }]} />);
  expect(screen.getByRole("table", { name: "最近导入" })).toBeVisible();
  expect(screen.getByRole("columnheader", { name: "来源" })).toBeVisible();
  expect(screen.getByText("项目文件夹")).toBeVisible();
  expect(screen.getByText("1,284 个文件 · 18.0 MB")).toBeVisible();
  expect(screen.getByText("326 项")).toBeVisible();
  expect(screen.getByText("成功")).toBeVisible();
});

test("isolates a history query failure behind its own retry", async () => {
  const user = userEvent.setup();
  const retry = vi.fn();
  render(<ImportHistory loading={false} reports={[]} error={new Error("history failed")} onRetry={retry} />);
  await user.click(screen.getByRole("button", { name: "重试" }));
  expect(retry).toHaveBeenCalledTimes(1);
});

test("renders a compact empty state", () => {
  render(<ImportHistory loading={false} reports={[]} onRetry={vi.fn()} />);
  expect(screen.getByText("暂无导入记录")).toBeVisible();
});
```

- [x] **Step 3: Run both tests and verify RED**

Run:

```bash
npx vitest run src/client/components/import-progress.test.tsx src/client/components/import-history.test.tsx
```

Expected: FAIL because history does not exist and progress still renders the full idle stage list.

- [x] **Step 4: Implement compact progress states**

Modify `ImportProgress` so `progress === null` or `progress.status === "idle"` returns:

```tsx
<section className="import-progress-idle" aria-label="导入状态">
  <Circle aria-hidden="true" />
  <span><strong>选择资料来源后开始导入</strong>扫描、过滤和上传进度会显示在这里。</span>
</section>
```

For non-idle states, render `.import-progress-compact` with:

- `role="alert"` only when `status === "failed"`.
- The current stage label and exact percentage text.
- A single Ant Design `Progress` bar.
- A compact `.import-stage-track` containing all five labels and active/complete classes.
- Existing transfer/rate/ETA formatting and `aria-live="polite"`.

- [x] **Step 5: Implement the history component**

Create `ImportHistory` with a `<section aria-labelledby="import-history-title">`, an overflow wrapper, and semantic table:

```tsx
<table aria-label="最近导入">
  <thead><tr><th>来源</th><th>时间</th><th>采集内容</th><th>自动忽略</th><th>状态</th></tr></thead>
  <tbody>{reports.map(/* map ImportReport without changing its data */)}</tbody>
</table>
```

Map source labels as `upload -> 项目文件夹`, `git -> Git HTTPS`, `local -> 服务器路径`. Map statuses as `succeeded -> 成功`, `failed -> 失败`, `running -> 进行中`, `cancelled -> 已取消`. Put `failureCode` below the failed status when present. Reuse `formatBytes` from `import-report.tsx`.

- [x] **Step 6: Run tests and verify GREEN**

Run:

```bash
npx vitest run src/client/components/import-progress.test.tsx src/client/components/import-history.test.tsx
```

Expected: all progress and history tests PASS.

- [x] **Step 7: Commit Task 2**

```bash
git add src/client/components/import-progress.tsx src/client/components/import-progress.test.tsx src/client/components/import-history.tsx src/client/components/import-history.test.tsx
git commit -m "feat(imports): compact progress and history"
```

---

### Task 3: Integrate the Compact Workspace

**Files:**
- Modify: `src/client/pages/project-imports-page.tsx:1-205`
- Modify: `src/client/app.test.tsx:1217-1330`

**Interfaces:**
- Consumes: `ImportSourceSwitcher`, `ImportSourceKind`, `ImportHistory`, existing `ImportProgress`, `FolderFilterReport`, and `ImportResultReport`.
- Produces: unchanged `ProjectImportsPage({ api, projectId })` public component.

- [x] **Step 1: Add a failing page-level inline source test**

Add to the existing `describe("repository replacement")` block in `src/client/app.test.tsx`:

```tsx
test("configures every source inline and only submits the selected source", async () => {
  const user = userEvent.setup();
  const connectRepository = vi.fn().mockResolvedValue({ repository: {
    id: "git", projectId: "project", kind: "git", name: "项目仓库", url: "https://github.com/acme/web.git", defaultBranch: "main"
  }});
  const api = {
    getRepository: vi.fn().mockResolvedValue({ repository: null }),
    listImportReports: vi.fn().mockResolvedValue({ reports: [], total: 0, limit: 20, offset: 0 }),
    connectRepository
  } as unknown as ApiClient;

  renderPage(<ProjectImportsPage api={api} projectId="project" />);
  await user.click(await screen.findByText("Git HTTPS", { selector: ".ant-segmented-item-label" }));
  expect(connectRepository).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText("HTTPS URL"), "https://github.com/acme/web.git");
  await user.click(screen.getByRole("button", { name: "连接 Git 仓库" }));
  await waitFor(() => expect(connectRepository).toHaveBeenCalledWith({
    kind: "git", name: "项目仓库", url: "https://github.com/acme/web.git"
  }));
  expect(screen.queryByRole("dialog", { name: "更换资料来源" })).not.toBeInTheDocument();
});
```

Change the existing replacement test to switch to the required source inline, submit it, and verify the existing read-only-history copy without opening a modal.

- [x] **Step 2: Run the focused page tests and verify RED**

Run:

```bash
npx vitest run src/client/app.test.tsx -t "repository replacement"
```

Expected: FAIL because Git and local forms still live in the modal.

- [x] **Step 3: Replace modal composition with the inline workspace**

In `ProjectImportsPage`:

1. Remove `Modal`, `Tag`, `FolderOpen`, `GitBranch`, `HardDriveUpload`, `Server`, `replaceOpen`, and modal JSX imports/state that are no longer needed.
2. Import the two new components.
3. Keep the hidden folder `<input>` and all `scanDirectory`, `scanSelectedFiles`, `ensureUploadSource`, `upload`, `rememberSnapshot`, and `uploadFailure` logic unchanged.
4. Add this synchronization so a loaded or newly connected source becomes the selected tab:

```tsx
useEffect(() => {
  if (currentRepository) setSourceKind(currentRepository.kind);
}, [currentRepository?.id, currentRepository?.kind]);
```

5. Change `connectAlternative.onSuccess` to update query data and preserve the connected mode:

```tsx
onSuccess: (value) => {
  setLocation("");
  setToken("");
  setSourceKind(value.repository.kind);
  queryClient.setQueryData(projectKeys.repository(projectId), { repository: value.repository });
  void queryClient.invalidateQueries({ queryKey: ["import-reports", projectId] });
}
```

6. Render this order inside `.project-imports-workspace`:

```tsx
<ImportSourceSwitcher ... />
<ImportProgress progress={progress} />
{report && <div className="import-report-row">...</div>}
{result && <ImportResultReport ... />}
{upload.error && <ErrorState ... />}
<ImportHistory
  reports={importHistory.data?.reports ?? []}
  loading={importHistory.isLoading}
  error={importHistory.error}
  onRetry={() => void importHistory.refetch()}
/>
```

7. Shorten the page header paragraph to: `管理项目资料来源并创建可追溯的内容版本。`

- [x] **Step 4: Preserve replacement and upload regression tests**

Update only selectors affected by the new composition. Keep all assertions proving:

- Replacing a non-upload source uses `uploadReplacementFolder` after folder confirmation.
- Temporary upload failures retain safe retry copy and reuse the connected upload repository.
- Invalidated sessions require re-selection.
- Successful upload writes `devkh:last-snapshot`, reports local/server filtering, and never publishes.

- [x] **Step 5: Run integration tests and verify GREEN**

Run:

```bash
npx vitest run src/client/app.test.tsx src/client/components/import-source-switcher.test.tsx src/client/components/import-history.test.tsx src/client/components/import-progress.test.tsx
```

Expected: all tests PASS with no unhandled query or React state warnings.

- [x] **Step 6: Commit Task 3**

```bash
git add src/client/pages/project-imports-page.tsx src/client/app.test.tsx
git commit -m "feat(imports): integrate compact source workspace"
```

---

### Task 4: Responsive Styling and Browser Acceptance

**Files:**
- Modify: `src/client/responsive.css:121-510`
- Modify: `tests/e2e/console.spec.ts:24-57`

**Interfaces:**
- Consumes: class names established by Tasks 1-3.
- Produces: stable desktop/mobile layout with scoped horizontal history scrolling.

- [x] **Step 1: Add failing E2E layout assertions before styling**

Immediately after navigating to `资料上传` in `tests/e2e/console.spec.ts`, add the empty-workspace assertions:

```ts
await expect(page.getByRole("heading", { name: "资料上传" })).toBeVisible();
await expect(page.getByText("当前来源：", { exact: false })).toBeVisible();
await expect(page.getByRole("button", { name: "选择项目文件夹" })).toBeVisible();
await expect(page.getByText("暂无导入记录")).toBeVisible();
```

Immediately after `内容版本已就绪` becomes visible, assert the populated history and run the viewport checks:

```ts
await expect(page.getByRole("table", { name: "最近导入" })).toBeVisible();

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 768, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 700 }
]) {
  await page.setViewportSize(viewport);
  const documentOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(documentOverflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole("button", { name: "选择项目文件夹" })).toBeVisible();
  await page.screenshot({ path: `test-results/imports-${viewport.width}x${viewport.height}.png`, fullPage: true });
}
await page.setViewportSize({ width: 1440, height: 1024 });
```

- [x] **Step 2: Run the focused E2E test and verify RED**

Run:

```bash
npx playwright test tests/e2e/console.spec.ts --grep "folder import"
```

Expected: FAIL on the inline source/table/layout contract before CSS and integration are complete.

- [x] **Step 3: Replace legacy imports CSS with the compact workspace styles**

In `src/client/responsive.css`, remove obsolete rules for:

- `.import-workspace` two-column idle layout.
- `.import-dropzone` grid background and `390px` minimum height.
- `.source-options` and modal-only source form spacing.
- Vertical `.import-stage-list` sizing that forces an always-large progress panel.

Add stable rules for:

```css
.import-source-toolbar { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:10px; }
.import-source-switcher { min-width:0; flex:1; }
.import-current-source { display:flex; align-items:center; gap:7px; color:var(--muted); font-size:12px; white-space:nowrap; }
.import-source-panel { border:1px solid var(--border); border-radius:7px; background:var(--surface); }
.import-folder-action { display:grid; grid-template-columns:52px minmax(0,1fr) auto; align-items:center; gap:16px; padding:20px; border-style:dashed; }
.import-safety-strip { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); margin-top:10px; border:1px solid var(--border); border-radius:6px; background:#fff; }
.import-progress-compact { margin-top:10px; padding:14px 16px; border-left:3px solid var(--blue); border-radius:6px; background:#f2f7fd; }
.import-history-table-wrap { overflow-x:auto; border:1px solid var(--border); border-radius:7px; background:#fff; }
.import-history-table { min-width:680px; }
```

Use the existing palette plus green success and red failure tokens. Do not add gradients, oversized cards, more than `7px` radius, or font sizes based on viewport width.

- [x] **Step 4: Add mobile rules**

At `max-width: 760px`:

```css
.import-source-toolbar { align-items:stretch; flex-direction:column; }
.import-source-switcher .ant-segmented-group { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); }
.import-folder-action { grid-template-columns:42px minmax(0,1fr); padding:16px; }
.import-folder-action .ant-btn { grid-column:1/-1; width:100%; }
.import-safety-strip { grid-template-columns:1fr 1fr; }
.import-progress-heading,.import-progress-meta { align-items:flex-start; flex-direction:column; }
.import-history-table-wrap { max-width:100%; }
```

At `max-width: 420px`, reduce source-tab internal padding and ensure labels wrap without reducing font size below `10px`.

- [x] **Step 5: Run browser acceptance and inspect screenshots**

Run:

```bash
npx playwright test tests/e2e/console.spec.ts --grep "folder import"
```

Expected: PASS and write four nonblank imports screenshots. Inspect each screenshot for text overlap, hidden controls, nested-card appearance, and page-level overflow.

- [x] **Step 6: Run the complete client verification gate**

Run:

```bash
npm run typecheck
npm run lint
npx vitest run src/client
npm run build
```

Expected: every command exits `0`; Vitest reports zero failed files/tests; build emits the Vite client and TypeScript server output.

- [x] **Step 7: Review the final diff scope**

Run:

```bash
git diff --check
git status --short
git diff --stat 897fd87..HEAD
```

Expected: no whitespace errors; only the planned client files, tests, and docs are part of the feature commits. `vite.config.ts`, `vite.config.test.ts`, and `data/` remain outside this feature's staged scope.

- [x] **Step 8: Commit Task 4**

```bash
git add src/client/responsive.css tests/e2e/console.spec.ts
git commit -m "feat(imports): polish responsive compact workspace"
```

---

## Final Acceptance Checklist

- [x] Source tabs switch inline without a network request.
- [x] Git and server paths submit only from explicit commands.
- [x] Folder selection still filters locally and requires confirmation.
- [x] Existing replacement and resumable-upload behavior remains green.
- [x] Idle progress is compact; running, failed, and completed states remain legible and trustworthy.
- [x] Recent imports use a semantic table with an isolated loading/error/empty state.
- [x] Desktop and mobile screenshots match the approved compact administration direction.
- [x] No document-level horizontal overflow at `320`, `390`, `768`, or `1280` pixels.
- [x] Typecheck, lint, client Vitest, build, and focused Playwright pass.
