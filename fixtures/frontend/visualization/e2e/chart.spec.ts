import { expect, test } from "@playwright/test";

test("opens the revenue chart", async ({ page }) => {
  await page.goto("/revenue");
  await expect(page.getByLabel("Revenue trend")).toBeVisible();
});
