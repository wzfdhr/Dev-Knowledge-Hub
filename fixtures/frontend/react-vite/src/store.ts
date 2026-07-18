import { create } from "zustand";

interface DashboardState { title: string; setTitle(title: string): void }

export const useDashboardStore = create<DashboardState>((set) => ({
  title: "Dashboard",
  setTitle: (title) => set({ title })
}));
