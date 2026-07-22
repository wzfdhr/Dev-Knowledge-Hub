import { DashboardCard } from "./dashboard-ecosystem";

const meta = {
  component: DashboardCard,
  decorators: [(Story: () => React.ReactNode) => <main><Story /></main>]
};

export default meta;

export const Default = {
  args: { title: "Operations dashboard" }
};
