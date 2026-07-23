# Frontend Experience Kernel Rollout and Rollback

## 授权边界

本合同只覆盖本地与完全隔离的 staging。当前交付不得访问或修改 `hub.starking.icu`，不得切换生产
`active`，不得签发生产 workspace Token，也不得配置 CI outcome webhook 凭据。任何生产迁移、Token、
发布、push 或 PR 都需要新的明确授权。

## 隔离 staging 前置条件

1. migration 顺序必须是 `0035_source_blobs_contract.sql`、
   `0036_frontend_experience_source_provenance.sql`、
   `0037_frontend_experience_contracts.sql`、`0038_workspace_mcp_tokens.sql`。
2. `npm run evaluate:frontend-experience` 的 train、held-out、all 三组门禁都通过。
3. `npm run acceptance` 的来源、撤权和五条 solution-context 黄金流程通过。
4. 恢复演练必须使用临时 PostgreSQL、临时容器和 bind-mounted 恢复目录；
   `productionVolumeTouched=false` 且 `experienceRecoveryValidated=true`。
5. 浏览器证据覆盖 1440px 与 390px；工程经验、审核队列、Codex 上下文和空状态无横向溢出。

## 放行步骤

按顺序运行：

```bash
npm run lint
npm run typecheck
npm test
npm run acceptance
npm run evaluate:knowledge
npm run evaluate:frontend
npm run evaluate:frontend-experience
npm run verify:frontend-experience-staging
npm run build
npm run test:e2e
npm run test:backup
npm run delivery:verify
```

设置了 `TEST_DATABASE_URL` 时还必须运行 `npm run test:integration`。缺少该变量不是 PostgreSQL
通过证据，必须在交接中显式标记为未执行。

## 停止条件

出现任一条件立即停止：权限泄漏；当前项目进入 prior references；硬冲突、失权或废弃证据被推荐；
事实/历史经验/拒绝候选分区混合；来源或画像摘要不一致；Token 过期、撤销或 session 变化后仍可用；
恢复图存在孤儿；query P95 超过 1 秒；solution-context P95 超过 1.5 秒。

## 可逆回滚

只设置以下两个开关并重启隔离环境：

```dotenv
DEVKH_WORKSPACE_SOLUTION_PLANNING=disabled
DEVKH_FRONTEND_EXPERIENCE_RECOMMENDATIONS=disabled
```

回滚后：

- `dkh_plan_frontend_solution` 返回稳定错误码 `SOLUTION_PLANNING_DISABLED`；
- 默认推荐为空，但当前项目事实、未知项、影响与验证计划仍按 typed contract 返回；
- `dkh_find_prior_implementations`、项目 `/mcp`、不可变 release、项目画像、经验事实、审核、结果、
  复审项、标准和恢复证据均保留；
- 不删除 `0036`–`0038` 表，不回退 `0035`，不改写 append-only 记录。

恢复开关前必须重新通过专项 evaluator、Token 失效、撤权暂停、恢复图和 P95 门禁。
