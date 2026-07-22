// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { ImportHistory } from "./import-history";

test("renders a semantic recent import table", () => {
  render(<ImportHistory loading={false} onRetry={vi.fn()} reports={[{
    id: "i1", projectId: "p1", repositoryId: "r1", sourceKind: "upload", status: "succeeded",
    startedAt: "2026-07-22T05:48:00.000Z", finishedAt: "2026-07-22T05:49:00.000Z",
    collectedFileCount: 1284, collectedTextBytes: 18 * 1024 * 1024,
    ignored: { total: 326, reasons: {} }, snapshotId: "s1", failureCode: null
  }]} />);
  expect(screen.getByRole("table", { name: "最近导入" })).toBeVisible();
  expect(screen.getByRole("columnheader", { name: "来源" })).toBeVisible();
  expect(screen.getByText("项目文件夹")).toBeVisible();
  expect(screen.getByText("1,284 个文件 · 18.0 MB")).toBeVisible();
  expect(screen.getByText("326 项")).toBeVisible();
  expect(screen.getByText("成功")).toBeVisible();
});

test("isolates a history query failure behind its own retry", async () => {
  const user = userEvent.setup();
  const retry = vi.fn();
  render(<ImportHistory loading={false} reports={[]} error={new Error("history failed")} onRetry={retry} />);
  await user.click(screen.getByRole("button", { name: "重试" }));
  expect(retry).toHaveBeenCalledTimes(1);
});

test("renders a compact empty state", () => {
  render(<ImportHistory loading={false} reports={[]} onRetry={vi.fn()} />);
  expect(screen.getByText("暂无导入记录")).toBeVisible();
});
