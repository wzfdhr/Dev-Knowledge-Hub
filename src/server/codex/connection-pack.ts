export interface CodexConnectionPackInput {
  projectName: string;
  projectId: string;
  endpoint: string;
  environmentVariable: string;
}

export interface CodexConnectionPack {
  configToml: string;
  agentsMarkdown: string;
  checkCommand: string;
}

export function createCodexConnectionPack(input: CodexConnectionPackInput): CodexConnectionPack {
  return {
    configToml: `[mcp_servers.devkh_${input.projectId}]
url = "${input.endpoint}"
bearer_token_env_var = "${input.environmentVariable}"
`,
    agentsMarkdown: `# ${input.projectName} 知识库规则

在修改代码、缺陷排查、架构评审、测试规划或任务拆解前，先调用本项目的 devkh MCP 工具查询已发布知识，并以返回的版本和源码引用为准。

普通闲聊不需要调用 devkh。不要把未发布的草稿知识当作事实；查询失败时说明缺少已发布知识，再继续必要的本地分析。
`,
    checkCommand: `test -n "${`$${input.environmentVariable}`}" && echo "${input.environmentVariable} 已设置"`
  };
}
