import { Alert, Button, Empty as AntEmpty, Spin, Tag } from "antd";
import type { ReactNode } from "react";

import { statusLabel } from "../copy";

export function Loading({ label = "加载中" }: { label?: string }) {
  return <div className="state" role="status"><Spin size="small" /><span>{label}</span></div>;
}
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return <Alert className="state error" type="error" showIcon message={message} action={retry && <Button size="small" autoInsertSpace={false} onClick={retry}>重试</Button>} />;
}
export function Empty({ children }: { children: ReactNode }) {
  return <AntEmpty className="empty" image={AntEmpty.PRESENTED_IMAGE_SIMPLE} description={children} />;
}
export function Status({ value }: { value: string }) {
  return <Tag className={`status status-${value}`}>{statusLabel(value)}</Tag>;
}
