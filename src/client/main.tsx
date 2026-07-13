import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp, ConfigProvider } from "antd";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import "antd/dist/reset.css";
import "./styles.css";
import "./responsive.css";
import { App } from "./app";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 2_000, retry: 1 } } });

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <ConfigProvider theme={{ token: { colorPrimary: "#1769e0", borderRadius: 6, fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" } }}>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter><App /></BrowserRouter>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  </StrictMode>
);
