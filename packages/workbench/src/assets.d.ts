/**
 * `?url` 资源导入声明（pdf.js worker、品牌标识等）。
 *
 * `vite/client` 里有通用的 `declare module "*?url"`，但 workbench 没有直接依赖 vite
 * （只有 vitest 间接带着它），pnpm 的严格隔离下 `vite/client` 不一定解析得到。
 * 这里给用到的具体 specifier 各补一条精确声明：精确匹配优先于通配，
 * 与 `vite/client` 共存也不会冲突。
 */
declare module "pdfjs-dist/build/pdf.worker.min.mjs?url" {
  const src: string;
  export default src;
}

declare module "*.svg?url" {
  const src: string;
  export default src;
}
