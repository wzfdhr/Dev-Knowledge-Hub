import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  build: { sourcemap: true },
  server: { proxy: { "/api": "http://127.0.0.1:3000" } }
});
