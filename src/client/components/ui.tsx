import { AlertCircle, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

export function Loading({ label = "Loading" }: { label?: string }) {
  return <div className="state" role="status"><LoaderCircle className="spin" aria-hidden="true" />{label}</div>;
}
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="state error" role="alert"><AlertCircle aria-hidden="true" /><span>{message}</span>{retry && <button className="button subtle" onClick={retry}>Try again</button>}</div>;
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Status({ value }: { value: string }) {
  return <span className={`status status-${value}`}>{value}</span>;
}
