import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { RevenueChart } from "./chart";

vi.mock("echarts");
test("renders the revenue chart host", () => {
  render(<RevenueChart source={[["Jan", 12]]} />);
  expect(screen.getByLabelText("Revenue trend")).toBeDefined();
});
