# Frontend V1 Trial — Experience Kernel Handoff

EX01–EX12 已建立 FK19–FK23 的共享前置合同。后续任务必须消费现有实现，不得建立平行表、第二套 Token、
第二个画像 stage 或混合当前项目事实与历史经验。

| 后续任务 | 已提供合同 | 后续只需完成 |
|---|---|---|
| FK19 | EX04–EX07 的 opaque group、可见 evidence、ACL-first 查询、缓存键与秘密符号负例 | 扩充真实项目投影和产品级搜索，不重做经验持久层 |
| FK20 | `0038_workspace_mcp_tokens.sql`、user/session-bound Token、两个 scope、两个 workspace tool、稳定错误码 | 完善运维展示与真实客户端联调，不创建第二套 workspace MCP |
| FK21 | `/knowledge/experiences`、同页管理员审核、七状态、Codex 六分区上下文与响应式基线 | 扩展对比/Graph；保持 `/knowledge` 项目知识主入口 |
| FK22 | 五类 100 条数据、五条 solution-context 黄金流程、来源与撤权 acceptance | 在代表项目复跑并补页面→API、影响链路；复用现有 acceptance |
| FK23 | `evaluate:frontend-experience`、held-out 严格门禁、CI artifact 和零容忍阈值 | 将真实 staging/生产候选数据接入，不降低阈值、不从 train 派生 held-out |

Trial 必须同时保持：当前项目排除；不可见项目不影响标题/计数/Trust/排序/拒绝原因；未知硬条件克制；
admin-attested 可用而 unverified upload 不可用；signed failure/rollback 暂停匹配版本；普通反馈只创建复审项。

生产切换不在本交接授权内。完整前置条件、停止条件和回滚步骤见
`docs/operations/frontend-experience-kernel-rollout.md`。
