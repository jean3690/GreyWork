/**
 * Mermaid 渲染门面：懒加载（首个图块出现才下载 chunk）+ 每次渲染前按外观设图级配置。
 *
 * 安全模型（与 MarkdownText 同一取向，勿放宽）：
 * - 内容来自模型输出，绝不直接进 DOM。进入 DOM 的唯一产物是 mermaid.render() 的 SVG；
 * - securityLevel 固定 "strict"：标签里的 HTML 经 DOMPurify 清洗，click/script 类指令被剥除；
 * - suppressErrorRendering: true：语法/布局失败一律抛异常由调用方降级为原文代码块，
 *   不落入 mermaid 自绘的错误图（其文本同样来自模型输出，不许进 DOM）。
 *   （suppressErrorRendering 在 mermaid 的 secure 名单内，图内 %%{init}%% 无法改写。）
 *
 * 主题：按宿主外观选 mermaid 内置主题（dark/default），每次渲染前 initialize 生效。
 * 并发与重入：单块内自增 id 保证 SVG 引用唯一；失败的调用整体抛错，不留半渲染态。
 *
 * **升 12 的两个坑（已处理，别回退）**：
 * - 12.0.0 的 `btoa(JSON.stringify(points))` 曾把携带中文标签的对象丢给 Latin1 的
 *   btoa，整图抛 InvalidCharacterError。12.2.0 已把 points 收敛成纯数字，中文节点与
 *   边标签在真浏览器里渲染正常（同一张图 11 与 12 的输出逐像素对比过）。
 * - 12 把默认换成 ELK 布局 + neo 观感，同一张图高度会明显变（实测 908px → 1019px）。
 *   这里显式钉回 `layout: "dagre"` + `look: "classic"`，让升级不改变既有版式。
 */
import type MermaidDefault from "mermaid";
import type { MermaidConfig } from "mermaid";

/** mermaid 包仅 default 导出（dist/mermaid.d.ts 只挂 default 对象）。 */
type MermaidApi = typeof MermaidDefault;

/** 图字体跟随应用 UI 字族（含 CJK 兜底）；var() 在文档内正常解析。 */
const UI_FONT = 'var(--font-ui), "Archivo Variable", "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif';

let mermaidPromise: Promise<MermaidApi> | null = null;
let renderSeq = 0;

/** 进程内只保留一份 mermaid 实例（动态 import 一次，后续复用）。 */
function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import("mermaid").then((module) => module.default);
  return mermaidPromise;
}

/** 渲染一段 mermaid 源码，成功返回 svg 字符串；任何失败抛错（由调用方降级展示原文）。 */
export async function renderMermaid(source: string, dark: boolean): Promise<{ svg: string }> {
  const mermaid = await loadMermaid();
  const config: MermaidConfig = {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: dark ? "dark" : "default",
    // 12 起默认 ELK + neo，钉回 11 的 dagre + classic 以保住既有版式（见文件头）。
    layout: "dagre",
    look: "classic",
    fontSize: 14,
    themeVariables: { fontFamily: UI_FONT },
  };
  mermaid.initialize(config);
  const { svg } = await mermaid.render(`md-mermaid-${++renderSeq}`, source);
  return { svg };
}
