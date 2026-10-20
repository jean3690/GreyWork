import { defineFrontConfig } from "@greywork/vite-config";

// Web 端是部署里**根路径**那一端：`/` 由它回答，共享静态资源（`/pdfjs/*`、`/vscode-icons/`）
// 也归它产出（`emitsSharedAssets`）。桌面端将来在 `/desktop/` 下，它代码里那两条硬编码的
// 绝对路径请求会打到根来 —— 由这里回答。所以这两个值不是随手定的，改之前先读
// packages/vite-config 里 emitsSharedAssets 与 lib/file-icons.ts 的说明。
//
// 其余配置全在共享工厂里（rxjs 入口、pdf.js 资源、语法底线、dev 代理、共享 publicDir……）。
// 别往这里抄 —— 抄一份就是一处将来的漂移。
//
// dev 端口与桌面端（1420）错开：两个前端要能同时 `pnpm dev`，各自身份由各自的入口声明。
export default defineFrontConfig({ base: "/", emitsSharedAssets: true, devPort: 1421 });
