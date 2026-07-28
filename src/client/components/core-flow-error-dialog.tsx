import { Button, Modal } from "antd";
import { Copy, RotateCcw, TriangleAlert } from "lucide-react";
import { useState } from "react";

import type { CoreFlowErrorDescriptor } from "../errors/core-flow-error";

function ErrorDetails({ descriptor }: { descriptor: CoreFlowErrorDescriptor }) {
  const [copied, setCopied] = useState(false);
  const copyDiagnosticId = async () => {
    try {
      await navigator.clipboard?.writeText(descriptor.diagnosticId);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return <dl className="core-flow-error-details">
    <div><dt>发生了什么</dt><dd>{descriptor.summary}</dd></div>
    <div><dt>数据安全</dt><dd>{descriptor.safety}</dd></div>
    <div><dt>下一步</dt><dd>{descriptor.nextStep}</dd></div>
    <div><dt>诊断编号</dt><dd><code>{descriptor.diagnosticId}</code><Button type="link" size="small" icon={<Copy aria-hidden="true" />} onClick={() => void copyDiagnosticId()}>复制</Button>{copied && <span role="status">已复制</span>}</dd></div>
  </dl>;
}

export function CoreFlowErrorCard({ descriptor, onRetry }: {
  descriptor: CoreFlowErrorDescriptor;
  onRetry?: () => void;
}) {
  const canRetry = descriptor.retryable && onRetry;
  return <section className="core-flow-error-card" role="alert" aria-label={`${descriptor.operationLabel}错误详情`}>
    <header><TriangleAlert aria-hidden="true" /><div><p>{descriptor.operationLabel} · 需要处理</p><h2>{descriptor.title}</h2></div></header>
    <p>{descriptor.summary}</p>
    <details>
      <summary>查看错误详情</summary>
      <ErrorDetails descriptor={descriptor} />
    </details>
    {canRetry && <Button icon={<RotateCcw aria-hidden="true" />} onClick={onRetry}>安全重试</Button>}
  </section>;
}

export function CoreFlowErrorDialog({ descriptor, open, onClose, onRetry }: {
  descriptor: CoreFlowErrorDescriptor | null;
  open: boolean;
  onClose: () => void;
  onRetry?: () => void;
}) {
  if (!descriptor) return null;
  const canRetry = descriptor.retryable && onRetry;
  const retry = () => {
    onRetry?.();
    onClose();
  };
  return <Modal
    className="core-flow-error-dialog"
    open={open}
    title={descriptor.title}
    onCancel={onClose}
    footer={<>{canRetry && <Button type="primary" icon={<RotateCcw aria-hidden="true" />} onClick={retry}>安全重试</Button>}<Button onClick={onClose}>{canRetry ? "暂不重试" : "我知道了"}</Button></>}
  >
    <div className="core-flow-error-dialog-body"><TriangleAlert aria-hidden="true" /><ErrorDetails descriptor={descriptor} /></div>
  </Modal>;
}
