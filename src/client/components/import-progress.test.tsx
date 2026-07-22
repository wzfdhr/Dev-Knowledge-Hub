// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { ImportProgress } from "./import-progress";

afterEach(cleanup);

describe("ImportProgress", () => {
  test("uses a compact idle hint instead of the full stage panel", () => {
    const { container } = render(<ImportProgress progress={{ phase: "reading", status: "idle", percent: 0 }} />);
    expect(screen.getByText("选择资料来源后开始导入")).toBeVisible();
    expect(container.querySelector(".import-stage-list")).not.toBeInTheDocument();
  });

  test("uses a compact idle hint when progress is null", () => {
    const { container } = render(<ImportProgress progress={null} />);
    expect(screen.getByText("选择资料来源后开始导入")).toBeVisible();
    expect(container.querySelector(".import-stage-track")).not.toBeInTheDocument();
  });

  test("shows running phase, percentage, transfer, rate, and ETA", () => {
    render(<ImportProgress progress={{ phase: "uploading", status: "running", percent: 42, processedFiles: 42, totalFiles: 100, processedBytes: 1024, totalBytes: 4096, bytesPerSecond: 2048, estimatedSeconds: 18, detail: "正在上传" }} />);
    expect(screen.getByText("文件夹直传")).toBeVisible();
    expect(screen.getByText("42%")).toBeVisible();
    expect(screen.getByText(/42\/100 个文件/)).toBeVisible();
    expect(screen.getByText(/2 KB\/s/)).toBeVisible();
    expect(screen.getByText(/约 18 秒/)).toBeVisible();
  });

  test("marks a failed run as an alert", () => {
    render(<ImportProgress progress={{ phase: "validating", status: "failed", percent: 80, detail: "服务端校验失败" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("服务端校验失败");
  });

  test("marks exactly one running stage as the current step", () => {
    render(<ImportProgress progress={{ phase: "uploading", status: "running", percent: 42 }} />);
    const stage = screen.getByText("文件夹直传").closest(".import-stage");
    expect(stage).toHaveAttribute("aria-current", "step");
    expect(stage).toHaveAccessibleName("文件夹直传，当前步骤，进行中");
    expect(document.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
  });

  test("keeps the current completed stage programmatically available", () => {
    render(<ImportProgress progress={{ phase: "snapshot", status: "completed", percent: 100 }} />);
    const stage = screen.getByText("创建内容版本").closest(".import-stage");
    expect(stage).toHaveAttribute("aria-current", "step");
    expect(stage).toHaveAccessibleName("创建内容版本，当前步骤，已完成");
    expect(screen.getByText("读取文件").closest(".import-stage")).toHaveAccessibleName("读取文件，已完成");
  });

  test("normalizes packaging to the uploading visual stage", () => {
    render(<ImportProgress progress={{ phase: "packaging", status: "running", percent: 50 }} />);
    expect(screen.getByText("文件夹直传").closest(".import-stage")).toHaveAttribute("aria-current", "step");
  });
});
