import { expect, test } from "@playwright/test";

test("opens analytics", async ({ page }) => {
  await page.goto("/analytics/demo");
  await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
});
