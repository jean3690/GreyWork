/**
 * 输入卡附件状态机：采集（选择 / 拖放 / 粘贴）、去重、限额、切换会话清空。
 *
 * 会话页与引导页共用同一份实现 —— 两边的差异在 send 语义（停止/计划/编排/建会话），
 * 而附件部分完全同构，抽成 composable 比抽整个 ChatComposer 改动面小得多。
 *
 * 拖放仲裁：桌面宿主（tauri.conf 开了 dragDropEnabled）的 OS 拖放由 App.vue 的全局
 * 监听统一接收并默认开预览面板，输入卡靠 `data-attachment-dropzone` 标记 + 命中判定
 * 把落在自己身上的拖放接管过来，避免「既贴了附件又开了预览」。
 */
import { computed, onMounted, onUnmounted, ref, watch, type ComputedRef, type Ref } from "vue";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "@greywork/core";
import {
  attachmentObjectUrl,
  attachmentsFromClipboard,
  attachmentsFromFiles,
  attachmentsFromPaths,
  pickAttachments,
  releaseAttachmentObjectUrls,
} from "../state/attachment-library";
import { ATTACHMENT_LIMITS } from "./attachments";
import { i18n } from "../i18n";
import { notify } from "../stores/notice";
import type { Attachment } from "../types";

const t = i18n.global.t;

/** 输入卡根元素的标记属性：拖放命中判定两边都认它。 */
export const DROPZONE_ATTR = "data-attachment-dropzone";

let scalePromise: Promise<number> | null = null;

/** 窗口缩放因子（物理像素 → 逻辑像素）；失败回落到 devicePixelRatio。 */
function windowScale(): Promise<number> {
  scalePromise ??= getCurrentWindow()
    .scaleFactor()
    .catch(() => window.devicePixelRatio || 1);
  return scalePromise;
}

/** 逻辑坐标是否落在附件拖放区（输入卡）上。 */
export function isPointInDropzone(x: number, y: number): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(document.elementFromPoint(x, y)?.closest(`[${DROPZONE_ATTR}]`));
}

/** 宿主给的物理坐标是否落在附件拖放区上（App.vue 与输入卡共用一份判定）。 */
export async function isPhysicalPointInDropzone(position: { x: number; y: number }): Promise<boolean> {
  const scale = await windowScale();
  return isPointInDropzone(position.x / scale, position.y / scale);
}

export interface AttachmentsController {
  items: Ref<Attachment[]>;
  /** 拖拽悬停在输入卡上（高亮提示）。 */
  dragging: Ref<boolean>;
  full: ComputedRef<boolean>;
  /** 输入卡根元素（模板 ref 绑到绑定 `DROPZONE_ATTR` 的那个元素上）。 */
  attachEl: Ref<HTMLElement | null>;
  pick(): Promise<void>;
  addPaths(paths: readonly string[]): Promise<void>;
  addFiles(files: readonly File[]): Promise<void>;
  onPaste(event: ClipboardEvent): void;
  onDragOver(event: DragEvent): void;
  onDragLeave(): void;
  onDrop(event: DragEvent): void;
  remove(id: string): void;
  clear(): void;
  /** 取出并清空（发送时用：先取走再落库，用户随即可以继续添加）。 */
  take(): Attachment[];
}

export interface AttachmentsOptions {
  /**
   * 当前后端是否接受图片（ACP agent 未声明图片能力时为 false）。
   * 为 false 时图片在采集阶段就被挡下并提示 —— 比发出后被宿主过滤更早让用户知道。
   * 缺省视为允许（本地 LLM 无协议级能力声明，交给供应商报错）。
   */
  imagesAllowed?: () => boolean;
}

/**
 * 图片附件缩略图：id → URL（null = 读取失败）。
 *
 * 输入卡与已发送消息共用同一份缓存（attachmentObjectUrl 内的模块级 LRU），
 * 同一条消息重渲染不会重复读盘。文本附件与失败项不进表，由调用方渲染占位。
 */
export function useAttachmentThumbs(items: () => readonly Attachment[]): Ref<Record<string, string | null>> {
  const thumbs = ref<Record<string, string | null>>({});
  const pending = new Set<string>();

  async function load(item: Attachment): Promise<void> {
    if (item.kind !== "image" || item.id in thumbs.value || pending.has(item.id)) return;
    pending.add(item.id);
    const url = await attachmentObjectUrl(item);
    pending.delete(item.id);
    thumbs.value = { ...thumbs.value, [item.id]: url };
  }

  watch(
    items,
    (list) => {
      for (const item of list) void load(item);
    },
    { immediate: true, deep: true },
  );

  return thumbs;
}

export function useAttachments(sessionId: () => string, options: AttachmentsOptions = {}): AttachmentsController {
  const items = ref<Attachment[]>([]);
  const dragging = ref(false);
  const attachEl = ref<HTMLElement | null>(null);
  const full = computed(() => items.value.length >= ATTACHMENT_LIMITS.maxCount);

  /** agent 不收图片：丢掉本次采集到的图片并提示；文本附件不受影响。 */
  function filterImages(added: Attachment[]): Attachment[] {
    if (options.imagesAllowed?.() !== false) return added;
    if (!added.some((item) => item.kind === "image")) return added;
    notify({ kind: "warning", key: "attachment-image-unsupported", title: t("chat.attachImagesUnsupported") });
    return added.filter((item) => item.kind !== "image");
  }

  function append(added: readonly Attachment[]): void {
    const kept = filterImages([...added]);
    if (kept.length) items.value = [...items.value, ...kept];
  }

  async function pick(): Promise<void> {
    if (full.value) return;
    append(await pickAttachments(items.value));
  }

  async function addPaths(paths: readonly string[]): Promise<void> {
    if (!paths.length) return;
    append(await attachmentsFromPaths(paths, items.value));
  }

  async function addFiles(files: readonly File[]): Promise<void> {
    if (!files.length) return;
    append(await attachmentsFromFiles(files, items.value));
  }

  /**
   * 粘贴。浏览器/H5 分支能从 clipboardData 同步拿到文件，直接 preventDefault；
   * 桌面端 WebKitGTK 的 clipboardData 里没有图片，只能异步问宿主 clipboard 插件 ——
   * 此时**不能** preventDefault（没有图片时用户贴的是文本，必须让它照常落入输入框），
   * 代价是剪贴板同时含图片与文本时会两样都进来。
   */
  function onPaste(event: ClipboardEvent): void {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length) {
      event.preventDefault();
      void addFiles(files);
      return;
    }
    if (!isTauriRuntime()) return;
    void (async () => {
      const added = await attachmentsFromClipboard(items.value);
      if (added.length) append(added);
    })();
  }

  function onDragOver(event: DragEvent): void {
    if (event.dataTransfer?.types.includes("Files")) dragging.value = true;
  }

  function onDragLeave(): void {
    dragging.value = false;
  }

  function onDrop(event: DragEvent): void {
    dragging.value = false;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) {
      event.preventDefault();
      void addFiles(files);
    }
  }

  function remove(id: string): void {
    items.value = items.value.filter((item) => item.id !== id);
  }

  function clear(): void {
    items.value = [];
    dragging.value = false;
  }

  function take(): Attachment[] {
    const taken = items.value;
    items.value = [];
    return taken;
  }

  // 切换会话：草稿只属于当前输入框，跟着会话走会串号。
  watch(sessionId, clear);

  // 桌面态：OS 拖放由宿主截获，HTML5 drop 收不到，必须自己听 webview 事件。
  let unlisten: (() => void) | undefined;
  onMounted(() => {
    if (!isTauriRuntime()) return;
    void (async () => {
      try {
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "leave") {
            dragging.value = false;
            return;
          }
          void (async () => {
            const inside = await isPhysicalPointInDropzone(payload.position);
            if (payload.type === "drop") {
              dragging.value = false;
              if (inside) await addPaths(payload.paths);
              return;
            }
            dragging.value = inside;
          })();
        });
      } catch {
        // 浏览器 dev / 无 Tauri 通道：走 HTML5 拖放，静默降级。
      }
    })();
  });

  onUnmounted(() => {
    unlisten?.();
    releaseAttachmentObjectUrls();
  });

  return {
    items,
    dragging,
    full,
    attachEl,
    pick,
    addPaths,
    addFiles,
    onPaste,
    onDragOver,
    onDragLeave,
    onDrop,
    remove,
    clear,
    take,
  };
}
