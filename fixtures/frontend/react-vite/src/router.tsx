import { createBrowserRouter } from "react-router-dom";

import { DashboardPage } from "./app";

export const router = createBrowserRouter([
  { path: "/", lazy: async () => ({ Component: () => <DashboardPage teamId="core" /> }) }
]);
