# Workspace MCP 运维合同

Workspace MCP 是与现有 project MCP 分离的只读端点。project Token 仍只能访问 `/mcp`，且 scope 仍为 `search` 与 `source.read`；Workspace Token 只能访问 `/mcp/workspace`。

Workspace Token 绑定 workspace 用户和签发时的 `sessionVersion`，最长 30 天。用户被停用、密码重置、会话版本变化、Token 到期或撤销后，下一个请求立即失效。只有 Token 所有者能列出、轮换或撤销它。服务端只保存 SHA-256 hash 和前缀，明文仅在创建或轮换响应中显示一次。

Scope：

- `workspace.patterns.read`：启用 `dkh_find_prior_implementations`。
- `workspace.solutions.read`：启用 `dkh_plan_frontend_solution`。

`dkh_plan_frontend_solution` 要求 `currentProjectId` 与不超过 2,000 字符的任务。`changedPaths` 必须是无 `..` 的项目相对路径。服务端只组装 `FrontendSolutionContext@1`，不调用模型、不修改代码。当前项目事实、硬约束、历史经验、被拒候选、未知项、影响和验证计划保持独立字段。

`no_release`、`stale`、`unsupported` 和无适用经验是正常 typed result。认证、权限、引用和输入错误使用稳定错误码。本阶段不签发生产 Token，不配置 CI webhook 密钥。
