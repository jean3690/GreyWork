/**
 * 云端 Office 预览的决策（纯逻辑，便于单测）。
 *
 * **默认关闭是硬要求**：没配服务商、或配了但没启用/没填配方时，一律返回 null —— 预览
 * 完全走本地 viewer，行为与加这个功能之前逐字节一致。开启后失败的路径也必须回落本地，
 * 「本来能看的文件变得打不开了」是比「看不到云端效果」严重得多的回归。
 *
 * 决策只看三件事（顺序即短路顺序）：文件来源是不是磁盘、kind 本地渲不渲染得了、
 * 有没有一个「已启用且填了配方」的服务商。
 */

import { enabledOfficeProvider, type OfficeProviderConfig } from "@greywork/shell";
import type { ViewerKind } from "./viewer";
import type { PreviewTab } from "../stores/preview";

/**
 * 云端 Office 能接管的 kind。
 *
 * 不只包含本地渲染不了的（`legacy-office` = .doc/.ppt）：xlsx/docx/pptx 的本地渲染各有
 * 取舍（Univer 保真度、自研 OOXML 解析的覆盖面），云端是更保真的选项，用户既然配了
 * 就应当用它。`xls` 在列：宿主用 calamine 按内容嗅探，多数老表格能读，但拿不准的
 * 那种正是云端最擅长的。
 */
export const CLOUD_OFFICE_KINDS: ReadonlySet<ViewerKind> = new Set<ViewerKind>(["docx", "pptx", "xlsx", "xls", "legacy-office"]);

/**
 * 交给宿主读取的路径；null = 这个 tab 不该走云端。
 *
 * **路径而不是字节过 IPC**：文件动辄数 MB，而宿主侧本来就有 `WorkspaceFsAccess` 做授权根
 * 校验 —— 让宿主按路径自己读，授权面与体积都收在一处，与既有 `fs_*` 命令同一套。
 *
 * `vfs` 产物只在其被落盘（`diskPath` 就位）后才走云端：纯内存产物没有宿主可读的路径，
 * 传相对路径过去只会撞授权拒绝，不如老实在本地渲染。
 */
export function cloudOfficePath(tab: PreviewTab): string | null {
  if (tab.source === "disk") return tab.path;
  if (tab.source === "vfs" && tab.diskPath) return tab.diskPath;
  return null;
}

/**
 * 该 tab 应当使用的云端 Office 服务商；null = 走本地 viewer。
 *
 * 决策与取路径拆成两个函数但共用同一套判断，`CloudOfficeViewer` 用 [`cloudOfficePath`]
 * 取路径 —— 避免「决策说能用、viewer 却拿不到路径」这种两处判断漂移出来的裂缝。
 */
export function cloudOfficeProviderFor(
  tab: PreviewTab,
  providers: readonly OfficeProviderConfig[],
  selectedId?: string | null,
): OfficeProviderConfig | null {
  if (cloudOfficePath(tab) === null) return null;
  if (!CLOUD_OFFICE_KINDS.has(tab.kind)) return null;
  // 「可用」= 已启用 **且** 填了配方：只有开关没有配方跑不出结果，放它进来会让预览
  // 白白失败一次再回落（用户看到一次错误提示），不如一开始就走本地。
  return enabledOfficeProvider(providers, selectedId);
}

/** 是否使用云端 Office 预览。 */
export function shouldUseCloudOffice(tab: PreviewTab, providers: readonly OfficeProviderConfig[], selectedId?: string | null): boolean {
  return cloudOfficeProviderFor(tab, providers, selectedId) !== null;
}

/**
 * 把 origin 归一化成与宿主上报一致的形态（小写、无尾斜杠）。
 *
 * 宿主侧用 `csp::normalize_frame_origin` 归一化后才回给渲染端，但用户填在设置里的
 * `frameOrigin` 是原样存的（可能带尾斜杠或大写）。两边不归一化就比对不上，
 * 症状是「明明配了却判成不可内嵌」—— 最难查的一类配置问题。
 */
export function canonicalOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value.trim().replace(/\/+$/, "").toLowerCase();
  }
}

/** 宿主可内嵌白名单（归一化后的集合，便于多次比对）。 */
export function embeddableOriginSet(origins: readonly string[]): Set<string> {
  return new Set(origins.map(canonicalOrigin));
}

/**
 * 该文档地址的 origin 是否在宿主白名单内。
 *
 * 不在白名单里就意味着 iframe 会被宿主 CSP 拦掉、**白屏且控制台之外看不到任何报错**，
 * 所以渲染端宁可提前回落本地 viewer 并把原因说出来（见 CloudOfficeViewer）。
 * 地址解析不出 origin、或白名单为空，都算不可内嵌 —— 后者是宿主的真实语义
 * （没有 `frame-src` 就回落到 `default-src 'self'`，跨源一律不放行）。
 */
export function isOriginEmbeddable(url: string, origins: readonly string[]): boolean {
  return embeddableOriginSet(origins).has(canonicalOrigin(url));
}

/**
 * 上传前的预检：配方声明的 `frameOrigin` 已知且不在白名单内时返回它（归一化后）。
 *
 * 只为省一次「白传上去又不能用」的上传。`frameOrigin` 是可选配置，未声明时返回 null ——
 * **不能**拿它替代上传后的权威校验：厂商返回的地址域名未必等于声明值。
 */
export function unembeddableFrameOrigin(provider: Pick<OfficeProviderConfig, "frameOrigin">, origins: readonly string[]): string | null {
  const declared = provider.frameOrigin?.trim();
  if (!declared) return null;
  const canonical = canonicalOrigin(declared);
  return embeddableOriginSet(origins).has(canonical) ? null : canonical;
}
