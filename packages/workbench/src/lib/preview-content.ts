import { isTauriRuntime } from "@greywork/core";
import { ref, watch, type Ref } from "vue";
import { readBinaryFile, readTextFile } from "../state/workspaceFiles";
import { isBinaryKind } from "./viewer";
import { useVfsStore } from "../stores/vfs";
import type { PreviewTab } from "../stores/preview";

/**
 * 预览内容读取：所有 viewer 共用的一条加载路径。
 *
 * 由 `isBinaryKind` 决定走 readFile 还是 readBinary —— 这个判断只能有一处，
 * 否则某个 viewer 迟早会把 xlsx 当文本读，症状是「文件已损坏」而不是编译错误。
 *
 * `tab.revision` 进 watch 源：产物就地更新时路径不变，只有 revision 会动。
 * 竞态由 token 守卫：切 tab 很快时旧的 await 不能把内容写到新 tab 上。
 */
export interface PreviewContent<T> {
  data: Ref<T | null>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
}

/**
 * 通用预览加载器。`sources` 是路径与 revision 之外的额外触发源（如分析面板选中的工作表名）——
 * 传 getter 而不是值，才能沿用 watch 的按值比较。
 */
export function usePreviewLoader<T>(
  tab: Ref<PreviewTab>,
  load: (path: string) => Promise<T>,
  sources: ReadonlyArray<() => unknown> = [],
): PreviewContent<T> {
  const data = ref<T | null>(null) as Ref<T | null>;
  const loading = ref(false);
  const error = ref<string | null>(null);
  let token = 0;

  // 源用**逐个 getter**而不是 `() => [path, revision]`：后者每次求值都是一个新数组，
  // Object.is 永不相等，于是「tab 对象被换掉」也会触发重载 —— 而 store 里改 diskPath / dirty
  // 就是换对象。重载会把 viewer 连同 Univer 实例、滚动位置和正在编辑的内容一起重建。
  // 拆成两个 getter 后只按 path / revision 的**值**比较，换对象不再误伤。
  watch(
    [() => tab.value.path, () => tab.value.revision, ...sources],
    async () => {
      // 路径在回调里现读而不是从 watch 参数解构：混合类型的 getter 数组会让解构出的
      // 元素退化成 unknown，而这里本来要的就是「当前路径」。
      const path = tab.value.path;
      const current = ++token;
      loading.value = true;
      error.value = null;
      try {
        const result = await load(path);
        if (current !== token) return; // 已被更晚的加载取代，丢弃结果
        data.value = result;
      } catch (cause: unknown) {
        if (current !== token) return;
        data.value = null;
        error.value = cause instanceof Error ? cause.message : String(cause);
      } finally {
        if (current === token) loading.value = false;
      }
    },
    { immediate: true },
  );

  return { data, loading, error };
}

/**
 * 磁盘通道守卫：浏览器态没有 Rust 命令可调，直接抛一句人话，
 * 而不是让 `invoke` 抛一个「command not found」这种对用户毫无意义的错。
 */
function assertDiskAvailable(): void {
  if (!isTauriRuntime()) throw new Error("浏览器态没有磁盘通道，无法预览工作区文件");
}

/**
 * 文本通道：按来源取文本（disk → 宿主命令，其余 → VFS）。
 *
 * 抽成独立函数而不是只留在 `usePreviewText` 里：分析面板要按 kind 在文本/二进制/宿主命令
 * 三条通道间分派，但只能挂**一个** watch —— 三个 `use*` 组合式函数没法条件调用。
 */
export async function readPreviewText(tab: PreviewTab, path: string): Promise<string> {
  if (tab.source === "disk") {
    assertDiskAvailable();
    return readTextFile(path);
  }
  return useVfsStore().readFile(path);
}

/** 二进制通道。与 `readPreviewText` 分成两个函数，理由见 `workspaceFiles.readBinaryFile`。 */
export async function readPreviewBinary(tab: PreviewTab, path: string): Promise<Uint8Array> {
  if (!isBinaryKind(tab.kind)) throw new Error(`${tab.kind} 不是二进制类型`);
  if (tab.source === "disk") {
    assertDiskAvailable();
    return readBinaryFile(path);
  }
  return useVfsStore().readBinary(path);
}

/** 文本内容（md / html / csv / code / raw）。 */
export function usePreviewText(tab: Ref<PreviewTab>): PreviewContent<string> {
  return usePreviewLoader(tab, (path) => readPreviewText(tab.value, path));
}

/** 二进制内容（xlsx / docx / pptx / pdf / image）。 */
export function usePreviewBinary(tab: Ref<PreviewTab>): PreviewContent<Uint8Array> {
  return usePreviewLoader(tab, (path) => readPreviewBinary(tab.value, path));
}
