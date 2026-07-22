import { forwardRef, type ReactNode } from "react";

export const CardPrimitive = forwardRef<HTMLElement, { children?: ReactNode }>(
  function CardPrimitive({ children }, ref) {
    return <article ref={ref}>{children}</article>;
  }
);
