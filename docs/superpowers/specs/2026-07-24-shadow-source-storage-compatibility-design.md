# Shadow 来源存储与 legacy 流程兼容修复

## 背景

生产环境启用 `DEVKH_SOURCE_STORAGE_MODE=shadow` 后，`convert` 阶段会同时产出：

- `normalized-sources@1`：供既有知识（B02/legacy）流程消费；
- `normalized-source-refs@2`：供新前端知识流程消费。

项目若未显式启用前端 shadow rollout，仍使用 legacy 输入规划器。该规划器目前要求 `convert` 仅有一个上游清单，因此在两份产物存在时，以 `Pipeline stage extract requires exactly one upstream manifest` 失败。

## 目标与范围

修复 legacy 项目与 shadow 来源存储的兼容性，不改变已发布版本、上传资料、构建领域模型或数据库结构。

同时为当前两个受影响项目显式启用项目级 `shadow` rollout，使其使用正确的新前端候选流程。

## 设计

1. B02 输入规划器接收当前 `SourceStorageMode`。
2. 当下游阶段是 `extract` 或 `tables`，且来源模式为 `shadow` 时，规划器从 convert 的多个产物中只选择 `normalized-sources@1`，再生成 legacy 输入摘要。
3. 其他阶段维持“恰好一个上游产物”的现有校验；找不到或找到多个兼容的 legacy 产物仍明确失败。
4. `createFrontendModeStageInputPlanner` 将来源模式传递给 legacy 规划器。项目级 shadow 保持使用已有 shadow 规划器，消费它所需的双产物。
5. 对生产中的两个目标项目写入项目级 rollout=`shadow`。这是可审计的配置变更；不会重试、发布或覆盖任何构建。

## 验证

- 先新增测试：shadow 来源的两个 convert 产物交给 legacy 规划器时，应只使用 `normalized-sources@1`，且生成与原单产物一致的 extract 输入摘要。
- 观察该测试在修复前失败，再实施最小改动并验证通过。
- 运行相关前端模式与管线规划器测试。
- 部署后对失败构建发起新的 attempt，确认 extract 不再因上游清单数量失败；正式版本保持不变。

## 非目标

- 不将 shadow 自动升级为 active。
- 不修改历史失败证据或已发布知识。
- 不新增 API、数据库表或迁移。
