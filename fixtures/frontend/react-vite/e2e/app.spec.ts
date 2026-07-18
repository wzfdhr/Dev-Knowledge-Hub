import { expect, test } from "@playwright/test";

test("opens the dashboard route", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
});
