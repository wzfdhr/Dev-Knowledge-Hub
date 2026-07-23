# Frontend Experience Kernel — Isolated Staging Evidence

## 证据范围

- 日期：2026-07-22（Asia/Shanghai）
- 环境：`isolated-local-staging`
- 生产访问：无；`hub.starking.icu` 未访问、未修改
- 生产 workspace Token：未签发
- CI webhook 凭据：未配置
- Git：仅本地提交；未 push、未创建 PR

## 验收结果

| 门禁 | 命令/证据 | 结果 |
|---|---|---|
| 五类专项数据 | `npm run evaluate:frontend-experience` | 100 条；train 60、held-out 40；中文 50%；负例 60%；通过 |
| 零容忍 | evaluator artifact | hard conflict、revoked evidence、current-project prior、unauthorized evidence 均为 0 |
| 适用与克制 | evaluator artifact | recommendation precision 1.0；required-unknown abstention recall 1.0 |
| 分区 | evaluator artifact | response partition validity 1.0；contract match 1.0 |
| 五条黄金流程 | `acceptance/frontend-experience-solution.acceptance.test.ts` | chart、form、state/data、styling、testing 全部通过 |
| 来源资格 | `acceptance/frontend-experience-source-provenance.acceptance.test.ts` | 内容不匹配拒绝；git-linked 与 admin-attested 通过；unverified 拒绝 |
| 结果暂停 | `acceptance/frontend-experience-revocation.acceptance.test.ts` | signed rollback 对匹配 source version 立即暂停 |
| Token 生命周期 | `src/server/mcp/workspace-auth.test.ts`、`src/server/mcp-access.test.ts` | 到期、撤销、session 变化和项目失权稳定拒绝 |
| 未知条件 | evaluator + workspace MCP tests | 返回 abstain/unknown，不生成伪团队经验 |
| 恢复图 | `node --test scripts/backup/validate-experience-recovery.test.mjs` | 来源、画像、release、证据、决策、结果、审核、复审项、标准通过 |
| 恢复演练合同 | `npm run test:backup` | 临时恢复、artifact/blob 与经验完整性门禁通过 |
| PostgreSQL 集成 | 一次性 `postgres:16-alpine` 的 `devkh_test`；`npm run test:integration` | Vitest 34/34、真实 backfill 44/44；容器执行后自动销毁 |
| query P95 | `npm run verify:frontend-experience-staging`，500 次 | 0.006 ms，阈值 1,000 ms，通过 |
| solution-context P95 | 同上，200 次 | 0.004 ms，阈值 1,500 ms，通过 |
| UI 390px | `docs/screenshots/ex09-experiences-390.jpg`、`ex09-review-390.jpg`、`ex09-codex-context-390.jpg` | Inter、无横向溢出、单一 H1、六个上下文分区、无 console error |
| UI desktop | `docs/screenshots/ex09-experiences-desktop.jpg` + DOM 审计 | 1440/1280 级布局合同通过 |

P95 数据来自进程内隔离基准，用于验证决策与上下文组装代码路径，不代表生产网络或 PostgreSQL
延迟；生产放行仍需真实 staging 负载证据。数据库合同已在一次性本地 PostgreSQL 16 中验证，未连接
任何共享或生产数据库。

## Figma 交付

正式文件：[Dev Knowledge Hub — Frontend Experience Kernel](https://www.figma.com/design/uf7puLJFuznpK9H5gwCCOM)。
文件已创建；Starter MCP tool-call 配额阻止继续写入画布。可复现页面、变量、组件和 frame 规格记录在
`docs/design/frontend-experience-kernel-figma.md`，浏览器实现与截图是本次可验证视觉证据。该限制不被
误报为完成的 Figma 画布内容，解除配额后应按 handoff 规格重放。

## 结论

本地/隔离 staging 合同通过，生产授权仍为关闭。回滚只关闭 solution planning 与默认推荐，保留项目 MCP、
不可变 release、追加式审核历史和恢复证据。
