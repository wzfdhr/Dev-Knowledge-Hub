# 前端控制台收口交接记录（2026-07-23）

## 交付范围

- 本地分支：`codex/console-convergence`
- 基线：本地 `main` 的 `f845ffcbb123b7ff01eb8aad225a8de943d536ba`
- 工作树：`.worktrees/console-convergence`
- 状态：实现和本地隔离验证完成，尚未合并、push、创建 PR 或部署。

本分支完成 Docker integration 镜像修复与 `/data/` 忽略规则、导入工作台迁移、项目生命周期和统一导航、Workspace 全局知识搜索、项目知识质量页、显式项目级 release API、25 万结构节点容量门禁，以及本地开发 API 代理修正。工程经验入口 `/knowledge/experiences`、迁移 `0035`–`0038` 和现有公共合同保持不变。

## 隔离与权限结论

- `GET /api/projects/:projectId/releases` 在服务端校验 Workspace、项目 reader 以上角色、当前 repository 和 release 归属。
- admin、member、reader 的合法读取通过；无 release 返回 typed empty result；无权项目返回稳定的 `PROJECT_ACCESS_DENIED`，响应不包含另一项目的版本号。
- 全局知识搜索只返回服务端 ACL 过滤后的项目结果；页面不读取当前 repository 或当前 release。
- 查询参数中的跨项目 `releaseId` 不会触发元数据读取。
- 经验评测中的无权限泄漏、硬冲突推荐、失权证据推荐、当前项目混入 prior references、响应分区错误均为 0。

## 验证结果

| 门禁 | 结果 |
| --- | --- |
| ESLint | 通过 |
| TypeScript（client + node） | 通过 |
| Vitest 全量 | 183 个文件通过、1 个文件按合同跳过；1118 个测试通过、34 个按合同跳过 |
| Docker PostgreSQL integration | 34/34 通过 |
| source-blob backfill Node tests | 44/44 通过 |
| Acceptance | 9/9 通过 |
| Knowledge evaluator | 145 条；Recall@5、MRR、引用有效率均为 1 |
| Frontend evaluator | 336 条；质量门禁通过；中文占比 41.07% |
| Frontend experience evaluator | 100 条；适用 precision 与关键 unknown abstention recall 均为 1 |
| Production build | 通过 |
| Playwright 黄金流程 | 1/1 通过 |
| Backup / restore / monitoring | 73/73 通过 |
| Parser runtime isolation | 6/6 通过 |
| Delivery static verification | 通过 |
| Experience isolated staging benchmark | 通过；查询 P95 0.009 ms，解决方案上下文 P95 0.005 ms |

Playwright 覆盖 320、390、768、1280 和 1440 宽度。导入、全局知识搜索、项目知识质量、图谱、前端地图、Codex 和团队协作流程无页面级横向溢出。浏览器截图人工复核后修复了 390px 全局搜索页导航按钮与页头重叠。

## 已知非阻断项

生产构建仍有既存的 bundle-size 提示：主 JavaScript chunk 约 1,050.11 kB（gzip 321.04 kB），构建退出码为 0。后续可单独进行路由级动态导入和 vendor 分包，不应与本轮权限、路由或导入行为改动混合。

## 未执行的外部或生产操作

- 未访问或修改生产环境。
- 未执行生产 migration、发布或 active 切换。
- 未签发生产 Workspace Token，未配置 CI webhook 密钥。
- 未 push、未创建 PR、未合并到 `main`。
- 未恢复本轮已明确跳过的正式 Figma 交付。
- 原工作区中的本地 `/data/` 和未提交内容未删除、未提交。

## 后续授权点

当前分支可以在获得明确授权后合并到本地 `main`。push、PR、生产发布和生产配置仍需分别授权。
