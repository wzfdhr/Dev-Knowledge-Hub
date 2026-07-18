import { createBrowserRouter } from "react-router-dom";

import { AnalyticsPage } from "./features/analytics/analytics-page";

export const analyticsRouter = createBrowserRouter([
  { path: "/analytics/:accountId", element: <AnalyticsPage accountId="demo" /> }
]);
