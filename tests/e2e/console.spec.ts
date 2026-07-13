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

  const projectRow = page.getByRole("row").filter({ hasText: "默认项目" });
  await projectRow.getByRole("button", { name: /切换|打开/ }).click();
  await expect(page.getByRole("heading", { name: "项目概览" })).toBeVisible();
  const projectId = new URL(page.url()).pathname.split("/")[2];
  expect(projectId).toBeTruthy();

  await page.getByRole("link", { name: "资料上传" }).click();
  await expect(page.getByRole("heading", { name: "选择完整项目文件夹" })).toBeVisible();
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
  await expect(report).toContainText("准备上传3");
  await expect(report).toContainText("自动忽略2");
  await expect(report).toContainText("依赖或构建目录1");
  await expect(report).toContainText("敏感文件1");
  await page.getByRole("button", { name: "确认并开始上传" }).click();
  await expect(page.getByRole("heading", { name: "内容版本已就绪" })).toBeVisible({ timeout: 30_000 });

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
  await expect(page.getByText("团队角色")).toBeVisible();
  await expect(page.getByText("创建了 Codex Token")).toBeVisible();

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
  await expect(page.getByText("3 个文件")).toBeVisible();
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
  await page.getByRole("button", { name: "打开导航" }).click();
  await expect(page.getByRole("link", { name: "项目中心" }).last()).toBeVisible();
  const overflow320 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow320).toBeLessThanOrEqual(0);
  await expect(page.getByRole("heading", { name: "项目概览" })).toBeVisible();
  expect(consoleErrors.filter((message) =>
    message.startsWith("Warning:") || message.includes("same key")
  )).toEqual([]);
});
