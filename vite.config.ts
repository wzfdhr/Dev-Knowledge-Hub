import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/client"
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/mcp": "http://127.0.0.1:3000",
      "/__test__": "http://127.0.0.1:3000"
    }
  }
});
