import { forwardRef, type ReactNode } from "react";

export const AnalyticsPrimitive = forwardRef<HTMLElement, { children?: ReactNode }>(
  function AnalyticsPrimitive({ children }, ref) {
    return <article ref={ref}>{children}</article>;
  }
);
