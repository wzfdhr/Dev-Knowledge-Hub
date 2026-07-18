import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";

import { analyticsRouter } from "./routes";

createRoot(document.getElementById("analytics-root")!).render(
  <StrictMode><RouterProvider router={analyticsRouter} /></StrictMode>
);
