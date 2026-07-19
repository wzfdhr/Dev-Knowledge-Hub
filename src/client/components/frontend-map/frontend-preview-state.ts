import { ApiError } from "../../api/client";
import type { FrontendPreviewResponse } from "../../api/types";

export type FrontendPreviewStateCode =
  | "source_missing" | "build_missing" | "build_failed" | "candidate_failed" | "candidate_pending"
  | "candidate_unpublished" | "snapshot_updated" | "graph_empty" | "permission_lost"
  | "network_failure" | "citation_invalid";

export interface FrontendPreviewStateDescriptor {
  code: FrontendPreviewStateCode;
  title: string;
  happened: string;
  safety: string;
  next: string;
  retry: string;
  severity: "neutral" | "warning" | "danger" | "success";
}

const state = (value: FrontendPreviewStateDescriptor) => value;

export function frontendPreviewErrorState(error: unknown): FrontendPreviewStateDescriptor {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return state({ code: "permission_lost", title: "预览权限已失效", happened: "当前账号不再具备工作区管理员权限，或会话已经失效。", safety: "候选构建和正式知识均未被修改。", next: "重新登录，或请工作区管理员确认权限。", retry: "恢复权限后可安全重试，不会重复发布。", severity: "danger" });
  }
  return state({ code: "network_failure", title: "暂时无法读取预览", happened: "浏览器未能连接服务，或服务返回了不可恢复的读取错误。", safety: "这是只读请求，候选构建和正式知识均未被修改。", next: "检查网络与服务健康状态后重新加载。", retry: "读取请求幂等，可安全重试。", severity: "danger" });
}

export function frontendPreviewState(response: FrontendPreviewResponse): FrontendPreviewStateDescriptor {
  if (response.status === "source_missing") return state({ code: "source_missing", title: "尚未导入前端资料", happened: "项目还没有可分析的资料来源。", safety: "项目数据为空，没有丢失或覆盖任何正式知识。", next: "前往资料页导入 React/Vite 项目。", retry: "导入操作按新快照执行，失败后可安全重试。", severity: "neutral" });
  if (response.status === "build_missing") return state({ code: "build_missing", title: "等待首次构建", happened: "资料已经导入，但还没有构建记录。", safety: "上传快照已保存，正式发布未改变。", next: "手动发起一次影子构建。", retry: "构建按快照去重，可安全重试。", severity: "neutral" });
  if (response.status === "build_failed") return state({ code: "build_failed", title: "最新构建失败", happened: "旧内核或影子流水线未能完成最新构建。", safety: "失败构建不会替换当前正式发布。", next: "在构建详情查看失败阶段，修复后重新构建。", retry: "修复原因后重试会创建新 attempt，不覆盖失败证据。", severity: "danger" });
  if (response.status === "candidate_failed") return state({ code: "candidate_failed", title: "影子候选构建失败", happened: `新内核在 ${response.failedStage?.stage ?? "未知"} 阶段失败${response.failedStage?.errorCode ? `（${response.failedStage.errorCode}）` : ""}。`, safety: "旧内核正式发布、搜索和 MCP 继续可用。", next: "在构建详情检查失败阶段，修复后重新发起影子构建。", retry: "重试会创建新 attempt，失败证据不会被覆盖，也不会自动发布。", severity: "danger" });
  if (response.status === "candidate_pending") return state({ code: "candidate_pending", title: "候选包仍在生成", happened: "影子流水线尚未完成 terminal package。", safety: "旧内核继续提供正式知识，候选结果不会进入搜索或 MCP。", next: "等待阶段完成，必要时在构建详情检查队列。", retry: "读取可重复；不要在任务运行时重复发起相同构建。", severity: "warning" });
  if (response.status !== "ready") throw new Error(`Unsupported frontend preview status: ${response.status}`);
  if (!response.comparison.citations.valid || !response.preview.validation.valid) return state({ code: "citation_invalid", title: "候选引用校验未通过", happened: "候选知识存在无效引用或 package 校验失败。", safety: "候选包未发布，正式知识和 MCP 不受影响。", next: "检查无效引用和 validate 阶段，再重新构建。", retry: "修复后重建是幂等的，不会自动发布。", severity: "danger" });
  if (response.preview.graph.nodes.length === 0) return state({ code: "graph_empty", title: "候选图谱为空", happened: "构建完成，但分析器没有生成可展示的前端实体。", safety: "原始快照和正式知识仍然安全。", next: "确认项目包含受支持的前端源码，并查看 extract 与 graph 阶段。", retry: "调整资料或分析配置后可安全重建。", severity: "warning" });
  if (response.stale) return state({ code: "snapshot_updated", title: "资料已更新，候选包待重建", happened: "当前候选包对应的快照早于项目最新快照。", safety: "旧候选包仍可审阅，正式发布未自动改变。", next: "对最新快照手动发起影子构建。", retry: "相同快照会复用有效产物，不会重复发布。", severity: "warning" });
  return state({ code: "candidate_unpublished", title: "候选包可供验收", happened: "新内核已生成完整候选知识，但尚未成为正式发布。", safety: "正式搜索、知识页面和 MCP 仍读取旧内核发布。", next: "比较新旧结果、来源引用和变更影响。", retry: "此页面只读，刷新不会触发构建或发布。", severity: "success" });
}
