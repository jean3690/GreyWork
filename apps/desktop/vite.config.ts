import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

const host = process.env.TAURI_DEV_HOST;

/**
 * pdf.js 的运行时资源：CJK 的 CMap、非嵌入字体的标准字体表、JBIG2/JPEG2000/QCMS 的 wasm。
 *
 * 缺了它们 pdf.js **不报错**，只是字不见了或断字错乱 —— 中文/日文 PDF 尤其明显。
 * 所以这几份资源必须随包发出，指向的 URL 见 PdfViewer.vue 的 getDocument。
 *
 * 解析起点是 workbench 的 package.json：pdfjs-dist 是 workbench 的依赖，从 apps/desktop
 * 解析不到（pnpm 不做提升）。这样也不必把版本号写进路径。
 */
const workbenchRequire = createRequire(fileURLToPath(new URL("../../packages/workbench/package.json", import.meta.url)));
const pdfjsDist = path.dirname(workbenchRequire.resolve("pdfjs-dist/package.json"));

// rxjs 7 的 exports 里 default 指向 dist/esm5（只有 es2015 条件才指 dist/esm），而 esm5 那份的
// 入口缺操作符导出 —— @univerjs/core 引入 rxjs 时构建报 "filter is not exported"。
// workbench 显式依赖 rxjs，其 dist/esm 导出完整，所以把 rxjs 统一 alias 过去。
//
// 路径同样从 workbench 解析，不写死 `node_modules/.pnpm/rxjs@7.8.2/...`：pnpm 的目录名带版本号，
// rxjs 一升级 alias 就指到不存在的目录（构建报模块找不到，与上面 pdfjs 同一个取法）。
const rxjsEsm = path.join(path.dirname(workbenchRequire.resolve("rxjs/package.json")), "dist", "esm");

const PDFJS_ASSET_DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"] as const;

/**
 * glob 模式必须是 POSIX 分隔符：tinyglobby 对绝对模式做 `posix.relative(cwd, pattern)`
 * （cwd 已归一成 `/`，模式没有），Windows 原生路径会被当成单段字符串算出乱码，
 * 结果是 "No file was found to copy" 直接构建失败。只在拼模式时归一，其余仍用原生路径。
 */
const pdfjsDistPosix = pdfjsDist.split(path.sep).join("/");

/**
 * vite-plugin-static-copy 的相对路径以 vite root 为基准：pdfjs-dist 在 root 之外的
 * node_modules，插件只会剥掉开头的 `../`，于是产出
 * `dist/pdfjs/node_modules/.pnpm/pdfjs-dist@x/node_modules/pdfjs-dist/cmaps/...` ——
 * 与代码请求的 `/pdfjs/cmaps/` 对不上。404 之后 pdf.js 只会静默缺字，构建期毫无提示。
 *
 * `rename: { stripBase: true }` 正是用来抵消这段路径的（它按目录层数回退，再落到 dest）。
 * 代价是会把源目录**压平**，所以下面这几个目录必须没有子目录。
 */
for (const dir of PDFJS_ASSET_DIRS) {
  const nested = readdirSync(path.join(pdfjsDist, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (nested.length > 0) {
    throw new Error(
      `pdfjs-dist/${dir} 下出现了子目录：[${nested.join(", ")}]。` +
        `stripBase: true 会把它们压平到 /pdfjs/${dir}/ 根下，子目录里的文件将请求不到。` +
        `请改成按子目录分别配置 dest。`,
    );
  }
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    vue(),
    tailwindcss(),
    viteStaticCopy({
      targets: PDFJS_ASSET_DIRS.map((dir) => ({
        src: `${pdfjsDistPosix}/${dir}/**/*`,
        dest: `pdfjs/${dir}`,
        rename: { stripBase: true },
      })),
    }),
  ],
  resolve: {
    alias: {
      rxjs: rxjsEsm,
      // workbench 以源码方式消费（main 指向 packages/workbench/src/index.ts），其内部统一
      // 使用 @/ 别名指向本包 src 根；desktop 自身源码不用 @/，故直接映射到 workbench 根。
      "@": fileURLToPath(new URL("../../packages/workbench/src", import.meta.url)),
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
