import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const localApi = "http://127.0.0.1:3000";
const apiTarget = process.env.DEVKH_API_PROXY_TARGET ?? localApi;

function apiProxy(target: string) {
  return {
    target,
    changeOrigin: true,
    configure(proxy: { on(event: string, listener: (response: { headers: Record<string, string[] | undefined> }) => void): void }) {
      proxy.on("proxyRes", (response) => {
        const cookies = response.headers["set-cookie"];
        if (cookies) response.headers["set-cookie"] = cookies.map((cookie) => cookie.replace(/;\s*Secure/gi, ""));
      });
    }
  };
}

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/client"
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      "/api": apiProxy(apiTarget),
      "/mcp": apiProxy(apiTarget),
      "/__test__": apiProxy(apiTarget)
    }
  }
});
