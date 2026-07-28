// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import type { CoreFlowErrorDescriptor } from "../errors/core-flow-error";
import { CoreFlowErrorCard, CoreFlowErrorDialog } from "./core-flow-error-dialog";

afterEach(cleanup);

const descriptor: CoreFlowErrorDescriptor = {
  operation: "upload", operationLabel: "资料接入", title: "上传提交暂未完成",
  summary: "服务端未能完成本次资料快照写入。",
  safety: "已验证的上传文件会保留；当前已发布知识不会自动变化。",
  nextStep: "可直接安全重试。", retryable: true, diagnosticId: "REQUEST_FAILED"
};

test("shows actionable details and invokes a safe retry from the error dialog", async () => {
  const user = userEvent.setup();
  const retry = vi.fn();
  const close = vi.fn();
  render(<CoreFlowErrorDialog descriptor={descriptor} open onClose={close} onRetry={retry} />);

  expect(screen.getByRole("dialog", { name: "上传提交暂未完成" })).toBeInTheDocument();
  expect(screen.getByText("数据安全")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "安全重试" }));
  expect(retry).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

test("keeps the page card after its dialog closes", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<><CoreFlowErrorCard descriptor={descriptor} /><CoreFlowErrorDialog descriptor={descriptor} open onClose={onClose} /></>);

  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(screen.getByRole("alert")).toHaveTextContent("上传提交暂未完成");
});
