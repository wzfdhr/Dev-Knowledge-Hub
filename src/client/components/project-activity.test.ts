import { describe, expect, test } from "vitest";

import { projectActivityLabel } from "./project-activity";

describe("project activity labels", () => {
  test("discloses an administrator LLM build opt-in", () => {
    expect(projectActivityLabel("build.llm_opted_in")).toBe("已启用 LLM 增强构建");
  });
});
