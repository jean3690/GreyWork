/**
 * mammoth 浏览器端最小类型声明（官方无 types，@types/mammoth 拉取受限时本地兜底）。
 * 仅声明产物查看器用到的 convertToHtml；运行时经 Vite browser 字段映射到 browser bundle。
 */
declare module "mammoth" {
  export interface MammothInput {
    arrayBuffer: ArrayBuffer;
  }
  export interface MammothResult {
    /** 转换后的 HTML 字符串。 */
    value: string;
    messages: unknown[];
  }
  export function convertToHtml(input: MammothInput): Promise<MammothResult>;
}
