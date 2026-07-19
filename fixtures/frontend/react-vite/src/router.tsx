import { createBrowserRouter } from "react-router-dom";

import { DashboardPage } from "./app";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: DashboardPage,
    loader: async () => ({ teamId: "core" }),
    lazy: async () => ({ Component: DashboardPage })
  }
]);
