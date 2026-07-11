import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ApiClient } from "../api/client";
import type { AgentFeedbackStatus } from "../../server/persistence/store";

export const keys = {
  repository: ["repository"] as const,
  builds: ["builds"] as const,
  releases: ["releases"] as const,
  feedback: (status?: AgentFeedbackStatus) => ["feedback", status ?? "all"] as const,
  tokens: ["mcp-tokens"] as const
};

export function useRepository(api: ApiClient) {
  return useQuery({ queryKey: keys.repository, queryFn: api.getRepository, retry: false });
}

export function useFeedback(api: ApiClient, status?: AgentFeedbackStatus) {
  return useQuery({
    queryKey: keys.feedback(status),
    queryFn: () => api.listFeedback(status),
    refetchOnMount: "always"
  });
}

export function useFeedbackTransition(api: ApiClient) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: AgentFeedbackStatus }) => api.transitionFeedback(id, status),
    onSuccess: () => client.invalidateQueries({ queryKey: ["feedback"] })
  });
}
