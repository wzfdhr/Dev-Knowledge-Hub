import { Alert, Button, Empty as AntEmpty, Spin, Tag } from "antd";
import type { ReactNode } from "react";

import { statusLabel } from "../copy";

export function Loading({ label = "加载中" }: { label?: string }) {
  return <div className="state" role="status"><Spin size="small" /><span>{label}</span></div>;
}
export function ErrorState({
  message,
  retry,
  description
}: {
  message: string;
  retry?: () => void;
  description?: string;
}) {
  return <Alert
    className="state error"
    type="error"
    showIcon
    message={message}
    description={description ?? (retry ? "本次重试只重新读取当前状态，不会修改资料、构建或已发布版本。" : undefined)}
    action={retry && <Button size="small" autoInsertSpace={false} onClick={retry}>重试</Button>}
  />;
}
export function Empty({ children }: { children: ReactNode }) {
  return <AntEmpty className="empty" image={AntEmpty.PRESENTED_IMAGE_SIMPLE} description={children} />;
}
export function Status({ value }: { value: string }) {
  return <Tag className={`status status-${value}`}>{statusLabel(value)}</Tag>;
}
