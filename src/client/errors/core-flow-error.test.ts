import { describe, expect, test } from "vitest";

import { ApiError } from "../api/client";
import { describeCoreFlowError } from "./core-flow-error";

describe("describeCoreFlowError", () => {
  test("maps an upload 500 to safe Chinese guidance without leaking the server message", () => {
    const result = describeCoreFlowError(
      "upload",
      new ApiError(500, "REQUEST_FAILED", "null value in column source_kind")
    );

    expect(result).toMatchObject({
      title: "上传提交暂未完成",
      retryable: true,
      operationLabel: "资料接入"
    });
    expect(`${result.summary}${result.safety}${result.nextStep}`).not.toContain("source_kind");
  });
});
