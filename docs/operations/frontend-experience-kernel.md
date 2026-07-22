# Frontend Experience Kernel Operations Contract

## 交付边界

EX01-EX11 只允许在本地或完全隔离的 staging 中执行。EX12 只产生 staging 证据，不切换生产 `active`，不签发生产 workspace Token，不配置 CI webhook 密钥。所有正常产品状态使用 typed response，不降级为 transport error。

## 产品状态矩阵

| 状态 | 当前项目事实 | 历史参考 | 默认推荐 | 允许动作 |
|---|---|---|---|---|
| `no_current_project` | 不生成 | 允许团队知识搜索 | 禁止 | 选择当前项目、浏览团队知识 |
| `no_release` | 无可引用 release 事实 | 可浏览其他授权项目的历史参考 | 禁止 | 查看导入、构建和发布指引；不显示任何推荐 |
| `stale` | 返回带 source version 的历史事实 | 仅返回通过当前 ACL 和新鲜度合同的参考 | 仅使用未过期 evidence | 查看旧 release、触发人工构建、查看验证计划 |
| `unsupported` | 返回已知事实与不支持原因 | 只显示带明确不兼容标识的历史参考 | 禁止 | 查看未知项、不支持原因和验证建议 |
| `no_applicable_experience` | 返回 | 返回被拒绝候选及原因 | 空数组 | 使用当前事实、影响与验证计划；不得生成伪团队经验 |
| `evidence_revoked` | 返回 | 立即移除失权 evidence 的所有投影 | 对受影响 evidence 禁止 | 查看审计历史、处理复审项；不使用旧缓存 |
| `ready` | 返回当前 release 事实和硬约束 | 返回授权、已发布、兼容的经验 | 仅 `recommended`/`standard` 且全部门禁通过 | 查看方案上下文、影响、验证与引用 |

`no_release` 必须在 UI 显示专用说明，不得使用通用空状态。页面必须明确显示仍可进行的导入、同步、构建和发布动作，同时隐藏所有默认推荐。

## Knowledge Lint 与复审

- 管理员可在工程经验审核视图运行 `POST /api/knowledge/experience-lint`；发布合格的 Frontend v2 release 后也会运行同一检查。
- 规则覆盖缺失引用、失权或缺失 basis、required/forbidden 冲突、过期 evidence、结果 source version 错配、signed CI 失败/回滚、废弃或已替代推荐，以及 supersession 循环。
- `error` 诊断以稳定 ID 追加为 `knowledge_lint` 高优先级复审项；重复运行保持幂等。`warning` 只报告，不自动改变生命周期。
- Lint 不调用 `transitionExperienceWithAudit`，不改写经验正文，不发布 release，也不把普通用户反馈提升为推荐依据。
- outcome、用户反馈复审项、治理 review event 都是 append-only；负面可信结果只暂停与其 source version 精确匹配的 evidence。

## 回滚

回滚设置 `DEVKH_WORKSPACE_SOLUTION_PLANNING=disabled` 与
`DEVKH_FRONTEND_EXPERIENCE_RECOMMENDATIONS=disabled`，关闭 `/mcp/workspace` 方案编排和默认推荐，
恢复“当前项目事实 + 历史实现参考”。回滚不删除不可变 release、审核历史、结果事件或恢复证据；完整步骤见
`docs/operations/frontend-experience-kernel-rollout.md`。
