import { expect, test } from "@playwright/test";

test("setup, build, cite, publish, token, and feedback rebuild", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Create the administrator" })).toBeVisible();
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  const fixture = await (await request.get("/__test__/fixture")).json() as { path: string };
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Repository name").fill("Code intelligence fixture");
  await page.getByLabel("Local path").fill(fixture.path);
  await page.getByRole("button", { name: "Connect repository" }).click();
  await expect(page.getByText("Code intelligence fixture")).toBeVisible();
  await page.getByRole("link", { name: "Overview" }).click();
  await page.getByRole("button", { name: "Sync repository" }).click();
  await expect(page.getByRole("button", { name: "Start knowledge build" })).toBeVisible();
  await page.getByRole("button", { name: "Start knowledge build" }).click();
  await expect(page.getByRole("button", { name: "Review ready build" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Review ready build" }).click();
  await page.getByLabel("Version").fill("1.0.0");
  await page.getByRole("button", { name: "Create release draft" }).click();

  await page.getByRole("link", { name: "Knowledge" }).click();
  const pageButton = page.locator(".page-tree button").first();
  await expect(pageButton).toBeVisible();
  await pageButton.click();
  const citation = page.locator(".citations button").first();
  await expect(citation).toBeVisible();
  await citation.click();
  await expect(page.getByRole("complementary", { name: "Source excerpt" })).toContainText("Commit");

  await page.getByRole("link", { name: "Overview" }).click();
  await page.getByRole("button", { name: "Publish release" }).click();
  await expect(page.getByText("1.0.0")).toBeVisible();
  await page.screenshot({ path: "test-results/overview-1440x1024.png", fullPage: true });

  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Token name").fill("Playwright agent");
  await page.getByRole("button", { name: "Create token" }).click();
  const dialog = page.getByRole("dialog", { name: "MCP token created" });
  await expect(dialog).toContainText("dkh_");
  await dialog.getByRole("button", { name: "I have copied it" }).click();
  await expect(page.locator(".token-list")).toContainText("Playwright agent");

  const seeded = await request.post("/__test__/feedback");
  expect(seeded.ok()).toBeTruthy();
  await page.getByRole("link", { name: "Feedback" }).click();
  await page.getByRole("button", { name: "How do I deploy the service?" }).click();
  await page.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await expect(page.getByRole("button", { name: "Request rebuild" })).toBeVisible();
  await page.getByRole("button", { name: "Request rebuild" }).click();
  await expect(page.getByText(/remain unpublished/i)).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await expect(page.locator(".sidebar")).not.toBeInViewport();
  await page.screenshot({ path: "test-results/feedback-390x844.png", fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.locator("body")).toBeVisible();
});
