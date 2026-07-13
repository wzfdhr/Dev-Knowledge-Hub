# 本地文件夹导入实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在移动端可用的控制台中，让用户选择本地项目文件夹并在本地自动过滤后安全上传。

**Architecture:** 将路径、扩展名、敏感文件和生成文件判断提取为浏览器/Node 都能使用的纯 TypeScript 过滤器。浏览器扫描用户授权的目录，先显示报告，再用现有可续传 ZIP 导入链路传递保留文件；服务端继续以现有 ZIP 过滤器作为最终安全校验。

**Tech Stack:** React 19、Ant Design 5、TypeScript、Vitest、@zip.js/zip.js、Fastify 5。

## Global Constraints

- 移动端宽度 333px 时不显示固定桌面侧栏，内容必须完整可操作。
- 只读取用户明确选择的本地目录，线上服务器不能接收或解释任意本机绝对路径。
- 保留 `.ts`、`.tsx`、`.js`、`.jsx`、`.md`、`.json`、`.yaml`、`.yml` 及现有配置白名单。
- 忽略 `.git`、`node_modules`、`dist`、`build`、`coverage`、`.next`、敏感文件、生成文件、二进制和超过 1 MiB 的源文件。
- 目录最多 50,000 文件；传输继续使用 8 MiB 可续传分块和现有服务端安全限制。

---

### Task 1: 修正移动端应用框架

**Files:**
- Modify: `src/client/components/app-shell.tsx`
- Modify: `src/client/styles.css`
- Test: `src/client/app.test.tsx`

**Interfaces:**
- Produces: 移动端抽屉导航仅由 `.mobile-menu` 打开，桌面 `.sidebar` 在小于 760px 时不占据布局宽度。

- [ ] **Step 1: 写失败的移动端导航测试**

```tsx
test("exposes a mobile navigation trigger", () => {
  renderPage(<AppShell email="admin@example.com" onLogout={() => {}} />);
  expect(screen.getByRole("button", { name: "打开导航" })).toBeVisible();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/client/app.test.tsx`

- [ ] **Step 3: 调整框架和 CSS**

```css
@media (max-width: 760px) {
  .sidebar.ant-layout-sider { display: none; }
  .content.ant-layout-content { margin-left: 0; }
  .mobile-menu.ant-btn { display: inline-flex; }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- src/client/app.test.tsx`

- [ ] **Step 5: 提交**

Run: `git add src/client/components/app-shell.tsx src/client/styles.css src/client/app.test.tsx && git commit -m "fix: make console navigation responsive"`

### Task 2: 建立共享本地文件过滤器

**Files:**
- Create: `src/shared/import-filter.ts`
- Create: `src/shared/import-filter.test.ts`
- Modify: `src/server/uploads/zip-import.ts`

**Interfaces:**
- Produces: `filterImportFile(input): { accepted: boolean; reason?: ImportIgnoreReason }`。
- Consumes: `{ path: string; byteSize: number; content?: Uint8Array }`。

- [ ] **Step 1: 写失败的过滤器测试**

```ts
expect(filterImportFile({ path: "node_modules/react/index.js", byteSize: 12 })).toEqual({ accepted: false, reason: "excluded_directory" });
expect(filterImportFile({ path: "src/main.ts", byteSize: 12 })).toEqual({ accepted: true });
expect(filterImportFile({ path: ".env", byteSize: 12 })).toEqual({ accepted: false, reason: "sensitive_file" });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/shared/import-filter.test.ts`

- [ ] **Step 3: 实现纯过滤器并让 ZIP 导入复用它**

```ts
export function filterImportFile(input: ImportFilterInput): ImportFilterResult {
  if (hasExcludedDirectory(input.path)) return { accepted: false, reason: "excluded_directory" };
  if (isSensitivePath(input.path)) return { accepted: false, reason: "sensitive_file" };
  return isSupportedImportPath(input.path) ? { accepted: true } : { accepted: false, reason: "unsupported_extension" };
}
```

- [ ] **Step 4: 运行共享过滤器与 ZIP 导入测试**

Run: `npm test -- src/shared/import-filter.test.ts src/server/uploads/zip-import.test.ts`

- [ ] **Step 5: 提交**

Run: `git add src/shared/import-filter.ts src/shared/import-filter.test.ts src/server/uploads/zip-import.ts && git commit -m "feat: share project import filtering"`

### Task 3: 文件夹扫描、报告和可续传导入

**Files:**
- Create: `src/client/api/folder-import.ts`
- Create: `src/client/api/folder-import.test.ts`
- Modify: `src/client/pages/settings-page.tsx`
- Modify: `src/client/app.test.tsx`

**Interfaces:**
- Produces: `scanDirectory(handle): Promise<FolderImportReport>` 和 `uploadFolderImport(api, projectId, report, onProgress)`。
- Consumes: 浏览器 File System Access API 或目录文件选择回退。

- [ ] **Step 1: 写失败的扫描和报告测试**

```ts
const report = await scanDirectory(directoryHandle);
expect(report.acceptedFiles.map((file) => file.path)).toEqual(["src/main.ts"]);
expect(report.ignored.reasons).toEqual({ excluded_directory: 1, sensitive_file: 1 });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/client/api/folder-import.test.ts`

- [ ] **Step 3: 实现目录扫描和内存 ZIP 打包**

```ts
const writer = new ZipWriter(new BlobWriter("application/zip"));
for (const file of report.acceptedFiles) await writer.add(file.path, new BlobReader(file.blob));
const archive = await writer.close();
return uploadProjectZipResumably(api, projectId, new File([archive], "project.zip"), { onProgress });
```

- [ ] **Step 4: 在设置页加入“选择项目文件夹”与确认报告**

```tsx
<Button icon={<FolderOpen />} onClick={chooseFolder}>选择项目文件夹</Button>
<Descriptions items={reportItems} />
<Button type="primary" onClick={confirmFolderImport}>确认并上传已筛选文件</Button>
```

- [ ] **Step 5: 运行客户端测试与构建**

Run: `npm test -- src/client/api/folder-import.test.ts src/client/app.test.tsx && npm run build`

- [ ] **Step 6: 提交**

Run: `git add src/client/api/folder-import.ts src/client/api/folder-import.test.ts src/client/pages/settings-page.tsx src/client/app.test.tsx && git commit -m "feat: import filtered local project folders"`

### Task 4: 交付验证

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 记录文件夹导入、浏览器回退和 Codex 本地路径辅助使用方式**

```md
选择项目文件夹后先查看过滤报告；服务器只接收报告中的保留文件。远程部署无法读取电脑绝对路径。
```

- [ ] **Step 2: 全量验证**

Run: `npm run typecheck && npm test && npm run build && npm run secrets:scan`

- [ ] **Step 3: 提交并推送**

Run: `git add README.md && git commit -m "docs: explain local folder import" && git push origin main`
