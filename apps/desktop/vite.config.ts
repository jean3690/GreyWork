import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const host = process.env.TAURI_DEV_HOST;

// rxjs 7.0 的 exports 默认指向 dist/esm5（且 dist/esm 入口缺失操作符导出），
// @univerjs/core 引入 rxjs 时构建报 "filter is not exported"。workbench 显式依赖
// rxjs@7.8.2（dist/esm 完整导出），此处 alias 统一到该 ESM 构建。
const rxjsEsm = fileURLToPath(new URL("../../node_modules/.pnpm/rxjs@7.8.2/node_modules/rxjs/dist/esm", import.meta.url));

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      rxjs: rxjsEsm,
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    // Web 预览环境的市场通道：浏览器直连 skills.sh / MCP 注册表被 CORS 拦截，
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    proxy: {
      // /market-api/skills/* → https://www.skills.sh/*；/market-api/mcp/* → https://registry.modelcontextprotocol.io/*
      // 仅 Web 预览（非 Tauri IPC）使用；桌面端仍走 Rust 宿主代理。
      "/market-api/skills": {
        target: "https://www.skills.sh",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/market-api\/skills/, ""),
      },
      "/market-api/mcp": {
        target: "https://registry.modelcontextprotocol.io",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/market-api\/mcp/, ""),
      },
      "/market-api/plugins": {
        target: "https://raw.githubusercontent.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/market-api\/plugins/, "/jean3690/greywork-plugin-market/main"),
      },
    },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
