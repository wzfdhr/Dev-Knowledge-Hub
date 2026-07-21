import { create } from "zustand";

interface AnalyticsState { summary: string; setSummary(value: string): void }

export const useAnalyticsStore = create<AnalyticsState>((set) => ({
  summary: "",
  setSummary: (summary) => set({ summary })
}));
