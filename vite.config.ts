import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import vue from "@vitejs/plugin-vue";

const productionApi = "https://izbp13w996yh3m83ypf3crz.tailf6e278.ts.net";
const apiTarget = process.env.DEVKH_API_PROXY_TARGET ?? productionApi;

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
  plugins: [react(), vue()],
  build: {
    outDir: "dist/client",
    rollupOptions: {
      input: {
        react: fileURLToPath(new URL("./index.html", import.meta.url)),
        vue: fileURLToPath(new URL("./console-vue/index.html", import.meta.url))
      }
    }
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
