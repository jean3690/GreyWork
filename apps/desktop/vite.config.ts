import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { fileURLToPath, URL } from "node:url";

// Cesium 运行时静态资源拷入 dist/cesium，配合 GreyWorkCore 动态 import 按需加载。
const cesiumSource = "node_modules/cesium/Build/Cesium";
const cesiumCopy = viteStaticCopy({
  targets: ["Assets", "ThirdParty", "Workers", "Widgets"].map((dir) => ({
    src: `${cesiumSource}/${dir}/*`,
    dest: `cesium/${dir}`,
  })),
});
const host = process.env.TAURI_DEV_HOST;

// rxjs 7.0 的 exports 默认指向 dist/esm5（且 dist/esm 入口缺失操作符导出），
// @univerjs/core 引入 rxjs 时构建报 "filter is not exported"。workbench 显式依赖
// rxjs@7.8.2（dist/esm 完整导出），此处 alias 统一到该 ESM 构建。
const rxjsEsm = fileURLToPath(new URL("../../node_modules/.pnpm/rxjs@7.8.2/node_modules/rxjs/dist/esm", import.meta.url));

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [vue(), cesiumCopy, tailwindcss()],
  resolve: {
    alias: {
      rxjs: rxjsEsm,
    },
  },
  define: {
    CESIUM_BASE_URL: JSON.stringify("./cesium/"),
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
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
