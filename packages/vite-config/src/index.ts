/**
 * 前端共享的 Vite 配置工厂。
 *
 * 存在意义：本仓有多个前端（桌面端 / Web 端 / 移动端……），它们**只有 base、产物目录与特性集不同**，
 * 其余构建配置完全一致。这份配置里有几处「错了不会报错、只会静默降级」的坑（pdf.js 缺字、
 * rxjs 入口缺导出、语法底线被工具链升级顺手收窄），四处各抄一份必然漂移，所以收在这里一份。
 *
 * 承重注释随代码一起搬了过来 —— 每一条都对应一次真实的事故或一次差点发生的事故。
 */
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type UserConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

export interface FrontConfigOptions {
  /**
   * 产物与路由前缀。Web 端是 `"/"`，桌面端是 `"/desktop/"`。
   *
   * ⚠️ 改成非 `/` 之前先读 `emitsSharedAssets`：workbench 里有**硬编码的绝对运行时路径**
   * （`/vscode-icons/`、`/pdfjs/*`），Vite 的 base **不会**重写它们。
   */
  base?: string;
  /** 产物目录，相对 app 根。 */
  outDir?: string;
  /**
   * public 目录，相对 app 根或绝对路径。
   *
   * 缺省是**全仓共享**的 `packages/workbench/public`（见下面 `workbenchPublic` 的说明）——
   * 各前端不该各留一份。显式传值只在某个前端真要出不同资源时才有意义。
   */
  publicDir?: string;
  /** dev server 端口。 */
  devPort?: number;
  /**
   * 是否产出**根路径共享资源**（`/pdfjs/*`）。
   *
   * 整个部署里必须**恰好一个**前端为 true。理由：pdf.js 的四个资源 URL 与文件图标基址是
   * workbench 源码里的字符串字面量（见 `features/preview/PdfViewer.vue`、`lib/file-icons.ts`），
   * base 重写不到它们 —— 所以这些资源必须真的躺在根路径上，且不能按前端复制 N 份。
   */
  emitsSharedAssets?: boolean;
}

/**
 * pdf.js 的运行时资源：CJK 的 CMap、非嵌入字体的标准字体表、JBIG2/JPEG2000/QCMS 的 wasm。
 *
 * 缺了它们 pdf.js **不报错**，只是字不见了或断字错乱 —— 中文/日文 PDF 尤其明显。
 * 所以这几份资源必须随包发出，指向的 URL 见 PdfViewer.vue 的 getDocument。
 *
 * 解析起点是 workbench 的 package.json：pdfjs-dist 是 workbench 的依赖，从各 app 解析不到
 * （pnpm 不做提升）。这样也不必把版本号写进路径。
 */
const workbenchRequire = createRequire(fileURLToPath(new URL("../../workbench/package.json", import.meta.url)));
const pdfjsDist = path.dirname(workbenchRequire.resolve("pdfjs-dist/package.json"));

// rxjs 7 的 exports 里 default 指向 dist/esm5（只有 es2015 条件才指 dist/esm），而 esm5 那份的
// 入口缺操作符导出 —— @univerjs/core 引入 rxjs 时构建报 "filter is not exported"。
// workbench 显式依赖 rxjs，其 dist/esm 导出完整，所以把 rxjs 统一 alias 过去。
//
// 路径同样从 workbench 解析，不写死 `node_modules/.pnpm/rxjs@7.8.2/...`：pnpm 的目录名带版本号，
// rxjs 一升级 alias 就指到不存在的目录（构建报模块找不到，与上面 pdfjs 同一个取法）。
const rxjsEsm = path.join(path.dirname(workbenchRequire.resolve("rxjs/package.json")), "dist", "esm");

/** workbench 以源码方式消费（main 指向 src/index.ts），其内部统一用 `@/` 指向本包 src 根。 */
const workbenchSrc = fileURLToPath(new URL("../../workbench/src", import.meta.url));

/**
 * 共享的 public 目录 —— **所有前端同一份**。
 *
 * 里面是 `boot.js` / `boot.css` / `logo.svg` / `vscode-icons/`：前两者管首帧底色与启动打点
 *（必须是同源外链，理由见各 app 的 index.html 与 tests/unit/index-html.test.ts），后两者是
 * favicon 与文件树图标（`workbench/src/lib/file-icons.ts` 消费）。它们原来住在
 * `apps/desktop/public/`，多前端各留一份就是把这 6.3MB 与 1084 个 svg 复制 N 份，且必然漂移
 *（改了一端的 logo，另一端还是旧的）—— 所以收在 workbench 包下，各 app 默认都指过去。
 *
 * 注意 publicDir 的内容会被**每个**前端原样复制进自己的产物根，不做 base 前缀改写之外的
 * 过滤。于是非根 base 的前端也会带上 `vscode-icons/`（落在 `dist/desktop/vscode-icons/`），
 * 但运行时请求的是根路径 `/vscode-icons/`，永远不会打到那份副本上。这点冗余是刻意留下的：
 * 要省掉它就得把 `boot.js` / `boot.css` 从这份共享目录里拆出去单独发，而它们在非根 base 下
 * 恰恰必须跟着自己的产物走 —— 拆开只会更脆。
 */
const workbenchPublic = fileURLToPath(new URL("../../workbench/public", import.meta.url));

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
function assertPdfjsAssetDirsAreFlat(): void {
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
}

export function defineFrontConfig(options: FrontConfigOptions = {}): UserConfig {
  const { base = "/", outDir = "dist", publicDir = workbenchPublic, devPort = 1420, emitsSharedAssets = true } = options;

  if (emitsSharedAssets) assertPdfjsAssetDirsAreFlat();

  /** Tauri 壳已移除；保留该环境变量的读取仅为 S0 阶段行为不变（见迁移计划的遗留清理项）。 */
  const host = process.env.TAURI_DEV_HOST;

  return defineConfig({
    base,
    publicDir,
    plugins: [
      vue(),
      tailwindcss(),
      ...(emitsSharedAssets
        ? [
            viteStaticCopy({
              targets: PDFJS_ASSET_DIRS.map((dir) => ({
                src: `${pdfjsDistPosix}/${dir}/**/*`,
                dest: `pdfjs/${dir}`,
                rename: { stripBase: true },
              })),
            }),
          ]
        : []),
    ],
    resolve: {
      alias: {
        rxjs: rxjsEsm,
        // workbench 以源码方式消费，其内部统一使用 `@/` 别名指向本包 src 根；
        // 各 app 自身源码不用 `@/`，故直接映射到 workbench 根。
        "@": workbenchSrc,
      },
    },

    // 显式钉住渲染端的语法底线 —— 不要删，也不要以为它只是个默认值。
    //
    // vite 6 的默认 build.target 是 "modules"（= es2020 / chrome87 / firefox78 / safari14），
    // vite 8 换成了 "baseline-widely-available"（= chrome111 / edge111 / firefox114 /
    // safari16.4 / ios16.4）。不写死的话，**一次工具链升级就会把 UI 的语法底线从
    // Safari 14（macOS 11）抬到 Safari 16.4（macOS 13.3）**，而且不会有任何测试报红。
    // docs/packaging.md 把 bundle.macOS.minimumSystemVersion 钉在 10.13 是刻意的
    // （防将来打包器默认值悄悄移动支持底线），渲染端当然更不该由依赖的默认值顺手收窄。
    // 下面写的就是升级前那一档，行为等价。
    //
    // 注意 build.target 只做**语法**转译、不带 polyfill：它保证「不比以前更严」，
    // 不等于能在老 WebKit 上真的跑起来（例如 mermaid 一直依赖的 structuredClone 要
    // Safari 15.4+，这条与 target 无关）。
    build: {
      target: ["es2020", "chrome87", "firefox78", "safari14"],
      outDir,
    },

    // prevent Vite from obscuring rust errors
    clearScreen: false,
    // tauri 时代要求固定端口，fail if that port is not available
    server: {
      port: devPort,
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
        // /api/* → 本地 headless 服务端（apps/server，默认 127.0.0.1:8787）。
        //
        // 仅 Web 预览（浏览器 dev）需要这一段：桌面端走 sidecar 同源托管，不发 HTTP；
        // 生产部署时前端由服务端同源托管，也不经过 Vite。
        //
        // changeOrigin 必须保持 false：服务端假定同源（不设 CORS），登录 cookie 的 Path=/
        // 由浏览器按前端 origin 存取 —— 改写 Host 会让服务端把它当成跨站请求。
        // ws:true 是 /api/events 那条 WebSocket 必需的，否则升级请求不会被转发。
        "/api": {
          target: process.env.GREYWORK_SERVER_URL ?? "http://127.0.0.1:8787",
          changeOrigin: false,
          ws: true,
        },
        // /market-api/skills/* → https://www.skills.sh/*；/market-api/mcp/* → https://registry.modelcontextprotocol.io/*
        // 仅 Web 预览使用；桌面端仍走 Rust 宿主代理。
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
        // tell Vite to ignore watching `src-tauri`（Tauri 壳已移除，保留为空守护）
        ignored: ["**/src-tauri/**"],
      },
    },
  });
}
