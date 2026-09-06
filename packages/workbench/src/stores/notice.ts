import { createIdFactory } from "@greywork/core";
import { defineStore } from "pinia";
import { ref } from "vue";

const nextNoticeId = createIdFactory("nt");

export type NoticeKind = "error" | "warning" | "success" | "info";

export interface NoticeAction {
  label: string;
  run: () => void;
}

export interface Notice {
  id: string;
  kind: NoticeKind;
  title: string;
  /** 可选细节（原始报错、路径等）；UI 以次要字号折在标题下。 */
  detail?: string;
  action?: NoticeAction;
  createdAt: number;
  /** 去重键（见 push）。 */
  key?: string;
}

export interface NoticeInput {
  kind?: NoticeKind;
  title: string;
  detail?: string;
  action?: NoticeAction;
  /**
   * 去重键：同键的新通知就地替换旧的，而不是叠一条新的。
   * 落盘重试、轮询探测这类会周期性失败的路径必须带 key —— 否则 30s 一次的
   * 定时器能在几分钟内把屏幕铺满同一句话。
   */
  key?: string;
}

/** 同屏最多几条：超出丢最旧的（错误也不例外，否则一次风暴就把交互区盖死）。 */
const MAX_VISIBLE = 4;
/** 非错误通知的自动消失时延；错误/警告常驻，必须由用户确认。 */
const AUTO_DISMISS_MS = 6000;

/**
 * 全局通知面。
 *
 * 存在理由：落盘失败、后台同步失败、定时任务执行失败这些路径原本只有
 * `console.error` —— 桌面端用户看不到控制台，于是「以为已保存」是默认结局。
 * 凡是用户需要知道但当前视图无处安放的失败，都往这里推。
 *
 * 不负责：字段级校验错误、按钮的 pending 态。那些属于就地反馈，塞进全局
 * 通知只会让用户在两个地方找同一件事。
 */
export const useNoticeStore = defineStore("notice", () => {
  const list = ref<Notice[]>([]);
  /** id → 自动消失定时器；dismiss/替换时必须清掉，否则定时器打在已删除的 id 上。 */
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function clearTimer(id: string): void {
    const timer = timers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    timers.delete(id);
  }

  function dismiss(id: string): void {
    clearTimer(id);
    list.value = list.value.filter((notice) => notice.id !== id);
  }

  function clear(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    list.value = [];
  }

  function push(input: NoticeInput): string {
    const kind = input.kind ?? "info";
    const notice: Notice = {
      id: nextNoticeId(),
      kind,
      title: input.title,
      detail: input.detail,
      action: input.action,
      key: input.key,
      createdAt: Date.now(),
    };

    let next = list.value;
    if (input.key) {
      for (const existing of next) if (existing.key === input.key) clearTimer(existing.id);
      next = next.filter((existing) => existing.key !== input.key);
    }
    next = [...next, notice];
    while (next.length > MAX_VISIBLE) {
      const dropped = next.shift();
      if (dropped) clearTimer(dropped.id);
    }
    list.value = next;

    if (kind === "success" || kind === "info") {
      timers.set(
        notice.id,
        setTimeout(() => dismiss(notice.id), AUTO_DISMISS_MS),
      );
    }
    return notice.id;
  }

  const error = (title: string, detail?: string, extra?: Omit<NoticeInput, "kind" | "title" | "detail">): string =>
    push({ ...extra, kind: "error", title, detail });
  const warning = (title: string, detail?: string, extra?: Omit<NoticeInput, "kind" | "title" | "detail">): string =>
    push({ ...extra, kind: "warning", title, detail });
  const success = (title: string, detail?: string, extra?: Omit<NoticeInput, "kind" | "title" | "detail">): string =>
    push({ ...extra, kind: "success", title, detail });
  const info = (title: string, detail?: string, extra?: Omit<NoticeInput, "kind" | "title" | "detail">): string =>
    push({ ...extra, kind: "info", title, detail });

  return { list, push, dismiss, clear, error, warning, success, info };
});

/**
 * store 外的推送入口。
 *
 * `stores/session.ts` 这类模块在 pinia 实例之外的模块作用域里也会跑（首帧加载、
 * 落盘 hydrate 的 promise 链），`useNoticeStore()` 在那里可能拿不到 active pinia。
 * 这个函数吞掉「没有 active pinia」的情况：通知面不可用不该反过来炸掉调用方。
 */
export function notify(input: NoticeInput): void {
  try {
    useNoticeStore().push(input);
  } catch {
    // 无 active pinia（模块初始化期 / 纯单测）：通知无处可去，静默放弃。
  }
}
