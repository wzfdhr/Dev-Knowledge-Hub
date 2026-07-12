import { AlertCircle, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

import { statusLabel } from "../copy";

export function Loading({ label = "加载中" }: { label?: string }) {
  return <div className="state" role="status"><LoaderCircle className="spin" aria-hidden="true" />{label}</div>;
}
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="state error" role="alert"><AlertCircle aria-hidden="true" /><span>{message}</span>{retry && <button className="button subtle" onClick={retry}>重试</button>}</div>;
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Status({ value }: { value: string }) {
  return <span className={`status status-${value}`}>{statusLabel(value)}</span>;
}
