import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { DashboardPage } from "./app";

describe("DashboardPage", () => {
  test("renders the dashboard heading", () => {
    render(<DashboardPage teamId="core" />);
    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeDefined();
  });
});
