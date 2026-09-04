import { onScopeDispose, ref, type Ref } from "vue";

/**
 * 竖向分隔条拖拽（右栏调宽共用）。
 *
 * 设计取舍：
 * - **Pointer Events + setPointerCapture**：一套代码同时覆盖鼠标/触控/笔，且指针移出把手
 *   甚至移出窗口后仍持续收到事件；mousemove 方案在快速拖动越出窗口时会丢掉 mouseup，
 *   表现为「松手了还在跟手」。同时兜 pointercancel / lostpointercapture / window blur，
 *   任一路径都能收尾。
 * - **rAF 节流**：pointermove 每帧可来数次，直接 setState 会让 Univer / CodeMirror
 *   在一帧内重排多次。只保留最后一次坐标，下一帧提交。
 * - **拖拽中不写盘**：过程值没有意义，只有松手那一下值得持久化（commit=true）。
 */
export interface ResizableSplitOptions {
  /** 读当前宽度（px）。拖拽起点取它，而不是缓存值 —— 期间外部改宽度也不会跳。 */
  width: () => number;
  /** 宽度提交口；`commit` 为 true 表示这是最终值（调用方据此决定是否落盘）。 */
  onWidth: (px: number, commit: boolean) => void;
  /** 把手在面板**左**边缘时置 true：向左拖 = 变宽。 */
  reverse?: boolean;
}

export interface ResizableSplit {
  dragging: Ref<boolean>;
  onPointerDown: (event: PointerEvent) => void;
}

export function useResizableSplit(options: ResizableSplitOptions): ResizableSplit {
  const dragging = ref(false);
  let teardown: (() => void) | null = null;

  function stop(): void {
    teardown?.();
    teardown = null;
  }

  function onPointerDown(event: PointerEvent): void {
    // 非触控时只接受主键：中键/右键拖分隔条不是任何人的预期。
    if (event.pointerType !== "touch" && event.button !== 0) return;
    event.preventDefault();
    stop();

    const handle = event.currentTarget as HTMLElement | null;
    const startX = event.clientX;
    const startWidth = options.width();
    const pointerId = event.pointerId;
    const sign = options.reverse ? -1 : 1;

    let frame: number | null = null;
    let pending: number | null = null;
    let latest = startWidth;

    const nextWidth = (clientX: number): number => startWidth + sign * (clientX - startX);

    const flush = (): void => {
      if (pending === null) return;
      latest = pending;
      pending = null;
      options.onWidth(latest, false);
    };

    const onMove = (moveEvent: PointerEvent): void => {
      // buttons 归零说明按键已在别处松开（例如在 devtools 上），此时收尾而不是继续跟手。
      if (moveEvent.buttons === 0) {
        finish(moveEvent.clientX);
        return;
      }
      pending = nextWidth(moveEvent.clientX);
      if (frame === null) {
        frame = requestAnimationFrame(() => {
          frame = null;
          flush();
        });
      }
    };

    const finish = (clientX?: number): void => {
      if (!dragging.value) return;
      dragging.value = false;
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      flush();
      options.onWidth(clientX === undefined ? latest : nextWidth(clientX), true);
      stop();
    };

    const onUp = (upEvent: PointerEvent): void => finish(upEvent.clientX);
    const onCancel = (): void => finish();
    const onBlur = (): void => finish();

    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    if (handle?.setPointerCapture) {
      try {
        handle.setPointerCapture(pointerId);
      } catch {
        // 捕获失败不致命：window 上的监听仍能收到事件，继续走兜底路径。
      }
      handle.addEventListener("lostpointercapture", onCancel);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onBlur);

    dragging.value = true;
    teardown = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onBlur);
      handle?.removeEventListener("lostpointercapture", onCancel);
      if (handle?.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      dragging.value = false;
    };
  }

  // 拖拽途中组件被卸载（切路由 / 面板关闭）时，body 样式和 window 监听必须还原，
  // 否则整个应用会卡在 col-resize 光标 + 无法选中文字的状态。
  onScopeDispose(stop);

  return { dragging, onPointerDown };
}
