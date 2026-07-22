// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { ImportHistory } from "./import-history";

afterEach(cleanup);

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

test("links reports with snapshots to their project versions and marks missing snapshots", () => {
  render(<ImportHistory loading={false} onRetry={vi.fn()} reports={[
    { id: "with-snapshot", projectId: "project-with-version", repositoryId: "r1", sourceKind: "upload", status: "succeeded", startedAt: "2026-07-22T05:48:00.000Z", finishedAt: null, collectedFileCount: 1, collectedTextBytes: 1, ignored: { total: 0, reasons: {} }, snapshotId: "snapshot-1", failureCode: null },
    { id: "without-snapshot", projectId: "project-without-version", repositoryId: "r2", sourceKind: "git", status: "running", startedAt: "2026-07-22T05:48:00.000Z", finishedAt: null, collectedFileCount: 1, collectedTextBytes: 1, ignored: { total: 0, reasons: {} }, snapshotId: null, failureCode: null }
  ]} />);

  expect(screen.getByRole("columnheader", { name: "知识版本" })).toBeVisible();
  expect(screen.getByRole("link", { name: "查看版本" })).toHaveAttribute("href", "/projects/project-with-version/versions");
  expect(screen.getByText("—")).toBeVisible();
  expect(screen.getAllByRole("link", { name: "查看版本" })).toHaveLength(1);
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

test("renders an isolated loading state", () => {
  render(<ImportHistory loading onRetry={vi.fn()} reports={[]} />);
  expect(screen.getByText("正在加载导入记录...")).toBeVisible();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});

test("maps every source and status and shows a failed failure code", () => {
  render(<ImportHistory loading={false} onRetry={vi.fn()} reports={[
    { id: "upload", projectId: "p1", repositoryId: "r1", sourceKind: "upload", status: "succeeded", startedAt: "2026-07-22T05:48:00.000Z", finishedAt: null, collectedFileCount: 1, collectedTextBytes: 1, ignored: { total: 0, reasons: {} }, snapshotId: "s1", failureCode: null },
    { id: "git", projectId: "p1", repositoryId: "r2", sourceKind: "git", status: "running", startedAt: "2026-07-22T05:48:00.000Z", finishedAt: null, collectedFileCount: 2, collectedTextBytes: 2, ignored: { total: 0, reasons: {} }, snapshotId: null, failureCode: null },
    { id: "local", projectId: "p1", repositoryId: "r3", sourceKind: "local", status: "failed", startedAt: "2026-07-22T05:48:00.000Z", finishedAt: null, collectedFileCount: 3, collectedTextBytes: 3, ignored: { total: 0, reasons: {} }, snapshotId: null, failureCode: "VALIDATION_FAILED" },
    { id: "cancelled", projectId: "p1", repositoryId: "r4", sourceKind: "local", status: "cancelled", startedAt: "2026-07-22T05:48:00.000Z", finishedAt: null, collectedFileCount: 4, collectedTextBytes: 4, ignored: { total: 0, reasons: {} }, snapshotId: null, failureCode: null }
  ]} />);
  ["项目文件夹", "Git HTTPS", "成功", "进行中", "失败", "已取消", "VALIDATION_FAILED"].forEach((label) => {
    expect(screen.getByText(label)).toBeVisible();
  });
  expect(screen.getAllByText("服务器路径")).toHaveLength(2);
});
