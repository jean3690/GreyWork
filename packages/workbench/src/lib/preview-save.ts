/**
 * 预览编辑的共用「脏标记 + 保存」通道（xlsx / docx / pptx 三个可编辑 viewer 复用）。
 *
 * **为什么放在模块级注册表而不是塞进 PreviewTab**：内容不进 pinia（见 stores/preview.ts
 * 顶部注释），编辑态是 viewer 的运行时状态，随实例创建/销毁，塞进序列化的 tab 里毫无意义。
 * viewer 挂载时 `registerPreviewSaver`、卸载时 `unregisterPreviewSaver`，外壳（PreviewSider）
 * 只按 tab.id 读脏标记、触发保存 —— 外壳不需要知道任何格式细节。
 *
 * 成员增删的响应式靠模块内 `version` 计数兜（见下），内层 `dirty` 由 viewer 持有的 ref 负责。
 */
import { ref, type Ref } from "vue";
import { useVfsStore } from "../stores/vfs";
import { writeBinaryFile, writeTextFile } from "../state/workspaceFiles";
import type { PreviewTab } from "../stores/preview";

export interface PreviewSaver {
  /** 是否有未保存改动；viewer 持有的响应式引用。 */
  dirty: Ref<boolean>;
  /**
   * 序列化当前编辑结果、写回来源、清脏标。失败时抛出，由调用方提示 ——
   * 保存路径把「写盘失败」吞掉会让用户以为存住了，恰恰是最不能省的一处。
   */
  save: () => Promise<void>;
}

/**
 * tab.id → saver。用普通 Map 而非 `reactive(Map)`：reactive 会在类型层把值里的 `Ref`
 * 解包成裸值（`dirty.value` 就取不到），运行时又不真的解包 Map 值 —— 类型与运行时对不上。
 * 成员增删的响应式改由 `version` 计数兜：读取处先碰一下 `version` 建立依赖。
 */
const savers = new Map<string, PreviewSaver>();
const version = ref(0);

export function registerPreviewSaver(id: string, saver: PreviewSaver): void {
  savers.set(id, saver);
  version.value += 1;
}

export function unregisterPreviewSaver(id: string): void {
  if (savers.delete(id)) version.value += 1;
}

export function previewSaver(id: string): PreviewSaver | undefined {
  return savers.get(id);
}

/** 该 tab 是否有已注册且脏的编辑器（响应式：既依赖成员增删，也依赖内层 `dirty`）。 */
export function isPreviewDirty(id: string): boolean {
  void version.value;
  return savers.get(id)?.dirty.value ?? false;
}

/**
 * 把编辑后的字节写回来源。
 * - `disk`：走宿主 `fs_write_binary`（路径授权在宿主侧兜）。
 * - `vfs`：写内存虚拟文件系统。
 * - `web`：网页正文没有可写回的原始文件，禁止保存。
 *
 * **刻意不 `reload()`**：reload 自增 revision 会让 viewer 重读并整实例重建（Univer 实例、
 * contenteditable 光标、滚动位置全丢），而保存后内存里的编辑结果本就是最新真源，无需重读。
 */
export async function writePreviewBytes(tab: PreviewTab, bytes: Uint8Array): Promise<void> {
  if (tab.source === "disk") {
    await writeBinaryFile(tab.path, bytes);
    return;
  }
  if (tab.source === "vfs") {
    await useVfsStore().writeBinary(tab.path, bytes);
    return;
  }
  throw new Error("网页预览没有可写回的文件");
}

/**
 * 文本通道的写回（可编辑 TextViewer 用）。与 `writePreviewBytes` 同构，只是走文本命令。
 *
 * **编码 / 换行保真不在这里**：BOM 与 CRLF 由 TextViewer 按宿主探测结果还原后再调本函数，
 * 因为那两份信息只有它持有时才知道（见 features/preview/TextViewer.vue）。
 */
export async function writePreviewText(tab: PreviewTab, text: string): Promise<void> {
  if (tab.source === "disk") {
    await writeTextFile(tab.path, text);
    return;
  }
  if (tab.source === "vfs") {
    await useVfsStore().write(tab.path, text);
    return;
  }
  throw new Error("网页预览没有可写回的文件");
}
