import createClient from "openapi-fetch";

interface AnalyticsPaths {
  "/accounts/{accountId}/analytics": {
    get: { responses: { 200: { content: { "application/json": { summary: string } } } } };
  };
}

const analyticsApi = createClient<AnalyticsPaths>({ baseUrl: "/api" });

export async function fetchAnalyticsContract(accountId: string) {
  return analyticsApi.GET("/accounts/{accountId}/analytics", {
    params: { path: { accountId } }
  });
}
