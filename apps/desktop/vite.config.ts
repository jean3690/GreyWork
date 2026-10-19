import { defineFrontConfig } from "@greywork/vite-config";

// 桌面端的构建配置全部收在共享工厂里（rxjs 入口、pdf.js 资源、语法底线、dev 代理……），
// 这里只声明「本端是谁」。别把配置往这里抄 —— 抄一份就是一处将来的漂移。
//
// 桌面端的 SPA 由 sidecar 在**根路径**托管，所以 base 保持 `/` 且自己产出共享资源；
// Web 端是另一个部署（同样发布在根路径），两端各出各的 dist，互不覆盖。
// 若将来把两端合并进同一个部署，桌面端才需要改成 `base: "/desktop/"` +
// `emitsSharedAssets: false`（届时根路径的 /pdfjs/ 与 /vscode-icons/ 归 Web 端）。
export default defineFrontConfig();
