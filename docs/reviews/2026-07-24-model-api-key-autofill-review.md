# 模型 API Key 自动填充修复审查

日期：2026-07-24
范围：线上设置页的模型 API Key 输入框。

## 发现与根因

线上只读检查发现浏览器会向该密码输入框自动填入本地保存的历史凭据。服务端 `GET /api/settings/model` 和 `PUT /api/settings/model` 已经只返回 `provider`、`model` 与 `hasApiKey`，不会返回明文密钥；部署产物也与该实现一致。

问题发生在浏览器自动填充层：`autocomplete="off"` 不能可靠阻止浏览器把该控件识别为账号密码字段。这样可能导致管理员在只修改模型或服务商时意外提交浏览器填入的错误值。

## 修复

- 输入框保持 `type="password"`，不在页面回显任何保存值。
- 使用独立的 `name="model-api-key"`。
- 使用 `autocomplete="new-password"`，将输入明确标为新凭据而非可恢复的登录密码，降低浏览器自动填充的风险。
- 增加客户端回归测试；服务端已有脱敏响应测试一并运行。

## 角色化审批

以下为基于代码、自动化测试和线上只读证据的角色化审查，不代表外部人员签署。

| 角色 | 审查结论 | 依据 |
| --- | --- | --- |
| 技术经理 | 通过 | 密钥只保留在本次提交请求中；服务端响应继续是脱敏元数据；新增回归测试锁定自动填充属性。 |
| 产品经理 | 通过 | 初次配置仍要求输入密钥；已有密钥时仍可留空保留；降低无意覆盖风险。 |
| 美术经理 | 通过 | 不改变页面结构、文案、间距或视觉层级；输入框标签和密码掩码保持不变。 |

## 验证记录

- `npm test -- src/client/app.test.tsx src/server/model-settings.test.ts`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npx vitest run --reporter=dot`
