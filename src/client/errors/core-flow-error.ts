import { ApiError } from "../api/client";

export type CoreFlowOperation = "upload" | "build" | "publish" | "graph";

export interface CoreFlowErrorDescriptor {
  operation: CoreFlowOperation;
  operationLabel: string;
  title: string;
  summary: string;
  safety: string;
  nextStep: string;
  retryable: boolean;
  diagnosticId: string;
}

const operationLabels: Record<CoreFlowOperation, string> = {
  upload: "资料接入",
  build: "知识生产",
  publish: "版本发布",
  graph: "知识图谱"
};

const safetyByOperation: Record<CoreFlowOperation, string> = {
  upload: "已验证的上传文件会在会话有效期内保留；当前已发布知识不会自动变化。",
  build: "候选构建不会自动覆盖已发布知识、搜索或 MCP。",
  publish: "当前已发布版本保持不变，未完成的发布不会替换线上知识。",
  graph: "图谱读取失败不会修改已发布知识、资料或候选构建。"
};

function descriptor(
  operation: CoreFlowOperation,
  value: Omit<CoreFlowErrorDescriptor, "operation" | "operationLabel" | "safety">
): CoreFlowErrorDescriptor {
  return {
    operation,
    operationLabel: operationLabels[operation],
    safety: safetyByOperation[operation],
    ...value
  };
}

export function describeCoreFlowError(operation: CoreFlowOperation, error: unknown): CoreFlowErrorDescriptor {
  if (!(error instanceof ApiError)) {
    return descriptor(operation, {
      title: "连接暂时不可用",
      summary: "浏览器暂时无法完成与服务的连接。",
      nextStep: "检查网络连接后重试；资料、构建和已发布版本不会被自动修改。",
      retryable: true,
      diagnosticId: "NETWORK_UNAVAILABLE"
    });
  }

  if (error.status === 429 || error.code === "RATE_LIMITED") {
    return descriptor(operation, {
      title: "操作被暂时限流",
      summary: "服务正在保护当前任务，暂时不能继续处理请求。",
      nextStep: "请等待片刻后再安全重试。",
      retryable: true,
      diagnosticId: error.code
    });
  }

  if (error.code === "FORBIDDEN" || error.status === 403) {
    return descriptor(operation, {
      title: "当前账号没有执行此操作的权限",
      summary: "该操作需要项目成员或管理员权限。",
      nextStep: "请确认你仍在该项目中，并联系管理员调整角色后重试。",
      retryable: false,
      diagnosticId: error.code
    });
  }

  if (operation === "upload") {
    if (["UPLOAD_SESSION_EXPIRED", "UPLOAD_SESSION_INVALIDATED", "UPLOAD_SESSION_NOT_FOUND", "UPLOAD_SESSION_STATE", "IDEMPOTENCY_KEY_REUSED"].includes(error.code)) {
      return descriptor(operation, {
        title: "上传会话已失效",
        summary: "当前会话无法继续提交，可能已过期、被替换或与当前项目状态不一致。",
        nextStep: "刷新导入历史确认结果，再重新选择同一文件夹开始新的上传。",
        retryable: false,
        diagnosticId: error.code
      });
    }
    if (["INVALID_UPLOAD_MANIFEST", "MANIFEST_DIGEST_MISMATCH", "MANIFEST_PAGE_LIMIT"].includes(error.code)) {
      return descriptor(operation, {
        title: "上传文件清单未通过校验",
        summary: "浏览器选择的文件与服务端确认的清单不一致，提交已停止。",
        nextStep: "刷新页面后重新选择文件夹；请勿在上传过程中修改文件结构。",
        retryable: false,
        diagnosticId: error.code
      });
    }
    if (error.status >= 500) {
      return descriptor(operation, {
        title: "上传提交暂未完成",
        summary: "服务端未能完成本次资料快照写入。",
        nextStep: "可直接安全重试；系统会复用已验证文件，不会重复创建已发布知识。",
        retryable: true,
        diagnosticId: error.code
      });
    }
  }

  if (operation === "build" && error.code === "PIPELINE_STAGE_FAILED") {
    return descriptor(operation, {
      title: "知识构建在某个阶段失败",
      summary: "候选流水线没有生成可审核的知识包。",
      nextStep: "查看构建详情中的失败阶段，修复资料或配置后重新发起构建。",
      retryable: false,
      diagnosticId: error.code
    });
  }

  if (operation === "graph" && error.code === "FRONTEND_PREVIEW_INVALID") {
    return descriptor(operation, {
      title: "前端候选包尚未达到可查看状态",
      summary: "当前候选包不完整或校验未通过，不能展示 React 前端地图。",
      nextStep: "在构建详情检查候选阶段，修复后重新发起影子构建。",
      retryable: false,
      diagnosticId: error.code
    });
  }

  if (error.status >= 500) {
    return descriptor(operation, {
      title: "服务暂未完成本次操作",
      summary: "服务端返回了临时失败，未提供可安全展示的具体原因。",
      nextStep: "请稍后重试；若持续发生，请复制诊断编号提供给支持人员。",
      retryable: true,
      diagnosticId: error.code
    });
  }

  return descriptor(operation, {
    title: "操作未完成",
    summary: "当前请求未通过服务端校验或无法继续执行。",
    nextStep: "核对当前页面的输入与操作状态后再试；如仍失败，请复制诊断编号。",
    retryable: false,
    diagnosticId: error.code
  });
}
