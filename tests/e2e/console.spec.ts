import { expect, test } from "@playwright/test";

test("folder import, project release, Codex, and collaboration workflow", async ({ page, request }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "创建管理员" })).toBeVisible();
  await page.getByLabel("邮箱").fill("admin@example.com");
  await page.getByLabel("密码").fill("correct horse battery staple");
  await page.getByRole("button", { name: "创建工作区" }).click();
  await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
  await page.getByLabel("邮箱").fill("admin@example.com");
  await page.getByLabel("密码").fill("correct horse battery staple");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "项目中心" })).toBeVisible();

  const projectRow = page.locator(".project-directory-row").filter({ hasText: "默认项目" });
  await projectRow.getByRole("button", { name: /切换|打开/ }).click();
  await expect(page.getByRole("heading", { name: "项目概览" })).toBeVisible();
  const projectId = new URL(page.url()).pathname.split("/")[2];
  expect(projectId).toBeTruthy();

  await page.getByRole("link", { name: "资料上传" }).click();
  await expect(page.getByRole("heading", { name: "资料上传" })).toBeVisible();
  await expect(page.getByText("当前来源：", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "选择项目文件夹" })).toBeVisible();
  await expect(page.getByText("暂无导入记录")).toBeVisible();

  const repositorySubmissions: string[] = [];
  const trackRepositorySubmissions = (request: { method(): string; url(): string }) => {
    if (request.method() === "POST" && request.url().includes("/repositories")) repositorySubmissions.push(request.url());
  };
  page.on("request", trackRepositorySubmissions);
  await page.getByText("Git HTTPS", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "HTTPS URL" })).toBeVisible();
  expect(repositorySubmissions).toEqual([]);
  page.off("request", trackRepositorySubmissions);
  await page.getByText("项目文件夹", { exact: true }).click();

  const folderInput = page.locator('input[type="file"][multiple]');
  await folderInput.evaluate((input) => {
    const selected = [
      { name: "math.ts", path: "sample/src/math.ts", content: "export function add(a: number, b: number) { return a + b }" },
      { name: "math.test.ts", path: "sample/tests/math.test.ts", content: "import { add } from '../src/math'; test('adds', () => expect(add(1, 2)).toBe(3))" },
      { name: "README.md", path: "sample/README.md", content: "# Sample project\n\nRun tests with npm test." },
      { name: "bundle.js", path: "sample/node_modules/pkg/bundle.js", content: "generated dependency" },
      { name: ".env", path: "sample/.env", content: "SECRET=must-not-upload" }
    ];
    const transfer = new DataTransfer();
    for (const item of selected) {
      const file = new File([item.content], item.name, { type: "text/plain" });
      Object.defineProperty(file, "webkitRelativePath", { value: item.path });
      transfer.items.add(file);
    }
    (input as HTMLInputElement).files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  const report = page.getByRole("region", { name: "过滤报告" });
  await expect(report).toBeVisible();
  await expect(report).toContainText("扫描文件5");
  await expect(report).toContainText("源码上传3");
  await expect(report).toContainText("资源登记0");
  await expect(report).toContainText("自动忽略2");
  await expect(report).toContainText("依赖或构建目录1");
  await expect(report).toContainText("敏感文件1");
  await page.getByRole("button", { name: "确认并开始上传" }).click();
  await expect(page.getByRole("heading", { name: "内容版本已就绪" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("table", { name: "最近导入" })).toBeVisible();

  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 768, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 700 }
  ]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      offenders: [...document.querySelectorAll("body *")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName, className: element.className, left: rect.left, right: rect.right, width: rect.width };
      }).filter((rect) => rect.right > document.documentElement.clientWidth + 0.5 || rect.left < -0.5).slice(0, 10)
    }));
    expect(layout.overflow, JSON.stringify(layout.offenders)).toBeLessThanOrEqual(0);
    await expect(page.getByRole("button", { name: "选择项目文件夹" })).toBeVisible();
    if (viewport.width <= 390) {
      const historyLayout = await page.locator(".import-history-overflow").evaluate((element) => {
        element.scrollLeft = Math.min(48, element.scrollWidth - element.clientWidth);
        return {
          clientWidth: element.clientWidth,
          overflowX: getComputedStyle(element).overflowX,
          scrollLeft: element.scrollLeft,
          scrollWidth: element.scrollWidth
        };
      });
      expect(historyLayout.scrollWidth).toBeGreaterThan(historyLayout.clientWidth);
      expect(historyLayout.scrollLeft).toBeGreaterThan(0);
      expect(historyLayout.overflowX).toBe("auto");
    }
    await page.screenshot({ path: `test-results/imports-${viewport.width}x${viewport.height}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1024 });

  await page.getByRole("link", { name: "知识版本" }).click();
  await page.getByRole("button", { name: "开始构建知识" }).click();
  await expect(page.getByRole("button", { name: "审核就绪构建" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "审核就绪构建" }).click();
  await page.getByRole("textbox", { name: "版本", exact: true }).fill("1.0.0");
  await page.getByRole("button", { name: "查看知识" }).click();

  const pageButton = page.locator(".page-tree button").first();
  await expect(pageButton).toBeVisible();
  await pageButton.click();
  const citation = page.locator(".citations button").first();
  await expect(citation).toBeVisible();
  await citation.click();
  await expect(page.getByRole("complementary", { name: "来源代码" })).toContainText("Commit");

  await page.goto(`/projects/${projectId}/versions`);
  await page.getByRole("button", { name: "发布版本" }).click();
  await expect(page.getByText("1.0.0").first()).toBeVisible();

  const graphFixture = await request.post("/__test__/graph");
  expect(graphFixture.ok()).toBeTruthy();

  await page.goto(`/projects/${projectId}/graph`);
  await expect(page.getByRole("heading", { name: "知识图谱" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "搜索图谱" })).toBeVisible();
  const graphNodes = page.locator(".knowledge-graph-node-list button");
  await expect(graphNodes.first()).toBeVisible();
  await graphNodes.first().click();
  await expect(page.getByRole("complementary", { name: "图谱详情" })).toContainText(/路径|可信度/);
  await page.screenshot({ path: "test-results/graph-1440x1024.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${projectId}/graph`);
  await expect(page.getByRole("heading", { name: "知识图谱" })).toBeVisible();
  const graphOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(graphOverflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "test-results/graph-390x844.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto(`/projects/${projectId}/versions`);

  const releaseBeforeShadow = await page.evaluate(async (activeProjectId) => {
    const response = await fetch("/api/releases/current", {
      headers: { "x-devkh-project": activeProjectId }
    });
    return (await response.json()).release.id as string;
  }, projectId);

  const shadowFailure = await request.post("/__test__/parser-unavailable-shadow");
  expect(shadowFailure.ok()).toBeTruthy();
  const shadowFailureBody = await shadowFailure.json();
  expect(shadowFailureBody.releaseIdBefore).toBe(releaseBeforeShadow);
  expect(shadowFailureBody.releaseIdAfter).toBe(releaseBeforeShadow);
  const failedPreview = await page.evaluate(async (activeProjectId) => {
    const response = await fetch(`/api/projects/${activeProjectId}/frontend-preview`);
    return response.json();
  }, projectId);
  expect(failedPreview).toMatchObject({
    status: "candidate_failed", failedStage: { stage: "extract", errorCode: "PARSER_RUNTIME_UNAVAILABLE" }
  });
  await page.reload();
  const shadowPanel = page.getByRole("region", { name: "影子验证状态" });
  await expect(shadowPanel).toContainText("影子验证发现问题");
  await expect(shadowPanel).toContainText("PARSER_RUNTIME_UNAVAILABLE");
  await expect(shadowPanel).toContainText("正式版本保持不变");
  await expect(page.getByText("1.0.0").first()).toBeVisible();
  await expect(page.getByText("构建失败", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "test-results/shadow-failure-1440x1024.png", fullPage: true });

  const releaseAfterShadow = await page.evaluate(async (activeProjectId) => {
    const response = await fetch("/api/releases/current", {
      headers: { "x-devkh-project": activeProjectId }
    });
    return (await response.json()).release.id as string;
  }, projectId);
  expect(releaseAfterShadow).toBe(releaseBeforeShadow);

  const frontendShadow = await request.post("/__test__/frontend-shadow");
  expect(frontendShadow.ok()).toBeTruthy();
  const frontendShadowBody = await frontendShadow.json();
  expect(frontendShadowBody).toMatchObject({ stageCount: 10, releaseIdBefore: releaseBeforeShadow, releaseIdAfter: releaseBeforeShadow });
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto(`/projects/${projectId}/frontend-map`);
  await expect(page.getByRole("heading", { name: "React 前端地图" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "候选包可供验收" })).toBeVisible();
  const frontendSearch = await page.evaluate(async (activeProjectId) => {
    const response = await fetch(`/api/projects/${activeProjectId}/frontend-preview/search?q=DashboardPage`);
    return { status: response.status, body: await response.json() };
  }, projectId);
  expect(frontendSearch.status).toBe(200);
  expect(frontendSearch.body.results[0]).toMatchObject({ entityKey: "component:DashboardPage" });
  await expect(page.getByRole("region", { name: "新旧内核只读比较" })).toContainText("引用有效");
  const impact = page.getByRole("region", { name: "变更影响与建议测试" });
  await expect(impact).toContainText("src/app.tsx");
  await expect(impact).toContainText("src/app.test.tsx");
  await page.getByRole("tab", { name: "路由与页面" }).click();
  await expect(page.getByText("DashboardPage").first()).toBeVisible();
  await page.getByRole("tab", { name: "状态与数据" }).click();
  await expect(page.getByText("loadDashboard").first()).toBeVisible();
  await expect(page.getByText(/requests · loadDashboard/).first()).toBeVisible();
  await page.getByRole("tab", { name: "可视化" }).click();
  await expect(page.getByText("DashboardChart").first()).toBeVisible();
  const sourceButton = page.getByRole("button", { name: /src\/chart\.tsx 第/ }).first();
  await sourceButton.click();
  await expect(page.getByRole("complementary", { name: "候选构建来源代码" })).toContainText("echarts.init");
  await page.screenshot({ path: "test-results/frontend-map-1440x1024.png", fullPage: true });

  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 700 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/projects/${projectId}/frontend-map`);
    await expect(page.getByRole("heading", { name: "React 前端地图" })).toBeVisible();
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      offenders: [...document.querySelectorAll("body *")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName, className: element.className, parentClassName: element.parentElement?.className, text: element.textContent?.trim().slice(0, 40), left: rect.left, right: rect.right, width: rect.width };
      }).filter((rect) => rect.right > document.documentElement.clientWidth + 0.5 || rect.left < -0.5).slice(0, 10),
      internalOverflow: [...document.querySelectorAll("body *")].map((element) => ({
        tag: element.tagName, className: element.className, text: element.textContent?.trim().slice(0, 30),
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        overflowX: getComputedStyle(element).overflowX
      })).filter((item) => item.scrollWidth > item.clientWidth + 1).slice(0, 15)
    }));
    expect(layout.overflow, JSON.stringify({ offenders: layout.offenders, internalOverflow: layout.internalOverflow })).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `test-results/frontend-map-${viewport.width}x${viewport.height}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto(`/projects/${projectId}/knowledge`);
  await expect(page.getByRole("heading", { name: "知识库", level: 1 })).toBeVisible();
  await expect(page.getByText("版本 1.0.0", { exact: true })).toBeVisible();
  const retainedKnowledgePage = page.locator(".page-tree button").first();
  await expect(retainedKnowledgePage).toBeVisible();
  const retainedKnowledgeTitle = await retainedKnowledgePage.innerText();
  await retainedKnowledgePage.click();
  await expect(page.locator(".knowledge-document")).toContainText(retainedKnowledgeTitle);

  await page.goto(`/projects/${projectId}/codex`);
  await expect(page.getByRole("heading", { name: "Codex 接入" })).toBeVisible();
  await page.getByLabel("Token 名称").fill("Playwright agent");
  await page.getByRole("button", { name: "创建 Token" }).click();
  const dialog = page.getByRole("dialog", { name: "已创建项目 Token" });
  await expect(dialog).toContainText("dkh_");
  await dialog.getByRole("button", { name: "我已保存" }).click();
  await expect(page.locator(".codex-token-list")).toContainText("Playwright agent");

  await page.goto(`/projects/${projectId}/collaboration`);
  await expect(page.getByRole("heading", { name: "团队协作" })).toBeVisible();
  await expect(page.locator(".member-list-heading")).toContainText("成员项目角色加入时间操作");
  const adminMemberRow = page.locator(".member-row").filter({ hasText: "admin@example.com" });
  await expect(adminMemberRow).toHaveCount(1);
  await expect(adminMemberRow.getByRole("columnheader")).toHaveCount(0);
  await expect(page.getByText("创建了 Codex Token")).toBeVisible();

  await page.goto("/members");
  await page.getByRole("button", { name: "添加成员" }).click();
  const createMemberPanel = page.locator(".members-page .panel");
  await expect(createMemberPanel.getByLabel("邮箱")).toHaveAttribute("autocomplete", "off");
  await expect(createMemberPanel.getByLabel("初始密码")).toHaveAttribute("autocomplete", "new-password");
  await page.screenshot({ path: "test-results/member-creation-1440x1024.png", fullPage: true });
  await createMemberPanel.getByLabel("邮箱").fill("collaborator@example.com");
  await createMemberPanel.getByLabel("初始密码").fill("correct horse battery staple");
  await createMemberPanel.getByRole("button", { name: "创建成员" }).click();
  await expect(page.locator(".workspace-member-list .member-row").filter({ hasText: "collaborator@example.com" })).toHaveCount(1);

  await page.goto(`/projects/${projectId}/collaboration`);
  await page.getByRole("button", { name: "添加成员" }).click();
  const addMemberDialog = page.getByRole("dialog", { name: "添加项目成员" });
  await addMemberDialog.getByRole("combobox", { name: "选择工作区成员" }).click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option").filter({ hasText: "collaborator@example.com" }).click();
  await addMemberDialog.getByRole("button", { name: "加入项目" }).click();
  const collaboratorRow = page.locator(".member-row").filter({ hasText: "collaborator@example.com" });
  await expect(collaboratorRow).toContainText("只读");
  await collaboratorRow.getByRole("button", { name: "调整角色" }).click();
  const roleDialog = page.getByRole("dialog", { name: "调整项目角色" });
  await roleDialog.locator(".ant-select").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option").filter({ hasText: "成员" }).click();
  await roleDialog.getByRole("button", { name: /保\s*存/ }).click();
  await expect(roleDialog).toBeHidden();
  await expect(collaboratorRow).toContainText("成员");
  await page.screenshot({ path: "test-results/collaboration-members-1440x1024.png", fullPage: true });
  await collaboratorRow.getByRole("button", { name: "移除" }).click();
  const removeDialog = page.getByRole("dialog", { name: "移除项目成员" });
  await removeDialog.getByRole("button", { name: /移\s*除/ }).click();
  await expect(collaboratorRow).toHaveCount(0);

  const seeded = await request.post("/__test__/feedback");
  expect(seeded.ok()).toBeTruthy();
  const releaseBefore = await page.evaluate(async () => {
    const response = await fetch("/api/releases/current");
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<{ release: { id: string } }>;
  });
  await page.getByRole("link", { name: "反馈" }).click();
  await page.getByRole("button", { name: "How do I deploy the service?" }).click();
  await page.getByRole("button", { name: "确认处理", exact: true }).click();
  await expect(page.getByRole("button", { name: "请求重新构建" })).toBeVisible();
  await page.getByRole("button", { name: "请求重新构建" }).click();
  await expect(page.getByText("已请求重新构建，审核前不会发布。")).toBeVisible();
  const releaseAfter = await page.evaluate(async () => {
    const response = await fetch("/api/releases/current");
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<{ release: { id: string } }>;
  });
  expect(releaseAfter.release.id).toBe(releaseBefore.release.id);

  await page.goto("/projects");
  await expect(page.getByText("1.0.0").first()).toBeVisible();
  await expect(page.getByText("14 个文件")).toBeVisible();
  const activeNavigationStyle = await page.getByRole("link", { name: "项目中心" }).first().evaluate((link) => {
    const style = getComputedStyle(link);
    return { backgroundColor: style.backgroundColor, boxShadow: style.boxShadow };
  });
  expect(activeNavigationStyle).toEqual({ backgroundColor: "rgba(0, 0, 0, 0)", boxShadow: "none" });
  expect(await page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([1440, 1024]);
  await page.screenshot({ path: "test-results/projects-1440x1024.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${projectId}/collaboration`);
  await expect(page.locator(".sidebar")).not.toBeInViewport();
  await expect(page.getByRole("heading", { name: "团队协作" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "test-results/collaboration-390x844.png", fullPage: true });

  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto(`/projects/${projectId}/overview`);
  const navigationButton = page.getByRole("button", { name: "打开导航" });
  await navigationButton.focus();
  await expect(navigationButton).toBeFocused();
  await navigationButton.press("Enter");
  await expect(page.getByRole("link", { name: "项目中心" }).last()).toBeVisible();
  const overflow320 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow320).toBeLessThanOrEqual(0);
  await expect(page.getByRole("heading", { name: "项目概览" })).toBeVisible();
  expect(consoleErrors.filter((message) =>
    message.startsWith("Warning:") || message.includes("same key")
  )).toEqual([]);
});
