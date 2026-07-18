import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { AnalyticsPage } from "./analytics-page";

describe("AnalyticsPage", () => {
  test("renders analytics heading", () => {
    render(<AnalyticsPage accountId="demo" />);
    expect(screen.getByRole("heading", { name: "Analytics" })).toBeVisible();
  });
});
