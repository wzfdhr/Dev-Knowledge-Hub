import axios from "axios";

export interface DashboardResponse { title: string; values: number[] }

export async function loadDashboard(teamId: string): Promise<DashboardResponse> {
  return (await axios.get<DashboardResponse>(`/api/teams/${teamId}/dashboard`)).data;
}
