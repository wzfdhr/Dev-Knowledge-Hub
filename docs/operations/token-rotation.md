# MCP Token 轮换

项目管理员在项目工作台的“Codex 接入”页对可用 Token 选择“轮换”。系统在一个数据库事务内完成以下动作：

1. 锁定当前可用 Token。
2. 创建同项目、同名称的新 Token 记录。
3. 撤销旧 Token。
4. 写入 `mcp_token.rotated` 审计事件，metadata 仅包含旧 Token ID 和 replacement Token ID。

replacement 明文只在轮换响应和一次性界面弹窗中出现。数据库、日志、活动流和 Token 列表只保存或展示哈希、前缀、时间、项目和审计标识，不保存明文。

轮换仅允许该项目的 `admin` 或工作区 `admin`。项目 `member`、`reader`、跨项目成员和已撤销 Token 均不能轮换。创建 replacement 失败时事务回滚，旧 Token 保持可用。replacement 创建成功后旧 Token 立即失效；旧 Token 不支持恢复，需再次轮换或创建新的 Token。
