import { expect, test } from "@playwright/test";

test("setup, build, cite, publish, token, and feedback rebuild", async ({ page, request }) => {
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
  await expect(page.getByRole("heading", { name: "总览" })).toBeVisible();

  const fixture = await (await request.get("/__test__/fixture")).json() as { path: string };
  await page.getByRole("button", { name: "连接仓库" }).click();
  await expect(page.getByRole("link", { name: "暂时跳过" })).toBeVisible();
  await page.getByLabel("仓库名称").fill("Code intelligence fixture");
  await page.getByLabel("本地路径").fill(fixture.path);
  await page.getByRole("button", { name: "连接仓库" }).click();
  await expect(page.getByText("Code intelligence fixture")).toBeVisible();
  await page.getByRole("link", { name: "总览" }).click();
  await page.getByRole("button", { name: "同步仓库" }).click();
  await expect(page.getByRole("button", { name: "开始构建知识" })).toBeVisible();
  await page.getByRole("button", { name: "开始构建知识" }).click();
  await expect(page.getByRole("button", { name: "审核就绪构建" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "审核就绪构建" }).click();
  await page.getByRole("textbox", { name: "版本", exact: true }).fill("1.0.0");
  await page.getByRole("button", { name: "创建版本草稿" }).click();

  await page.getByRole("link", { name: "知识库" }).click();
  const pageButton = page.locator(".page-tree button").first();
  await expect(pageButton).toBeVisible();
  await pageButton.click();
  const citation = page.locator(".citations button").first();
  await expect(citation).toBeVisible();
  await citation.click();
  await expect(page.getByRole("complementary", { name: "来源代码" })).toContainText("Commit");

  await page.getByRole("link", { name: "总览" }).click();
  await page.getByRole("button", { name: "发布版本" }).click();
  await expect(page.getByText("1.0.0")).toBeVisible();
  expect(await page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([1440, 1024]);
  await page.screenshot({ path: "test-results/overview-1440x1024.png" });

  await page.getByRole("link", { name: "设置" }).click();
  await page.getByLabel("Token 名称").fill("Playwright agent");
  await page.getByRole("button", { name: "创建 Token" }).click();
  const dialog = page.getByRole("dialog", { name: "已创建 MCP Token" });
  await expect(dialog).toContainText("dkh_");
  await dialog.getByRole("button", { name: "我已复制" }).click();
  await expect(page.locator(".token-list")).toContainText("Playwright agent");

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

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await expect(page.locator(".sidebar")).not.toBeInViewport();
  expect(await page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([390, 844]);
  await page.screenshot({ path: "test-results/feedback-390x844.png" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.locator("body")).toBeVisible();

  await page.setViewportSize({ width: 320, height: 760 });
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("link", { name: "总览" }).click();
  const primary = page.locator(".button.primary.command");
  await expect(primary).toBeVisible();
  const primaryBox = await primary.boundingBox();
  expect(primaryBox).not.toBeNull();
  expect(primaryBox!.x).toBeGreaterThanOrEqual(0);
  expect(primaryBox!.x + primaryBox!.width).toBeLessThanOrEqual(320);
  const overflow320 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow320).toBeLessThanOrEqual(0);
  await expect(page.getByRole("heading", { name: "总览" })).toBeVisible();
});
