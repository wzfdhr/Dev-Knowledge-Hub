import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import "./styles.css";
import { App } from "./app";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 2_000, retry: 1 } } });

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter><App /></BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
