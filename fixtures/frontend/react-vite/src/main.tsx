import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";

import { SessionContext } from "./app";
import { router } from "./router";
import "./theme.scss";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionContext.Provider value={{ userId: "demo-user" }}>
      <RouterProvider router={router} />
    </SessionContext.Provider>
  </StrictMode>
);
