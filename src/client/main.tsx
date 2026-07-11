import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

const queryClient = new QueryClient();

function App() {
  return (
    <main>
      <BookOpen aria-hidden="true" size={28} />
      <h1>Dev Knowledge Hub</h1>
      <p>The clean-room application foundation is ready for MVP development.</p>
    </main>
  );
}

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>
);
