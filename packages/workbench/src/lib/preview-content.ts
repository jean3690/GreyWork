import { hasHostCommands, mediaStreamUrl } from "@greywork/host-ipc";
import { ref, watch, type Ref } from "vue";
import { readBinaryFile, readMediaFile, readTextFile } from "../state/workspaceFiles";
import { isBinaryKind, isMediaKind, mediaLimitOfKind } from "./viewer";
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
  if (!hasHostCommands()) throw new Error("浏览器态没有磁盘通道，无法预览工作区文件");
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
  // 媒体必须走 `resolvePreviewMedia`：它的字节可能是几百 MB，而且桌面端**根本不读字节**。
  // 走错这条的代价不对称 —— 视频会被 20MB 硬顶静默挡下，看起来像文件坏了。
  if (isMediaKind(tab.kind)) throw new Error(`${tab.kind} 必须走媒体通道（resolvePreviewMedia）`);
  if (tab.source === "disk") {
    assertDiskAvailable();
    return readBinaryFile(path);
  }
  return useVfsStore().readBinary(path);
}

/**
 * 媒体来源：要么是一个支持 HTTP Range 的流式地址（桌面壳的 `gwmedia://` 协议），
 * 要么是整份读进来的原始字节（服务端 / 浏览器预览 / VFS）。
 *
 * 分成两态而不是统一成字节：视频的字节可能是几百 MB，而流式那条路**根本不读字节**。
 * 统一成字节就等于把这个区别抹掉 —— 那正是「一直转圈、不出画面」的病根。
 */
export type PreviewMediaSource = { kind: "stream"; url: string } | { kind: "bytes"; bytes: Uint8Array };

/**
 * 媒体来源偏好。
 *
 * - `stream`（默认）：桌面壳优先给支持 Range 的地址 —— 视频边播边拉，不读字节。
 * - `bytes`：调用方**必须**拿到整份字节（3D 模型要交给 GLTFLoader 解析）。
 *   仍然走 `fs_read_media` 的放宽上限，只是不要流式地址。
 */
export type PreviewMediaPreference = "stream" | "bytes";

/**
 * 媒体通道。优先流式：桌面壳注册了 `gwmedia://`，媒体元素按 Range 自己拉片段，
 * 不读字节、不受 128MB 硬顶约束、拖动进度条可用。
 *
 * 没有自定义协议的宿主（服务端 / 浏览器预览）回落到整份读入 + blob URL —— 这条路对
 * 视频很慢（IPC 全量传输 + 主线程同步拷贝），是已知待办：服务端还缺一条 Range 路由。
 */
export async function resolvePreviewMedia(
  tab: PreviewTab,
  path: string,
  prefer: PreviewMediaPreference = "stream",
): Promise<PreviewMediaSource> {
  if (!isMediaKind(tab.kind)) throw new Error(`${tab.kind} 不是媒体类型`);
  if (tab.source === "disk") {
    assertDiskAvailable();
    if (prefer === "stream") {
      const stream = mediaStreamUrl(path);
      if (stream) return { kind: "stream", url: stream };
    }
    return { kind: "bytes", bytes: await readMediaFile(path, mediaLimitOfKind(tab.kind)) };
  }
  return { kind: "bytes", bytes: await useVfsStore().readBinary(path) };
}

/** 文本内容（md / html / csv / code / raw）。 */
export function usePreviewText(tab: Ref<PreviewTab>): PreviewContent<string> {
  return usePreviewLoader(tab, (path) => readPreviewText(tab.value, path));
}

/** 二进制内容（xlsx / docx / pptx / pdf / image）。 */
export function usePreviewBinary(tab: Ref<PreviewTab>): PreviewContent<Uint8Array> {
  return usePreviewLoader(tab, (path) => readPreviewBinary(tab.value, path));
}

/** 媒体内容（video / 3d）：流式地址或字节，由宿主能力与调用方偏好决定。 */
export function usePreviewMedia(tab: Ref<PreviewTab>, prefer: PreviewMediaPreference = "stream"): PreviewContent<PreviewMediaSource> {
  return usePreviewLoader(tab, (path) => resolvePreviewMedia(tab.value, path, prefer));
}
