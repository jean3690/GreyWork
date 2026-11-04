import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

/**
 * 运维台是控制面（back/grey）的附属前端，不是产品 SPA：
 *
 * - base 固定 /admin/：Spring 把构建产物当静态资源挂在 /admin 下，路由用 hash，
 *   因此不需要服务端 history fallback（控制面只认 /admin 与 /admin/）。
 * - outDir 直接写进后端的 src/main/resources/static/admin：mvn package 就是一个
 *   自带前端的 jar，部署不需要 Node。产物随源码入库，见 docs/control-plane-auth.md。
 * - dev 端口 5174：与 web（1421）/ 桌面（1420）错开；/api 走代理，避免开发期 CORS。
 */
export default defineConfig({
  base: "/admin/",
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
  build: {
    // 后端静态目录。emptyOutDir 必须显式为 true：目标在 vite root 之外，
    // 不写 Vite 会拒绝清空，旧哈希产物就会一直堆在 jar 里。
    outDir: "../../back/grey/src/main/resources/static/admin",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
});
