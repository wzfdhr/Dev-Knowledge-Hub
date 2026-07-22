# 前端工程经验决策内核设计

> 状态：已于 2026-07-22 获得用户书面实施批准。本文是 EX01-EX12 的可实施合同；批准不代表已部署、已切换生产 `active` 或已授予任何生产凭据。

**实施基线：** `codex/frontend-experience-kernel-design@38449c5`。FK17 与 FK18 已在当前隔离工作树完成并通过本地门禁，`0035_source_blobs_contract.sql` 已作为 FK17 唯一 contract migration 存在。本设计属于“前端专业知识平台”的 V1 Trial 增强，不修改 Phase F 的生产状态，不授权生产 `active`。

**上位设计：** `docs/superpowers/specs/2026-07-18-frontend-knowledge-platform-design.md`

## 1. 产品目标

Dev Knowledge Hub 必须把两类价值同时交付给前端工程师：

1. 理解当前项目真实存在的代码、架构和约束。
2. 在其他前端项目遇到相似问题时，复用经过证据、适用性和结果验证的团队经验。

系统不是把历史项目代码直接拼进提示词，也不是让模型从相似文本自由发挥。它应先判断当前项目条件，再筛选适用经验，并明确说明推荐理由、被排除方案、未知信息、改动影响和验证方法。

最终黄金问题仍以“在新项目中实现 ECharts 下钻页面”为代表，但完成定义扩展为：

- 返回当前项目的 route/page/component/state/API/style/chart/test/tooling 事实。
- 返回当前任务必须遵守的硬约束和当前无法静态确定的条件。
- 只返回调用者有权访问、来源已发布、与当前项目兼容的历史经验。
- 解释每条经验为何适用，并列出因框架、版本、架构或禁止条件而被排除的候选。
- 返回可能受影响的页面、组件、API、样式和测试，以及可执行的验证计划。
- 每条事实、经验和结果都能追溯到明确的来源与可信等级。

## 2. V1 范围

经验决策内核只服务于原计划的前端领域和框架路线：React/Vite -> Next.js -> Vue 3/Nuxt。V1 Trial 先验证五类高频问题：

1. 路由、页面和布局组织。
2. 状态管理、请求、缓存和 API 调用。
3. 表单、权限守卫和错误处理。
4. ECharts 图表、联动和下钻。
5. 变更影响、测试选择和构建工具约束。

V1 不扩展到后端、数据库或通用运维经验；不接入公开互联网方案库；不根据个人行为画像推荐；不自动修改客户代码；不执行客户项目的 install、build、test 或 package scripts。

## 3. 知识所有权

### 3.1 项目原始事实

Git 项目的源码、README、ADR、配置和接口定义以 Git 为权威源。知识库保存绑定具体 Git commit 的不可变快照，用于重建、引用、权限检查和历史 release 回放，但不能成为新的代码编辑源。

上传项目没有 Git commit，其权威源是服务端验证后的不可变内容版本。现有 `commitSha` 对上传项目实际承载内容版本哈希；新合同必须停止依赖这一隐含语义，并显式区分 Git commit 与上传内容版本。

### 3.2 项目派生知识

Frontend IR、Graph、项目画像、知识页、检索索引和影响分析是可重建派生产物。它们必须绑定 workspace、project、repository、snapshot、release、source provenance、analyzer manifest 和 schema version。删除这些产物后，应能从仍受支持的源快照确定性重建。

### 3.3 跨项目工程经验

跨项目经验、审核决定、团队标准和结果反馈由知识库持久化，因为它们不属于单一 Git 仓库。经验只能引用已发布项目证据，不能复制成失去项目、release 和 citation 的全局文本。

## 4. 源来源合同

### 4.1 版本化来源

```ts
type SourceProvenance =
  | {
      schemaVersion: 1;
      kind: "git";
      gitCommitSha: string;
      contentVersion: string;
      ref: string;
      remoteIdentityDigest: string;
    }
  | {
      schemaVersion: 1;
      kind: "upload";
      gitCommitSha: null;
      contentVersion: string;
      ref: "upload";
      attestation: "unverified" | "admin_attested" | "git_linked";
      linkedGitCommitSha?: string;
      linkedRemoteIdentityDigest?: string;
    };
```

`contentVersion` 始终由服务端对规范化、已接受文件集合计算。Git 来源还必须验证该内容版本属于持久化的 `gitCommitSha`；上传来源不得把内容版本在 API 或 UI 中称为 Git Commit。

### 4.2 经验资格

| 来源 | 项目事实 | 历史参考 | 自动进入多项目验证 | 默认推荐 |
|---|---|---|---|---|
| Git 已发布且未过期 | 允许 | 允许 | 允许 | 通过后续门禁后允许 |
| Upload `unverified` | 允许 | 禁止 | 禁止 | 禁止 |
| Upload `admin_attested` | 允许 | 以低可信人工参考显示 | 禁止 | 禁止 |
| Upload `git_linked` 且内容匹配 | 允许 | 允许 | 允许 | 通过后续门禁后允许 |

`admin_attested` 只证明管理员愿意将该快照作为参考，不证明其来自某个 Git commit，也不能单独满足自动验证或推荐门槛。`git_linked` 必须由服务端验证 snapshot 内容版本与目标 Git commit 的规范化内容一致。

### 4.3 新鲜度

- 项目 release 不是最新可见 snapshot 时，返回 `stale`，但仍可作为带版本标识的历史证据。
- 默认推荐只能使用未归档、未撤权、未过期且通过版本支持合同的证据。
- 当前未合并开发分支由 Codex 的本地代码上下文负责；团队经验库只消费人工发布的不可变 release。
- 同步仍不自动调用模型、不自动构建、不自动发布。

## 5. 三类证据

### 5.1 代码观察事实

`observed_fact` 由确定性 analyzer、IR 和 Graph 生成，只能声明代码实际表现出的结构或实现模式，例如“使用 Zustand store”“路由懒加载”“ECharts click 事件触发 route 参数更新”。

```ts
interface ObservedPatternEvidence {
  evidenceType: "observed_fact";
  projectId: string;
  releaseId: string;
  projectProfileDigest: string;
  capability: FrontendExperienceCapability;
  implementationSignature: string;
  sourceRefs: SourceRef[];
  analyzerProvenance: AnalyzerProvenance[];
}
```

代码观察不得自动生成“为什么采用”“替代方案为何失败”“上线效果很好”等决策或结果结论。

### 5.2 声明决策

`declared_decision` 由 workspace 管理员或授权审核者创建，或从仓库内明确标识的 ADR 导入后由人工确认。它保存问题、适用条件、硬约束、候选方案、选择理由和禁止条件。

```ts
interface DeclaredDecisionEvidence {
  evidenceType: "declared_decision";
  problemStatement: string;
  applicability: ApplicabilityContract;
  selectedApproach: string;
  alternatives: Array<{ approach: string; rejectedBecause: string[] }>;
  tradeoffs: string[];
  evidenceBasisIds: string[];
  authorUserId: string;
  approvedByUserId: string;
  approvedAt: string;
}
```

自动提取或 LLM 草稿只能进入待审核状态，不能成为 `declared_decision`。

### 5.3 验证结果

`verified_outcome` 记录采用后的构建、测试、性能、故障或回滚结果。结果必须标明来源：

```ts
type OutcomeAuthority = "signed_ci" | "admin_attested" | "user_reported";

interface VerifiedOutcomeEvidence {
  evidenceType: "verified_outcome";
  authority: OutcomeAuthority;
  repositoryId: string;
  sourceVersion: string;
  releaseId?: string;
  outcome: "passed" | "failed" | "rolled_back" | "partial";
  checks: Array<{ name: string; status: "passed" | "failed" | "skipped" }>;
  reportDigest?: string;
  recordedByUserId?: string;
  recordedAt: string;
}
```

`signed_ci` 必须通过预先配置的 CI 身份或 HMAC 签名，且 source version 与目标 repository/snapshot 匹配。系统只保存规范化结果、摘要和 digest，不保存可能含密钥的原始 CI 日志。`user_reported` 只能触发复审或作为辅助信号，不能独立提高推荐等级。

## 6. 项目画像与适用性

### 6.1 Frontend Project Profile

十阶段流水线不增加 stage。`synthesize` 产生 `frontend-project-profile@1`，`validate` 检查其完整性，`package` 将其纳入 `frontend-pipeline-package@2` 和 release provenance。

画像至少包含：

- 框架、框架版本和支持状态。
- CSR/SSR/SSG/RSC 边界。
- Router、状态库、请求库、缓存方案和表单库。
- 构建工具、workspace/monorepo 类型和包边界。
- 样式系统、设计令牌、组件库和图表库。
- 测试工具、已有测试映射和静态质量约束。
- 已知、未知和不支持的属性，不用缺省值伪装确定性。

### 6.2 Applicability Contract

```ts
interface ApplicabilityContract {
  required: ProjectPredicate[];
  forbidden: ProjectPredicate[];
  preferred: ProjectPredicate[];
  unsupportedWhenUnknown: ProjectPredicateKey[];
}
```

硬过滤顺序固定为：

1. workspace、项目和 release 实时权限。
2. 当前项目排除与来源资格。
3. 生命周期、撤权、归档和新鲜度。
4. 框架、版本、渲染模式和工具链 required/forbidden 条件。
5. `unsupportedWhenUnknown` 中的未知属性。

命中任一禁止条件或关键属性未知时，该经验不得进入默认推荐。软排序只能在通过硬过滤的经验中根据能力匹配、证据质量、新鲜度和结果可信度排序，不能用文本相似度覆盖硬冲突。

## 7. 经验对象与生命周期

### 7.1 物理数据边界

- `workspace_pattern_groups` 只保存 opaque group id、能力类别和生命周期元数据。
- `workspace_pattern_evidence` 按项目、release 和 citation 保存观察事实。
- `workspace_decisions` 保存人工声明的决策与审批记录。
- `workspace_outcomes` 保存规范化结果事件。
- `workspace_experience_reviews` 保存追加式状态转换与 evidence basis。
- `workspace_standards` 保存明确由团队编写、属于 workspace 的工程标准；不得把受限项目文案复制为标准正文。

用户可读标题、问题、条件、Trust、计数和排序都必须在查询时从当前可见 evidence 和有效审批 basis 生成，或来自独立的 `workspace_standards`。不得把跨项目聚合文案直接固化到 opaque pattern group。

### 7.2 生命周期

```text
candidate -> verified -> recommended -> standard
    |           |             |           |
    +---------> rejected      +---------> deprecated
                    verified ----------------> deprecated
```

- `candidate`：自动发现，不能默认推荐。
- `verified`：由合格 Git/git-linked 来源满足多项目代码证据门槛，或由管理员确认一个合格来源的单项目观察；只能作为“历史参考”显示。Upload `admin_attested` 仍是低可信人工参考，不能借此状态进入自动验证或默认推荐。
- `recommended`：管理员审核适用条件、禁止条件和 basis 后，可进入默认推荐。
- `standard`：团队明确采用的 workspace 工程标准，优先于普通推荐，但不能覆盖当前项目硬事实。没有实现证据的标准可以作为硬约束返回，不能作为“已验证实现”推荐。
- `rejected`：证据错误、不可复用或不符合范围。
- `deprecated`：过时、有负面结果或被替代。`supersededById` 只能指向可见且未废弃的经验。

所有转换均写 actor、from/to、reason、basis 和时间。系统可以因失权、证据撤销或版本过期将经验从查询资格中立即移除，但不能静默改写人工审核历史。

### 7.3 推荐资格

默认推荐必须同时满足：

- 状态为 `recommended` 或 `standard`。
- 当前调用者可见全部批准 basis。
- 至少一个有效、已发布且引用完整的实现证据。
- 当前项目通过所有 required/forbidden/unknown 门禁。
- 没有未处理的高严重度失败或回滚结果。
- 生成投影时使用的 ACL revision、可见 release 集和 project profile digest 与当前请求一致。

反馈数量、点击数量或采用次数不能单独提高推荐等级，避免流行度自我强化。

## 8. ACL 与缓存

查询先实时计算调用者可访问的项目和 release，再生成经验投影。项目移除成员、release 撤权、项目归档、workspace Token 撤销或 session version 变化后，下一次查询必须立即反映变化，不等待离线重建。

缓存键至少包含：

```text
workspaceId
userId
sessionVersion
aclRevision
visibleReleaseSetDigest
currentProjectId
currentProjectProfileDigest
queryIntentDigest
experienceSchemaVersion
rankingVersion
```

不可见项目不得影响标题、计数、Trust、排序、推荐资格、被排除原因或缓存命中。负向测试继续使用带唯一秘密符号的未授权项目，并扩展到决策、结果、标准、计数和 superseded 关系。

## 9. 查询与 AI 合同

### 9.1 保留现有双权限域

现有 project MCP Token 和 `/mcp` 继续只读绑定项目，不增加 workspace scope。user-bound workspace MCP Token 继续实时验证 workspace 成员身份和 `currentProjectId` 权限。

### 9.2 增加受控编排工具

仅依赖 AI 自行按顺序调用两个 Server，无法严格保证当前项目约束先于历史经验。workspace MCP 因此新增 `dkh_plan_frontend_solution`，使用 user-bound workspace 凭据，在服务端调用项目事实 resolver 和经验 resolver，并保持输出物理分区。它不调用模型，也不修改代码。

```ts
interface FrontendSolutionContext {
  schemaVersion: 1;
  currentProject: {
    projectId: string;
    releaseId: string | null;
    sourceVersion: string | null;
    status: "ready" | "no_release" | "stale" | "unsupported";
  };
  currentProjectFacts: CitedProjectFact[];
  hardConstraints: CitedConstraint[];
  applicableExperiences: CitedExperienceProjection[];
  rejectedExperiences: Array<{
    experienceId: string;
    reasons: ApplicabilityRejectionReason[];
  }>;
  unknowns: Array<{ key: string; reason: string; requiredForRecommendation: boolean }>;
  changeImpact: CitedImpact[];
  verificationPlan: CitedVerificationStep[];
}
```

工具输入必须包含 `currentProjectId` 和最长 2,000 字符的任务描述；可选 changed paths 必须经过项目路径验证。新工具使用独立的 `workspace.solutions.read` scope，不自动授予现有 workspace Token。稳定 transport/auth 错误至少包括：

- `INVALID_INPUT`
- `PROJECT_ACCESS_DENIED`
- `WORKSPACE_TOKEN_EXPIRED`
- `EXPERIENCE_EVIDENCE_REVOKED`
- `CITATIONS_MISSING`
- `INTERNAL_ERROR`

`no_release`、`stale`、`unsupported` 和没有适用经验都是正常产品状态，不返回 transport error。没有适用经验时仍返回当前事实、未知项和验证建议，但 `applicableExperiences=[]`，不得由服务端生成无证据方案。原 `dkh_find_prior_implementations` 保留，继续只返回历史参考。

### 9.3 LLM 边界

- LLM 关闭时，MCP 仍返回完整的结构化解决问题上下文。
- Codex 或其他调用方可以据此组织自然语言和代码方案，但必须保留分区与引用。
- 手动构建中的可选 LLM 只能补充摘要，不可创建观察事实、决策、结果、适用条件或 Trust。
- 产品不承诺控制任意第三方模型的最终行为；可验证承诺是服务端不会提供不合格经验，并通过官方 Codex 黄金流程验证回答合同。

## 10. 反馈与治理闭环

### 10.1 反馈事件

支持 `considered`、`adopted`、`partially_adopted`、`rejected`、`failed` 和 `rolled_back`。每个事件绑定 workspace、用户、当前项目、source version、experience id、任务摘要和来源权限快照。

反馈只追加，不修改历史事件。普通用户反馈不进入个人画像，不按个人建立偏好模型；产品只展示 workspace 级聚合和可审计事件。

### 10.2 自动动作边界

- 一个 `signed_ci failed` 或管理员确认的 `rolled_back` 创建高优先级复审项，并暂停该证据的默认推荐资格。
- 普通用户的负面反馈创建普通复审项，不自动降级全局经验。
- 多次成功只能提升结果可信维度，不能越过管理员批准将 `verified` 自动升级为 `recommended`。
- 经验内容修订创建新 revision；历史回答继续绑定旧 revision。

### 10.3 Knowledge Lint

新增治理规则：缺少引用、批准 basis 失权、条件互相矛盾、框架版本过期、结果 source version 不匹配、标准引用受限项目文案、deprecated 仍被推荐、superseded 循环。问题进入现有 remediation 风格的审核队列，但修复不会自动发布项目 release。

## 11. 产品体验

### 11.1 冷启动

- 零个历史 release：只显示当前项目事实、影响和验证计划，明确“暂无团队经验”。
- 一个合格历史 release：可以显示单项目参考，但不能自动宣称团队推荐。
- 两个及以上独立合格项目：可形成 `verified` 候选；仍需管理员批准才默认推荐。
- 无当前项目：只允许团队知识搜索，不生成当前项目约束或解决方案计划。

### 11.2 管理界面

“团队知识”增加经验库和审核队列：

- 按五类 V1 能力、框架、版本、状态和 Trust 过滤。
- 查看适用条件、禁止条件、证据项目、release、citation 和结果。
- 对候选执行验证、推荐、设为标准、驳回、废弃和替代。
- 对两个可见实现进行证据对比，不给出无证据的“最优”结论。
- 清楚区分代码观察、人工决策和运行结果。

审核支持批量处理“同一能力、相同实现签名、相同条件”的候选，但批准动作必须展示最终 basis，不允许盲批。

### 11.3 工程师使用方式

工程师在 Codex 中配置 project MCP 和 workspace MCP。日常问题优先调用 `dkh_plan_frontend_solution`；需要浏览历史实现时再调用 `dkh_find_prior_implementations`。输出固定显示当前项目事实、硬约束、适用经验、排除原因、未知项、影响和验证计划。

## 12. 质量指标

### 12.1 保留指标

- citation validity = 100%。
- unauthorized/unpublished leakage = 0。
- Recall@5 >= 0.92，MRR >= 0.80。
- core entity F1 >= 0.92，fact-edge precision >= 0.95。
- impact Top-10 precision >= 0.85，test-impact recall >= 0.90。

### 12.2 新增经验指标

- source provenance 分类准确率 = 100%。
- 硬冲突进入默认推荐 = 0。
- deprecated、rejected 或 basis 失权经验进入默认推荐 = 0。
- 默认推荐适用性 precision >= 0.95。
- 关键条件未知时正确拒绝推荐率 >= 0.95。
- 当前项目混入 prior references = 0。
- AI 上下文分区合同有效率 = 100%。
- 经验查询 P95 <= 1 秒；解决问题上下文 P95 <= 1.5 秒。
- ACL/release/session 变化后的下一次查询不得命中旧权限投影。

每个 V1 能力至少包含 12 条 train 和 8 条 held-out 经验适用性样本；整体中文不少于 40%，硬冲突、无结果、未知条件和未授权负例合计不少于 25%。held-out 项目不得与 analyzer fixture 或人工审批样本复用。

## 13. 黄金流程

### 13.1 新项目 ECharts 下钻

当前项目为 React/Vite + Zustand + React Router，历史项目同时存在适用 React 实现、未授权秘密实现和 Vue 实现。系统必须只推荐可见且兼容的 React 经验，列出 Vue 候选因框架冲突被排除，不得让秘密实现影响标题、计数、Trust 或排序，并返回受影响页面、路由、store、API 和测试。

### 13.2 条件未知时克制回答

当前 release 无法确定路由模式或图表数据量约束。系统必须把该条件放入 `unknowns`，不输出默认推荐，并给出需要确认的最小信息和可执行验证步骤。

### 13.3 经验失败后的治理

推荐经验在绑定 source version 的签名 CI 中失败或被管理员确认回滚。系统立即暂停相关证据的默认推荐资格，创建复审项，保留历史回答和 revision，不影响无关项目证据。

### 13.4 来源与新鲜度

Git release、未证明 upload、管理员证明 upload 和 git-linked upload 同时存在。项目事实均可查询，但只有符合来源资格和新鲜度合同的证据能够参与自动验证或默认推荐。

### 13.5 权限即时失效

用户失去某历史项目权限后，下一次 REST/MCP 查询的经验、决策、结果、计数、Trust、排序、替代关系和缓存均不受该项目影响。

## 14. 安全与恢复

- 经验表全部使用 workspace 复合外键；跨项目 evidence 必须在服务层进行实时 ACL 过滤。
- 决策正文、反馈摘要和 CI 结果执行长度、字符、秘密模式和 HTML 转义验证。
- 不保存原始 CI 日志、模型提示词、个人行为画像或未授权项目聚合文本。
- workspace Token 新 scope 必须最小化、可撤销、最长 30 天、DB 只存 hash/prefix，并受 session version 约束。
- 备份和恢复覆盖来源合同、project profile artifact、经验、审核、结果、反馈和审计；恢复后重新验证 basis 与 ACL，不直接信任缓存。
- 项目删除、release 撤权和 workspace 删除必须定义 evidence 失效、内容清理和审计保留规则。审计可保留 opaque id、动作和时间，不保留已要求删除的源码或经验正文。

## 15. 交付顺序

本设计不回写已经完成的 FK01-FK16。FK17 保留独立生产授权和 `0035_source_blobs_contract.sql` 边界。FK17、FK18 完成后，在原 FK19 前插入 Experience Kernel（EX）阶段：

1. `EX01`：修订产品完成定义、能力矩阵和来源政策。
2. `EX02`：来源类型、Git commit/content version 和兼容迁移。
3. `EX03`：`frontend-project-profile@1` artifact 与 release 绑定。
4. `EX04`：观察事实、声明决策、验证结果和经验生命周期合同。
5. `EX05`：只生成实现模式的候选提取，不自动生成决策原因。
6. `EX06`：人工审核、workspace 标准和可信结果接入。
7. `EX07`：ACL 投影、缓存失效、适用性硬过滤和排序。
8. `EX08`：workspace MCP 编排工具与稳定错误合同。
9. `EX09`：经验库、审核队列、对比和反馈界面。
10. `EX10`：Knowledge Lint、Trust 和复审闭环。
11. `EX11`：专项评测、五条黄金流程和安全负例。
12. `EX12`：staging 恢复、压力、回滚和 V1 Trial 交付门禁。

原 FK19-FK22 随后调整为消费 EX 合同，不再自行发明 pattern、Trust 或 MCP 响应结构。原 FK23 量化门禁增加本设计的经验指标；FK25/FK26 增加经验回滚、CI 结果失效和 ACL 投影验证。Next.js、Vue/Nuxt 复用同一经验合同，只增加框架画像、适用性 predicates、fixtures 和 held-out 数据。

迁移编号在实施计划中固定为：FK17 保留 `0035`；EX 来源合同从 `0036` 开始；原计划尚未实施的 workspace patterns 和 workspace MCP migrations 顺延。任何 migration 仍须同步更新 Drizzle schema、迁移测试、PostgreSQL integration、备份和恢复完整性查询。

## 16. 发布边界

- EX01-EX11 只在本地和完全隔离的 staging 开发验证，不访问生产。
- EX12 只生成 staging 证据，不自动切换生产。
- 经验决策内核不能绕过原 V1 Trial、V1 Production、四角色复审和用户逐级授权。
- 生产 `active`、新 MCP scope、CI webhook 凭据和数据库 contract 均需要各自的用户明确授权。
- 回滚关闭解决问题编排和默认推荐，恢复为“当前项目事实 + 历史实现参考”；不删除不可变 release、审核历史或恢复证据。

## 17. 最终完成定义

只有同时满足以下条件，才能称为“AI + 前端知识库快速、精准解决类似问题”：

1. 当前项目事实来自对应 release，项目源版本和新鲜度明确。
2. 历史经验来自调用者有权访问的已发布证据。
3. 代码观察、人工决策和运行结果不会互相伪装。
4. 硬冲突、未知关键条件、废弃经验和失权 basis 不进入默认推荐。
5. 推荐包含适用原因、排除原因、取舍、影响和验证计划。
6. 无适用证据时系统正确克制，不把模型常识冒充团队经验。
7. 反馈能够触发复审和暂停推荐，但不能未经审核改写历史。
8. 五类 V1 问题在真实 React/Vite 项目完成端到端黄金流程，并通过量化、安全、恢复和回滚门禁。

达到该状态后，Git 继续负责项目事实，项目知识负责快速理解当前代码，经验决策内核负责跨项目复用经过边界约束的工程判断。
