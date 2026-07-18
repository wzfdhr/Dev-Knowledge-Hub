import axios from "axios";

export async function fetchAnalyticsSummary(accountId: string): Promise<string> {
  const response = await axios.get<{ summary: string }>(`/api/accounts/${accountId}/analytics`);
  return response.data.summary;
}
