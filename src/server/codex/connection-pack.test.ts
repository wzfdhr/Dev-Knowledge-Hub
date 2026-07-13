import { describe, expect, test } from "vitest";

import { createCodexConnectionPack } from "./connection-pack.js";

describe("Codex project connection pack", () => {
  test("generates project-specific MCP configuration and development lookup rules", () => {
    const pack = createCodexConnectionPack({
      projectName: "数据服务",
      projectId: "project-123",
      endpoint: "https://knowledge.example.com/mcp",
      environmentVariable: "DEVKH_DATA_SERVICE_TOKEN"
    });

    expect(pack.configToml).toContain('url = "https://knowledge.example.com/mcp"');
    expect(pack.configToml).toContain('bearer_token_env_var = "DEVKH_DATA_SERVICE_TOKEN"');
    expect(pack.agentsMarkdown).toContain("数据服务");
    expect(pack.agentsMarkdown).toContain("修改代码、缺陷排查、架构评审、测试规划或任务拆解前");
    expect(pack.agentsMarkdown).toContain("普通闲聊不需要调用");
    expect(pack.checkCommand).toContain("DEVKH_DATA_SERVICE_TOKEN");
  });
});
